import { createHash, randomUUID } from 'node:crypto';
import { CertificateMaterialError } from './certificate-material-manager.js';
import { certificatePublicView, CertificateRegistryError } from './certificate-registry.js';
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
}

export const certificateHttpInternals = Object.freeze({
  customPreview,
  selectionPreview,
  publicCertificate,
});
