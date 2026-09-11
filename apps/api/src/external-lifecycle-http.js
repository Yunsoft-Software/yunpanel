import { createHash } from 'node:crypto';
import { previewPostfixVirtualDomainMap } from '@yunpanel/config-templates';
import { OPERATIONS } from '@yunpanel/protocol';
import { ExternalLifecycleRegistryError } from './external-lifecycle-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const CREATE_FIELDS = new Set(['name', 'webDomainId', 'managementMode']);
const PROVIDER_CREDENTIAL_FIELDS = new Set(['provider', 'token', 'confirmation']);
const PROVIDER_CREDENTIAL_DELETE_FIELDS = new Set(['confirmation']);
const READINESS_REFRESH_FIELDS = new Set(['expectedRevision']);
const RECORD_PREVIEW_FIELDS = new Set(['action', 'record', 'expectedRevision']);
const RECORD_APPLY_FIELDS = new Set(['action', 'record', 'expectedRevision', 'previewDigest', 'confirmation']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function createInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== CREATE_FIELDS.size
    || Object.keys(body).some((key) => !CREATE_FIELDS.has(key))) {
    throw new ExternalLifecycleRegistryError('external_lifecycle_input_invalid', 'Send name, explicit webDomainId or null, and managementMode');
  }
  return body;
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new ExternalLifecycleRegistryError('external_lifecycle_query_invalid', 'Lifecycle inventory does not accept query parameters');
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

function recordInput(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size || Object.keys(body).some((field) => !fields.has(field))
    || !['upsert', 'delete'].includes(body.action)
    || !body.record || typeof body.record !== 'object' || Array.isArray(body.record)
    || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) {
    throw new ExternalLifecycleRegistryError('dns_record_input_invalid', 'DNS record operation fields are invalid');
  }
  return body;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sameRecord(left, right) {
  return left.type === right.type && left.name === right.name && left.content === right.content
    && left.ttl === right.ttl && left.proxied === right.proxied;
}

function mailConfigurationPreview(mailDomain) {
  const artifact = previewPostfixVirtualDomainMap([mailDomain.domainName]);
  const identity = Object.freeze({
    version: 1,
    operation: 'mail_configuration_preview',
    mailDomainId: mailDomain.id,
    domainName: mailDomain.domainName,
    expectedRevision: mailDomain.revision,
    managementMode: mailDomain.managementMode,
    candidateArtifactDigests: Object.freeze([{ path: artifact.path, sha256: artifact.sha256 }]),
  });
  return Object.freeze({
    ...identity,
    previewDigest: digest(identity),
    scope: 'candidate_domain_only',
    candidateArtifacts: Object.freeze([artifact]),
    readyToApply: false,
    blockers: Object.freeze([Object.freeze(mailDomain.managementMode === 'external' ? {
      code: 'mail_domain_management_mode_external',
      message: 'This mail domain is tracked as externally managed and cannot change local mail configuration.',
      action: 'Create an explicit local mail-domain identity before requesting local configuration.',
    } : {
      code: 'mail_configuration_apply_not_implemented',
      message: 'Local mail configuration apply is not implemented.',
      action: 'Keep the mail domain disabled until guarded staging, validation and rollback are available.',
    })]),
    sideEffects: false,
  });
}

export function mountExternalLifecycleRoutes(app, {
  dnsHostingRegistry,
  dnsProviderCredentialRegistry,
  dnsReadinessService,
  dnsRecordManager,
  domainRegistry,
  jobRegistry,
  localServerId,
  mailDomainRegistry,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') throw new Error('Express application is required');
  if (!dnsHostingRegistry || typeof dnsHostingRegistry.createZone !== 'function'
    || typeof dnsHostingRegistry.getZone !== 'function' || typeof dnsHostingRegistry.listZones !== 'function'
    || typeof dnsHostingRegistry.recordObservation !== 'function'
    || !dnsProviderCredentialRegistry || typeof dnsProviderCredentialRegistry.setCredential !== 'function'
    || typeof dnsProviderCredentialRegistry.getForZone !== 'function' || typeof dnsProviderCredentialRegistry.deleteForZone !== 'function'
    || typeof dnsProviderCredentialRegistry.materialize !== 'function'
    || !dnsReadinessService || typeof dnsReadinessService.inspectZone !== 'function'
    || !dnsRecordManager || typeof dnsRecordManager.inspectRecord !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !jobRegistry || typeof jobRegistry.enqueue !== 'function' || typeof jobRegistry.listJobs !== 'function'
    || !mailDomainRegistry || typeof mailDomainRegistry.createMailDomain !== 'function'
    || typeof mailDomainRegistry.getMailDomain !== 'function' || typeof mailDomainRegistry.listMailDomains !== 'function') {
    throw new Error('External lifecycle registries are required');
  }
  const zoneLocks = new Map();

  async function withZoneLock(dnsZoneId, operation) {
    const previous = zoneLocks.get(dnsZoneId) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    zoneLocks.set(dnsZoneId, current);
    await previous.catch(() => {});
    try { return await operation(); }
    finally {
      release();
      if (zoneLocks.get(dnsZoneId) === current) zoneLocks.delete(dnsZoneId);
    }
  }

  async function assertZoneIdle(dnsZoneId) {
    const jobs = await jobRegistry.listJobs({ resourceType: 'dns_zone', resourceId: dnsZoneId });
    if (jobs.some((job) => job.status === 'queued' || job.status === 'running')) {
      throw new ExternalLifecycleRegistryError('dns_zone_job_conflict', 'Wait for the active DNS zone operation', 409);
    }
  }

  async function buildRecordPreview(dnsZoneId, body) {
    const input = recordInput(body, body.previewDigest === undefined ? RECORD_PREVIEW_FIELDS : RECORD_APPLY_FIELDS);
    const zone = await dnsHostingRegistry.getZone(dnsZoneId);
    if (!zone) throw new ExternalLifecycleRegistryError('dns_zone_not_found', 'DNS zone was not found', 404);
    if (zone.revision !== input.expectedRevision) {
      throw new ExternalLifecycleRegistryError('dns_zone_revision_conflict', 'DNS zone changed after the request was prepared', 409);
    }
    if (!zone.webDomainId) {
      throw new ExternalLifecycleRegistryError('dns_zone_web_domain_required', 'DNS record management requires an explicit web Domain relationship', 409);
    }
    const domain = await domainRegistry.getDomain(zone.webDomainId);
    if (!domain || domain.primaryDomain !== zone.zoneName) {
      throw new ExternalLifecycleRegistryError('dns_zone_web_domain_mismatch', 'DNS zone web Domain relationship is unavailable', 409);
    }
    if (!localServerId || domain.serverId !== localServerId) {
      throw new ExternalLifecycleRegistryError('local_dns_zone_required', 'DNS records can be managed only for this local Server', 409);
    }
    await assertZoneIdle(zone.id);
    const credential = await dnsProviderCredentialRegistry.getForZone(zone.id);
    if (!credential?.configured || credential.provider !== 'cloudflare') {
      throw new ExternalLifecycleRegistryError('dns_provider_credential_required', 'A supported DNS provider credential is required', 409);
    }
    const materialized = await dnsProviderCredentialRegistry.materialize(credential.id);
    const snapshot = await dnsRecordManager.inspectRecord({
      provider: credential.provider,
      credentialId: credential.id,
      dnsZoneId: zone.id,
      zoneName: zone.zoneName,
      record: input.record,
    }, { dnsCredential: materialized });
    if (snapshot.records.length > 1) {
      throw new ExternalLifecycleRegistryError('dns_provider_record_ambiguous', 'DNS provider has multiple matching records', 409);
    }
    const existing = snapshot.records[0] ?? null;
    if (input.action === 'delete' && existing && !sameRecord(existing, snapshot.desired)) {
      throw new ExternalLifecycleRegistryError('dns_provider_record_mismatch', 'DNS provider record does not match the requested deletion', 409);
    }
    const effect = input.action === 'upsert'
      ? existing === null ? 'create' : sameRecord(existing, snapshot.desired) ? 'no_change' : 'update'
      : existing === null ? 'no_change' : 'delete';
    const identity = {
      version: 1,
      operation: 'dns_record_apply',
      dnsZoneId: zone.id,
      zoneName: zone.zoneName,
      expectedRevision: zone.revision,
      provider: credential.provider,
      credentialId: credential.id,
      credentialUpdatedAt: credential.updatedAt,
      action: input.action,
      record: snapshot.desired,
      currentRecords: snapshot.records,
      providerSnapshotDigest: snapshot.snapshotDigest,
      effect,
    };
    const previewDigest = digest(identity);
    return Object.freeze({
      zone,
      domain,
      credential,
      snapshot,
      preview: Object.freeze({
        ...identity,
        previewDigest,
        confirmation: `apply-dns-record:${zone.id}:${previewDigest}`,
      }),
    });
  }

  app.get('/api/dns-zones', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    return response.json({ data: await dnsHostingRegistry.listZones() });
  }));
  app.get('/api/dns-zones/:dnsZoneId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const resource = await dnsHostingRegistry.getZone(request.params.dnsZoneId);
    if (!resource) throw new ExternalLifecycleRegistryError('dns_zone_not_found', 'DNS zone was not found', 404);
    return response.json({ data: resource });
  }));
  app.post('/api/dns-zones', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = createInput(request.body);
    const resource = await dnsHostingRegistry.createZone({
      zoneName: body.name,
      webDomainId: body.webDomainId,
      managementMode: body.managementMode,
    });
    return response.status(201).json({ data: resource, sideEffects: { dnsPublished: false } });
  }));
  app.get('/api/dns-zones/:dnsZoneId/provider-credential', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    if (!(await dnsHostingRegistry.getZone(request.params.dnsZoneId))) {
      throw new ExternalLifecycleRegistryError('dns_zone_not_found', 'DNS zone was not found', 404);
    }
    return response.json({ data: await dnsProviderCredentialRegistry.getForZone(request.params.dnsZoneId) });
  }));
  app.put('/api/dns-zones/:dnsZoneId/provider-credential', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== PROVIDER_CREDENTIAL_FIELDS.size
      || Object.keys(body).some((field) => !PROVIDER_CREDENTIAL_FIELDS.has(field))) {
      throw new ExternalLifecycleRegistryError('dns_provider_credential_input_invalid', 'DNS provider credential fields are invalid');
    }
    const expected = `configure-dns-provider:${request.params.dnsZoneId}:${body.provider}`;
    if (body.confirmation !== expected) {
      throw new ExternalLifecycleRegistryError('dns_provider_credential_confirmation_required', `Confirm DNS provider credential with ${expected}`);
    }
    const credential = await withZoneLock(request.params.dnsZoneId, async () => {
      await assertZoneIdle(request.params.dnsZoneId);
      return dnsProviderCredentialRegistry.setCredential({
        dnsZoneId: request.params.dnsZoneId,
        provider: body.provider,
        token: body.token,
      });
    });
    return response.json({ data: credential });
  }));
  app.delete('/api/dns-zones/:dnsZoneId/provider-credential', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== PROVIDER_CREDENTIAL_DELETE_FIELDS.size
      || Object.keys(body).some((field) => !PROVIDER_CREDENTIAL_DELETE_FIELDS.has(field))) {
      throw new ExternalLifecycleRegistryError('dns_provider_credential_input_invalid', 'DNS provider credential delete fields are invalid');
    }
    const expected = `delete-dns-provider:${request.params.dnsZoneId}`;
    if (body.confirmation !== expected) {
      throw new ExternalLifecycleRegistryError('dns_provider_credential_confirmation_required', `Confirm DNS provider credential deletion with ${expected}`);
    }
    await withZoneLock(request.params.dnsZoneId, async () => {
      await assertZoneIdle(request.params.dnsZoneId);
      await dnsProviderCredentialRegistry.deleteForZone(request.params.dnsZoneId);
    });
    return response.status(204).end();
  }));
  app.post('/api/dns-zones/:dnsZoneId/readiness/refresh', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== READINESS_REFRESH_FIELDS.size
      || Object.keys(body).some((field) => !READINESS_REFRESH_FIELDS.has(field))
      || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) {
      throw new ExternalLifecycleRegistryError('dns_readiness_input_invalid', 'DNS readiness refresh requires one positive expectedRevision');
    }
    const result = await withZoneLock(request.params.dnsZoneId, async () => {
      await assertZoneIdle(request.params.dnsZoneId);
      const readiness = await dnsReadinessService.inspectZone(request.params.dnsZoneId);
      const zone = await dnsHostingRegistry.recordObservation(request.params.dnsZoneId, {
        expectedRevision: body.expectedRevision,
        status: readiness.routing.ready ? 'ready' : 'degraded',
        errorCode: readiness.routing.ready ? null : readiness.routing.reasonCodes[0],
      });
      return { zone, readiness };
    });
    return response.json({ data: result });
  }));
  app.post('/api/dns-zones/:dnsZoneId/records/preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const result = await withZoneLock(request.params.dnsZoneId, () => buildRecordPreview(request.params.dnsZoneId, request.body));
    return response.json({ data: result.preview });
  }));
  app.post('/api/dns-zones/:dnsZoneId/records/apply', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const apply = recordInput(request.body, RECORD_APPLY_FIELDS);
    if (!SHA256_PATTERN.test(apply.previewDigest ?? '') || typeof apply.confirmation !== 'string') {
      throw new ExternalLifecycleRegistryError('dns_record_apply_identity_invalid', 'A current DNS record preview and confirmation are required');
    }
    const queued = await withZoneLock(request.params.dnsZoneId, async () => {
      const result = await buildRecordPreview(request.params.dnsZoneId, apply);
      if (apply.previewDigest !== result.preview.previewDigest) {
        throw new ExternalLifecycleRegistryError('dns_record_preview_stale', 'DNS provider state changed after preview', 409);
      }
      if (apply.confirmation !== result.preview.confirmation) {
        throw new ExternalLifecycleRegistryError('dns_record_confirmation_required', `Confirm DNS record operation with ${result.preview.confirmation}`);
      }
      const job = await jobRegistry.enqueue({
        serverId: result.domain.serverId,
        type: 'dns.record.apply',
        operation: OPERATIONS.DNS_RECORD_APPLY,
        payload: {
          provider: result.credential.provider,
          credentialId: result.credential.id,
          dnsZoneId: result.zone.id,
          zoneName: result.zone.zoneName,
          action: apply.action,
          record: result.snapshot.desired,
          expectedSnapshotDigest: result.snapshot.snapshotDigest,
        },
        resourceType: 'dns_zone',
        resourceId: result.zone.id,
        idempotencyKey: `dns-record:${result.zone.id}:${result.preview.previewDigest}`,
      });
      return { previewDigest: result.preview.previewDigest, job };
    });
    return response.status(202).json({ data: queued });
  }));

  app.get('/api/mail-domains', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    return response.json({ data: await mailDomainRegistry.listMailDomains() });
  }));
  app.get('/api/mail-domains/:mailDomainId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const resource = await mailDomainRegistry.getMailDomain(request.params.mailDomainId);
    if (!resource) throw new ExternalLifecycleRegistryError('mail_domain_not_found', 'Mail domain was not found', 404);
    return response.json({ data: resource });
  }));
  app.get('/api/mail-domains/:mailDomainId/config-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const resource = await mailDomainRegistry.getMailDomain(request.params.mailDomainId);
    if (!resource) throw new ExternalLifecycleRegistryError('mail_domain_not_found', 'Mail domain was not found', 404);
    return response.json({ data: mailConfigurationPreview(resource) });
  }));
  app.post('/api/mail-domains', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = createInput(request.body);
    const resource = await mailDomainRegistry.createMailDomain({
      domainName: body.name,
      webDomainId: body.webDomainId,
      managementMode: body.managementMode,
    });
    return response.status(201).json({ data: resource, sideEffects: { mailConfigured: false, mailboxesCreated: false } });
  }));
}

export const externalLifecycleHttpInternals = Object.freeze({ createInput, emptyQuery, mailConfigurationPreview });
