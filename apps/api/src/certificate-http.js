import { createHash, randomUUID } from 'node:crypto';
import { CertificateMaterialError } from './certificate-material-manager.js';
import { certificatePublicView, CertificateRegistryError, compareTlsPresentation } from './certificate-registry.js';
import { verifyCertificateRenewalOutcome, verifyRenewalOutcome } from './certificate-renewal-scheduler.js';
import { DomainRegistryError } from './domain-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BUSY_CERTIFICATE_STATES = new Set(['pending', 'validating', 'issuing', 'renewing']);
const CUSTOM_PREVIEW_FIELDS = new Set(['certificatePem', 'chainPem', 'privateKeyPem']);
const CUSTOM_APPLY_FIELDS = new Set(['certificatePem', 'chainPem', 'privateKeyPem', 'previewDigest', 'confirmation']);
const SELECT_APPLY_FIELDS = new Set(['previewDigest', 'confirmation']);

function exactBody(body, fields, code, message) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size || Object.keys(body).some((key) => !fields.has(key))) {
    throw new CertificateRegistryError(code, message);
  }
  return body;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function publicCertificate(certificate) {
  return certificatePublicView(certificate);
}

function assertApplyIdentity(body, fields, code, message) {
  const input = exactBody(body, fields, code, message);
  if (typeof input.previewDigest !== 'string' || !SHA256_PATTERN.test(input.previewDigest)) {
    throw new CertificateRegistryError('invalid_certificate_preview_digest', 'A current certificate preview digest is required');
  }
  if (typeof input.confirmation !== 'string') {
    throw new CertificateRegistryError('certificate_confirmation_required', 'Exact certificate confirmation is required');
  }
  return input;
}

async function requireLocalDomain(domainRegistry, domainId, localServerId) {
  const domain = await domainRegistry.getDomain(domainId);
  if (!domain) throw new DomainRegistryError('domain_not_found', 'Domain not found', 404);
  if (typeof localServerId !== 'string' || !localServerId || domain.serverId !== localServerId) {
    throw new CertificateRegistryError('local_certificate_required', 'Certificate material can be selected only for this local Server', 409);
  }
  if (domain.httpsMode !== 'managed') {
    throw new CertificateRegistryError('https_not_managed', 'Domain must use managed HTTPS before selecting a certificate', 409);
  }
  return domain;
}

async function assertCertificateIdle({ domain, certificateId = null, jobRegistry, certificateRegistry }) {
  const [domainJobs, certificates] = await Promise.all([
    jobRegistry.listJobs({ resourceType: 'domain', resourceId: domain.id }),
    certificateRegistry.listCertificates(),
  ]);
  if (domainJobs.some((job) => job.status === 'queued' || job.status === 'running')
    || certificates.some((certificate) => certificate.domainId === domain.id
      && BUSY_CERTIFICATE_STATES.has(certificate.state))
    || (certificateId && certificates.some((certificate) => certificate.id === certificateId
      && BUSY_CERTIFICATE_STATES.has(certificate.state)))) {
    throw new CertificateRegistryError('certificate_operation_conflict', 'Wait for active Domain and certificate operations before selecting certificate material', 409);
  }
  return certificates;
}

function customInput(body, fields) {
  const input = exactBody(body, fields, 'invalid_custom_certificate_request', 'Custom certificate request fields are invalid');
  return {
    certificatePem: input.certificatePem,
    chainPem: input.chainPem,
    privateKeyPem: input.privateKeyPem,
  };
}

function customPreview({ domain, inspected }) {
  const previewDigest = digest({
    version: 1,
    operation: 'custom_certificate_import',
    domainId: domain.id,
    desiredRevision: domain.desiredRevision,
    currentCertificateId: domain.certificateId,
    domains: [domain.primaryDomain, ...domain.aliases],
    materialDigest: inspected.materialDigest,
  });
  return Object.freeze({
    version: 1,
    operation: 'custom_certificate_import',
    domainId: domain.id,
    previewDigest,
    confirmation: `import-custom-certificate:${domain.id}:${previewDigest}`,
    certificate: Object.freeze({
      source: 'custom',
      renewalMode: 'manual',
      domains: inspected.domains,
      subject: inspected.subject,
      issuer: inspected.issuer,
      subjectAltName: inspected.subjectAltName,
      validFrom: inspected.validFrom,
      validTo: inspected.validTo,
      fingerprint256: inspected.fingerprint256,
    }),
    impact: Object.freeze({
      replacesCertificateId: domain.certificateId,
      requiresStageAndActivation: true,
      automaticRenewal: false,
    }),
  });
}

async function buildCustomPreview({ request, dependencies, requireIdle = false }) {
  const { domainRegistry, certificateRegistry, certificateMaterialManager, jobRegistry, localServerId } = dependencies;
  const domain = await requireLocalDomain(domainRegistry, request.params.domainId, localServerId);
  const input = customInput(request.body, requireIdle ? CUSTOM_APPLY_FIELDS : CUSTOM_PREVIEW_FIELDS);
  const certificates = requireIdle
    ? await assertCertificateIdle({ domain, jobRegistry, certificateRegistry })
    : await certificateRegistry.listCertificates();
  const inspected = certificateMaterialManager.inspectInput({
    ...input,
    domains: [domain.primaryDomain, ...domain.aliases],
  });
  if (certificates.some((certificate) => certificate.domainId === domain.id && certificate.source === 'custom'
    && certificate.state !== 'error' && certificate.materialDigest === inspected.materialDigest)) {
    throw new CertificateRegistryError('custom_certificate_already_imported', 'This custom certificate is already registered for the Domain', 409);
  }
  return { domain, input, inspected, preview: customPreview({ domain, inspected }) };
}

function selectionPreview({ domain, certificate, inspected }) {
  const previewDigest = digest({
    version: 1,
    operation: 'certificate_select',
    domainId: domain.id,
    desiredRevision: domain.desiredRevision,
    currentCertificateId: domain.certificateId,
    certificateId: certificate.id,
    source: certificate.source,
    state: certificate.state,
    domains: [domain.primaryDomain, ...domain.aliases],
    materialDigest: inspected.materialDigest,
  });
  return Object.freeze({
    version: 1,
    operation: 'certificate_select',
    domainId: domain.id,
    certificateId: certificate.id,
    previewDigest,
    confirmation: `select-certificate:${domain.id}:${certificate.id}:${previewDigest}`,
    certificate: publicCertificate(certificate),
    impact: Object.freeze({
      replacesCertificateId: domain.certificateId,
      requiresStageAndActivation: true,
      automaticRenewal: certificate.renewalMode === 'automatic',
    }),
  });
}

async function buildSelectionPreview({ request, dependencies, requireIdle = false }) {
  const { domainRegistry, certificateRegistry, certificateMaterialManager, jobRegistry, localServerId } = dependencies;
  const domain = await requireLocalDomain(domainRegistry, request.params.domainId, localServerId);
  if (domain.certificateId === request.params.certificateId) {
    throw new CertificateRegistryError('certificate_already_selected', 'Certificate is already selected for this Domain', 409);
  }
  if (requireIdle) await assertCertificateIdle({
    domain, certificateId: request.params.certificateId, jobRegistry, certificateRegistry,
  });
  const certificate = await certificateRegistry.getCertificate(request.params.certificateId);
  if (!certificate || certificate.domainId !== domain.id || certificate.serverId !== domain.serverId
    || certificate.staging || !['active', 'superseded'].includes(certificate.state)) {
    throw new CertificateRegistryError('certificate_not_selectable', 'Certificate is not selectable for this Domain', 409);
  }
  const inspected = await certificateMaterialManager.inspectStored({
    certificate,
    domains: [domain.primaryDomain, ...domain.aliases],
  });
  if (inspected.fingerprint256 !== certificate.fingerprint256) {
    throw new CertificateMaterialError('certificate_metadata_mismatch', 'Stored certificate metadata does not match its material', 409);
  }
  return { domain, certificate, inspected, preview: selectionPreview({ domain, certificate, inspected }) };
}

const FINGERPRINT_PATTERN = /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/i;

function renewalMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('SSL renewal metadata requires an object'), { code: 'ssl_renewal_unverified' });
  }
  if (typeof value.fingerprint256 !== 'string' || !FINGERPRINT_PATTERN.test(value.fingerprint256)) {
    throw Object.assign(new Error('Invalid certificate fingerprint'), { code: 'ssl_renewal_unverified' });
  }
  const validFrom = typeof value.validFrom === 'string' && Number.isFinite(Date.parse(value.validFrom))
    ? new Date(value.validFrom).toISOString()
    : null;
  const validTo = typeof value.validTo === 'string' && Number.isFinite(Date.parse(value.validTo))
    ? new Date(value.validTo).toISOString()
    : null;
  if (!validFrom || !validTo || Date.parse(validTo) <= Date.parse(validFrom)) {
    throw Object.assign(new Error('Invalid certificate validity dates'), { code: 'ssl_renewal_unverified' });
  }
  return Object.freeze({
    validFrom,
    validTo,
    fingerprint256: value.fingerprint256.toUpperCase(),
  });
}

function renewalOutcome(job, before, certificate, dryRun = false) {
  if (!job) {
    return 'idle';
  }
  const jobStatus = job?.status;
  if (jobStatus === 'queued' || jobStatus === 'running') {
    return 'waiting';
  }
  if (jobStatus === 'cancelled') {
    return 'cancelled';
  }
  if (jobStatus === 'failed') {
    return 'failed';
  }
  if (jobStatus !== 'succeeded') {
    return 'unverified';
  }
  const isDryRun = Boolean(dryRun || job?.result?.dryRun);
  if (isDryRun) {
    return certificate?.state === 'active' ? 'tested' : 'syncing';
  }
  if (!certificate || !certificate.fingerprint256) {
    return 'syncing';
  }
  if (job?.result?.fingerprint256) {
    const jobFp = String(job.result.fingerprint256).toUpperCase();
    const certFp = String(certificate.fingerprint256).toUpperCase();
    if (certificate.state !== 'active' || jobFp !== certFp) {
      return 'syncing';
    }
    if (job.result.validTo) {
      if (!certificate.validTo || Date.parse(certificate.validTo) !== Date.parse(job.result.validTo)) {
        return 'syncing';
      }
    }
    if (job.result.validFrom) {
      if (!certificate.validFrom || Date.parse(certificate.validFrom) !== Date.parse(job.result.validFrom)) {
        return 'syncing';
      }
    }
    if (before?.fingerprint256) {
      const beforeFp = String(before.fingerprint256).toUpperCase();
      if (beforeFp === jobFp) {
        return 'unchanged';
      }
    }
    return 'renewed';
  }
  if (job?.result?.validTo) {
    if (!certificate.validTo || Date.parse(certificate.validTo) !== Date.parse(job.result.validTo)) {
      return 'syncing';
    }
  }
  if (job?.result?.validFrom) {
    if (!certificate.validFrom || Date.parse(certificate.validFrom) !== Date.parse(job.result.validFrom)) {
      return 'syncing';
    }
  }
  return certificate?.state === 'active' ? 'renewed' : 'syncing';
}

function verifyTlsPresentation({ domain, certificate, inspected = null }) {
  const hostnames = domain
    ? [domain.primaryDomain, ...(domain.aliases ?? [])].filter(Boolean)
    : (Array.isArray(certificate?.domains) ? certificate.domains : []);

  const certDomains = new Set([
    ...(Array.isArray(certificate?.domains) ? certificate.domains : certificate?.domains ? [certificate.domains] : []),
    ...(certificate?.certName ? [certificate.certName] : []),
    ...(certificate?.subjectAltName ? certificate.subjectAltName.split(',').map((s) => s.trim().replace(/^DNS:/i, '')) : []),
  ].filter(Boolean).map((d) => d.toLowerCase()));

  const domainsMatch = hostnames.length > 0
    ? hostnames.every((h) => {
        const lower = h.toLowerCase();
        if (certDomains.has(lower)) return true;
        const wildcard = `*.${lower.replace(/^[^.]+\./, '')}`;
        return certDomains.has(wildcard);
      })
    : true;

  const validFrom = certificate?.validFrom ? Date.parse(certificate.validFrom) : null;
  const validTo = certificate?.validTo ? Date.parse(certificate.validTo) : null;
  const now = Date.now();
  const isExpired = validTo !== null ? now > validTo : false;
  const isExpiringSoon = validTo !== null ? (validTo - now) <= (30 * 24 * 60 * 60 * 1000) : false;
  const notExpired = validTo !== null && !isExpired;

  const fingerprintValid = Boolean(
    certificate?.fingerprint256
    && typeof certificate.fingerprint256 === 'string'
    && certificate.fingerprint256.length > 0
  );

  let materialVerified = fingerprintValid;
  if (inspected?.fingerprint256 && certificate?.fingerprint256) {
    materialVerified = inspected.fingerprint256.toUpperCase() === certificate.fingerprint256.toUpperCase();
  }

  const allValid = domainsMatch && notExpired && fingerprintValid && materialVerified && certificate?.state !== 'error';

  let status = 'valid';
  let code = 'tls_verified';
  if (!notExpired) {
    status = 'expired';
    code = 'certificate_expired';
  } else if (!domainsMatch) {
    status = 'domain_mismatch';
    code = 'domain_mismatch';
  } else if (!materialVerified || !fingerprintValid) {
    status = 'material_invalid';
    code = 'certificate_material_mismatch';
  } else if (certificate?.state === 'error') {
    status = 'error';
    code = 'certificate_error';
  }

  return Object.freeze({
    verified: allValid,
    status,
    code,
    presentationChecks: Object.freeze({
      domainsMatch,
      notExpired,
      fingerprintValid,
      materialVerified,
      isExpiringSoon,
      healthy: allValid,
    }),
  });
}

function normalizeReloadService(name, input) {
  if (input === true || input === 'ok' || input === 'reloaded' || input === 'success') {
    return Object.freeze({
      service: name,
      ok: true,
      status: 'reloaded',
      code: 'ok',
      error: null,
    });
  }
  if (input === false || input === 'failed' || input === 'error') {
    return Object.freeze({
      service: name,
      ok: false,
      status: 'failed',
      code: 'service_reload_failed',
      error: Object.freeze({
        code: 'service_reload_failed',
        message: `Service ${name} reload failed`,
      }),
    });
  }
  if (input && typeof input === 'object') {
    const isOk = input.ok === true
      || input.success === true
      || input.status === 'reloaded'
      || input.status === 'success'
      || input.status === 'active'
      || (input.ok !== false && input.status !== 'failed' && !input.error);

    const errObj = input.error && typeof input.error === 'object' ? input.error : null;
    const errCode = errObj?.code ?? input.code ?? (isOk ? null : 'service_reload_failed');
    const errMsg = errObj?.message ?? input.message ?? (isOk ? null : `Service ${name} reload failed`);

    return Object.freeze({
      service: name,
      ok: Boolean(isOk),
      status: isOk ? 'reloaded' : (input.status ?? 'failed'),
      code: errCode ?? (isOk ? 'ok' : 'service_reload_failed'),
      error: isOk ? null : Object.freeze({
        code: errCode ?? 'service_reload_failed',
        message: errMsg ?? `Service ${name} reload failed`,
      }),
    });
  }
  return Object.freeze({
    service: name,
    ok: false,
    status: 'failed',
    code: 'service_reload_unspecified',
    error: Object.freeze({
      code: 'service_reload_unspecified',
      message: `Service ${name} reload status unspecified`,
    }),
  });
}

function checkReloadOutcome(input = {}) {
  let rawServices = input?.services ?? input?.results ?? input?.reloadResults ?? input;
  let serviceList = [];

  if (Array.isArray(rawServices)) {
    serviceList = rawServices.map((item, idx) => {
      const name = item?.service ?? item?.name ?? `service-${idx}`;
      return normalizeReloadService(name, item);
    });
  } else if (rawServices && typeof rawServices === 'object') {
    const keys = Object.keys(rawServices).filter((k) => !['status', 'outcome', 'partial', 'code', 'presentationChecks'].includes(k));
    if (keys.length > 0) {
      serviceList = keys.map((key) => normalizeReloadService(key, rawServices[key]));
    } else {
      serviceList = [normalizeReloadService('nginx', { ok: true })];
    }
  } else {
    serviceList = [normalizeReloadService('nginx', { ok: true })];
  }

  const allOk = serviceList.every((s) => s.ok);
  const anyOk = serviceList.some((s) => s.ok);
  const hasFailures = serviceList.some((s) => !s.ok);
  const partial = anyOk && hasFailures;

  let status = 'reloaded';
  let outcome = 'complete_reload';
  let code = 'reload_succeeded';

  if (partial) {
    status = 'partial';
    outcome = 'partial_reload';
    code = 'partial_reload';
  } else if (!allOk) {
    status = 'failed';
    outcome = 'reload_failed';
    code = serviceList.find((s) => !s.ok)?.code ?? 'reload_failed';
  }

  const presentationChecks = Object.freeze({
    allServicesReloaded: !partial && allOk,
    partialReload: partial,
    hasFailures,
    services: serviceList.map((s) => ({
      service: s.service,
      ok: s.ok,
      code: s.code,
      status: s.status,
    })),
  });

  return Object.freeze({
    status,
    outcome,
    partial,
    code,
    services: serviceList,
    presentationChecks,
  });
}

export function mountCertificateRoutes(app, dependencies = {}) {
  const required = ['domainRegistry', 'certificateRegistry', 'certificateMaterialManager', 'jobRegistry'];
  if (!app || typeof app.post !== 'function' || required.some((key) => !dependencies[key])) {
    throw new Error('Certificate routes require registries, material manager and job registry');
  }
  const domainLocks = new Map();

  async function withDomainLock(domainId, operation) {
    const previous = domainLocks.get(domainId) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    domainLocks.set(domainId, current);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (domainLocks.get(domainId) === current) domainLocks.delete(domainId);
    }
  }

  app.post('/api/domains/:domainId/certificates/custom-preview', requirePanelRouteAccess, async (request, response, next) => {
    try {
      const { preview } = await buildCustomPreview({ request, dependencies });
      return response.json({ data: preview });
    } catch (error) { return next(error); }
  });

  app.post('/api/domains/:domainId/certificates/custom', requirePanelRouteAccess, async (request, response, next) => {
    try {
      const apply = assertApplyIdentity(
        request.body,
        CUSTOM_APPLY_FIELDS,
        'invalid_custom_certificate_request',
        'Custom certificate apply fields are invalid',
      );
      const result = await withDomainLock(request.params.domainId, async () => {
        const { domain, input, inspected, preview } = await buildCustomPreview({ request, dependencies, requireIdle: true });
        if (apply.previewDigest !== preview.previewDigest) {
          throw new CertificateRegistryError('certificate_preview_stale', 'Certificate state changed after preview; request a new preview', 409);
        }
        if (apply.confirmation !== preview.confirmation) {
          throw new CertificateRegistryError('certificate_confirmation_required', `Confirm custom certificate import with ${preview.confirmation}`);
        }
        const certificateId = randomUUID();
        const installed = await dependencies.certificateMaterialManager.installCustom({
          certificateId,
          ...input,
          domains: [domain.primaryDomain, ...domain.aliases],
        });
        let certificate;
        try {
          certificate = await dependencies.certificateRegistry.registerCustom({
            certificateId,
            domainId: domain.id,
            serverId: domain.serverId,
            domains: installed.domains,
            certificatePath: installed.certificatePath,
            fullchainPath: installed.fullchainPath,
            privateKeyPath: installed.privateKeyPath,
            subject: installed.subject,
            issuer: installed.issuer,
            subjectAltName: installed.subjectAltName,
            validFrom: installed.validFrom,
            validTo: installed.validTo,
            fingerprint256: installed.fingerprint256,
            materialDigest: installed.materialDigest,
          });
        } catch (error) {
          await dependencies.certificateMaterialManager.removeCustom(certificateId).catch(() => {});
          throw error;
        }
        await dependencies.domainRegistry.attachCertificate(domain.id, certificate.id, { domains: certificate.domains });
        await dependencies.certificateRegistry.commitSelection(certificate.id);
        return { certificate, preview };
      });
      return response.status(201).json({
        data: { certificate: publicCertificate(result.certificate), previewDigest: result.preview.previewDigest },
      });
    } catch (error) { return next(error); }
  });

  app.post('/api/domains/:domainId/certificates/:certificateId/select-preview', requirePanelRouteAccess, async (request, response, next) => {
    try {
      exactBody(request.body, new Set(), 'invalid_certificate_selection', 'Certificate selection preview body must be empty');
      const { preview } = await buildSelectionPreview({ request, dependencies });
      return response.json({ data: preview });
    } catch (error) { return next(error); }
  });

  app.post('/api/domains/:domainId/certificates/:certificateId/select', requirePanelRouteAccess, async (request, response, next) => {
    try {
      const apply = assertApplyIdentity(
        request.body,
        SELECT_APPLY_FIELDS,
        'invalid_certificate_selection',
        'Certificate selection apply fields are invalid',
      );
      const result = await withDomainLock(request.params.domainId, async () => {
        const { domain, certificate, preview } = await buildSelectionPreview({ request, dependencies, requireIdle: true });
        if (apply.previewDigest !== preview.previewDigest) {
          throw new CertificateRegistryError('certificate_preview_stale', 'Certificate state changed after preview; request a new preview', 409);
        }
        if (apply.confirmation !== preview.confirmation) {
          throw new CertificateRegistryError('certificate_confirmation_required', `Confirm certificate selection with ${preview.confirmation}`);
        }
        await dependencies.certificateRegistry.prepareSelection(certificate.id);
        await dependencies.domainRegistry.attachCertificate(domain.id, certificate.id, { domains: certificate.domains });
        const selected = await dependencies.certificateRegistry.commitSelection(certificate.id);
        return { selected, preview };
      });
      return response.json({
        data: { certificate: publicCertificate(result.selected), previewDigest: result.preview.previewDigest },
      });
    } catch (error) { return next(error); }
  });

  app.post('/api/certificates/:certificateId/verify-tls', requirePanelRouteAccess, async (request, response, next) => {
    try {
      const certificate = await dependencies.certificateRegistry.getCertificate(request.params.certificateId);
      if (!certificate) {
        throw new CertificateRegistryError('certificate_not_found', 'Certificate not found', 404);
      }
      const liveTls = request.body?.liveTls ?? request.body;
      const result = await dependencies.certificateRegistry.verifyLiveTls(certificate.id, liveTls);
      return response.json({
        data: {
          certificateId: certificate.id,
          ...result,
        },
      });
    } catch (error) { return next(error); }
  });

  app.post('/api/domains/:domainId/certificates/:certificateId/verify-tls', requirePanelRouteAccess, async (request, response, next) => {
    try {
      const domain = await dependencies.domainRegistry.getDomain(request.params.domainId);
      if (!domain) {
        throw new DomainRegistryError('domain_not_found', 'Domain not found', 404);
      }
      const certificate = await dependencies.certificateRegistry.getCertificate(request.params.certificateId);
      if (!certificate || certificate.domainId !== domain.id) {
        throw new CertificateRegistryError('certificate_not_found', 'Certificate not found for this Domain', 404);
      }
      const liveTls = request.body?.liveTls ?? request.body;
      const result = await dependencies.certificateRegistry.verifyLiveTls(certificate.id, liveTls);
      return response.json({
        data: {
          domainId: domain.id,
          certificateId: certificate.id,
          ...result,
        },
      });
    } catch (error) { return next(error); }
  });

  app.post('/api/certificates/:certificateId/renewal-outcome', requirePanelRouteAccess, async (request, response, next) => {
    try {
      const { jobId, before = null, liveTls = null, dryRun = false } = request.body ?? {};
      if (typeof jobId !== 'string' || !jobId) {
        throw new CertificateRegistryError('job_id_required', 'Renewal job ID is required');
      }
      const result = await verifyCertificateRenewalOutcome({
        certificateId: request.params.certificateId,
        certificateRegistry: dependencies.certificateRegistry,
        jobRegistry: dependencies.jobRegistry,
        jobId,
        before,
        liveTls,
        dryRun: Boolean(dryRun),
      });
      return response.json({ data: result });
    } catch (error) { return next(error); }
  });

  app.post('/api/certificates/:certificateId/reload-outcome', requirePanelRouteAccess, async (request, response, next) => {
    try {
      const { service, status, error = null, stage = 'reload' } = request.body ?? {};
      if (typeof service !== 'string' || !service) {
        throw new CertificateRegistryError('invalid_reload_outcome_service', 'Reload outcome service is required');
      }
      if (!['succeeded', 'partial', 'failed'].includes(status)) {
        throw new CertificateRegistryError('invalid_reload_outcome_status', 'Reload outcome status must be succeeded, partial, or failed');
      }
      const updated = await dependencies.certificateRegistry.recordReloadOutcome(request.params.certificateId, {
        service,
        status,
        error,
        stage,
      });
      return response.json({ data: { certificate: publicCertificate(updated) } });
    } catch (error) { return next(error); }
  });

  if (dependencies.certificateMaterialGc) {
    app.get('/api/certificates/gc/preview', requirePanelRouteAccess, async (request, response, next) => {
      try {
        const retentionDaysRaw = request.query?.retentionDays;
        const retentionDays = retentionDaysRaw !== undefined && /^\d+$/.test(retentionDaysRaw)
          ? Number.parseInt(retentionDaysRaw, 10)
          : undefined;
        const preview = await dependencies.certificateMaterialGc.inspectGcCandidates({ retentionDays });
        return response.json({ data: preview });
      } catch (error) { return next(error); }
    });

    app.post('/api/certificates/gc/sweep', requirePanelRouteAccess, async (request, response, next) => {
      try {
        const retentionDays = typeof request.body?.retentionDays === 'number' ? request.body.retentionDays : undefined;
        const dryRun = Boolean(request.body?.dryRun);
        const result = await dependencies.certificateMaterialGc.sweep({ retentionDays, dryRun });
        return response.json({ data: result });
      } catch (error) { return next(error); }
    });
  }

  async function handleVerifyTls(request, response, next) {
    try {
      const { domainRegistry, certificateRegistry, certificateMaterialManager } = dependencies;
      const domainId = request.params.domainId;
      let certificateId = request.params.certificateId;
      let domain = null;
      if (domainId) {
        domain = await domainRegistry.getDomain(domainId).catch(() => null);
        if (!domain && !certificateId) {
          throw new DomainRegistryError('domain_not_found', 'Domain not found', 404);
        }
      }
      if (!certificateId && domain?.certificateId) {
        certificateId = domain.certificateId;
      }
      if (!certificateId) {
        return response.status(404).json({
          error: { code: 'certificate_not_found', message: 'No certificate specified or associated with domain' },
        });
      }
      const certificate = await certificateRegistry.getCertificate(certificateId).catch(() => null);
      if (!certificate) {
        return response.status(404).json({
          error: { code: 'certificate_not_found', message: 'Certificate not found' },
        });
      }
      if (!domain && certificate.domainId) {
        domain = await domainRegistry.getDomain(certificate.domainId).catch(() => null);
      }

      let inspected = null;
      if (certificateMaterialManager && typeof certificateMaterialManager.inspectStored === 'function' && certificate.certificatePath) {
        try {
          inspected = await certificateMaterialManager.inspectStored({
            certificate,
            domains: domain ? [domain.primaryDomain, ...(domain.aliases ?? [])] : certificate.domains ?? [],
          });
        } catch {
          inspected = null;
        }
      }

      let liveTls = request.body?.liveTls ?? (request.body?.fingerprint256 ? request.body : null);
      let liveComparison = null;
      if (liveTls) {
        liveComparison = compareTlsPresentation(certificate, liveTls);
      }

      const presentation = verifyTlsPresentation({ domain, certificate, inspected });
      const verified = presentation.verified && (liveComparison ? liveComparison.matches : true);
      const status = (!liveComparison || liveComparison.matches)
        ? presentation.status
        : (liveComparison.reason === 'fingerprint_mismatch' ? 'material_invalid' : 'mismatch');
      const code = (!liveComparison || liveComparison.matches)
        ? presentation.code
        : (liveComparison.reason === 'fingerprint_mismatch' ? 'certificate_material_mismatch' : 'tls_live_mismatch');

      return response.json({
        data: {
          certificateId: certificate.id,
          domainId: domain?.id ?? certificate.domainId ?? null,
          status,
          code,
          verified,
          presentationChecks: {
            ...presentation.presentationChecks,
            ...(liveComparison ? {
              liveTlsMatches: liveComparison.matches,
              liveComparison,
            } : {}),
          },
          liveComparison: liveComparison ?? undefined,
          certificate: publicCertificate(certificate),
        },
      });
    } catch (error) {
      return next(error);
    }
  }

  async function handleRenewalOutcome(request, response, next) {
    try {
      const { domainRegistry, certificateRegistry, jobRegistry } = dependencies;
      const domainId = request.params.domainId;
      const certificateId = request.params.certificateId;
      let domain = null;
      if (domainId) {
        domain = await domainRegistry.getDomain(domainId).catch(() => null);
      }
      let certId = certificateId ?? domain?.certificateId;
      let certificate = certId ? await certificateRegistry.getCertificate(certId).catch(() => null) : null;
      if (!domain && certificate?.domainId) {
        domain = await domainRegistry.getDomain(certificate.domainId).catch(() => null);
      }

      const queryJobId = request.query?.jobId ?? request.body?.jobId;
      let job = null;
      if (queryJobId) {
        job = await jobRegistry.getJob(queryJobId).catch(() => null);
      } else if (certId) {
        const jobs = await jobRegistry.listJobs({ resourceType: 'certificate', resourceId: certId }).catch(() => []);
        job = jobs.filter((j) => j.operation === 'ssl.renew').pop() ?? jobs.pop() ?? null;
      }

      const dryRun = Boolean(request.body?.dryRun ?? request.query?.dryRun ?? job?.result?.dryRun);
      const before = request.body?.before ?? null;
      const liveTls = request.body?.liveTls ?? null;
      const outcome = renewalOutcome(job, before, certificate, dryRun);

      let liveVerified = null;
      if (liveTls && certificate) {
        const liveMatch = compareTlsPresentation(certificate, liveTls);
        liveVerified = liveMatch.matches;
      }

      const jobErrorCode = job?.error?.code ?? (job?.status === 'failed' ? 'renewal_job_failed' : null);
      const jobErrorMessage = job?.error?.message ?? (job?.status === 'failed' ? 'Renewal job failed' : null);

      const presentationChecks = Object.freeze({
        terminal: ['succeeded', 'failed', 'cancelled'].includes(job?.status),
        synced: outcome !== 'syncing',
        renewed: outcome === 'renewed',
        unchanged: outcome === 'unchanged',
        tested: outcome === 'tested',
        waiting: outcome === 'waiting',
        failed: outcome === 'failed',
        outcome,
        ...(liveVerified !== null ? { liveTlsMatches: liveVerified } : {}),
      });

      return response.json({
        data: {
          outcome,
          status: job?.status ?? 'idle',
          code: jobErrorCode ?? (outcome === 'failed' ? 'renewal_failed' : outcome),
          error: jobErrorCode ? { code: jobErrorCode, message: jobErrorMessage } : null,
          presentationChecks,
          liveVerified: liveVerified ?? undefined,
          job: job ? { id: job.id, status: job.status, operation: job.operation } : null,
          certificate: certificate ? publicCertificate(certificate) : null,
        },
      });
    } catch (error) {
      return next(error);
    }
  }

  async function handleReloadOutcome(request, response, next) {
    try {
      const body = request.body ?? {};
      const result = checkReloadOutcome(body);
      return response.status(200).json({ data: result });
    } catch (error) {
      return next(error);
    }
  }

  const verifyTlsRoutes = [
    '/api/domains/:domainId/certificates/:certificateId/verify-tls',
    '/api/certificates/:certificateId/verify-tls',
    '/api/domains/:domainId/verify-tls',
  ];
  for (const route of verifyTlsRoutes) {
    app.get(route, requirePanelRouteAccess, handleVerifyTls);
    app.post(route, requirePanelRouteAccess, handleVerifyTls);
  }

  const renewalOutcomeRoutes = [
    '/api/domains/:domainId/certificates/:certificateId/renewal-outcome',
    '/api/certificates/:certificateId/renewal-outcome',
    '/api/domains/:domainId/certificates/renewal-outcome',
    '/api/domains/:domainId/renewal-outcome',
  ];
  for (const route of renewalOutcomeRoutes) {
    app.get(route, requirePanelRouteAccess, handleRenewalOutcome);
    app.post(route, requirePanelRouteAccess, handleRenewalOutcome);
  }

  const reloadOutcomeRoutes = [
    '/api/domains/:domainId/certificates/:certificateId/reload-outcome',
    '/api/certificates/:certificateId/reload-outcome',
    '/api/domains/:domainId/certificates/reload-outcome',
    '/api/domains/:domainId/reload-outcome',
  ];
  for (const route of reloadOutcomeRoutes) {
    app.get(route, requirePanelRouteAccess, handleReloadOutcome);
    app.post(route, requirePanelRouteAccess, handleReloadOutcome);
  }
}

export const certificateHttpInternals = Object.freeze({
  customPreview,
  selectionPreview,
  publicCertificate,
  compareTlsPresentation,
  verifyRenewalOutcome,
  renewalOutcome,
  renewalMetadata,
  verifyTlsPresentation,
  checkReloadOutcome,
  normalizeReloadService,
});
