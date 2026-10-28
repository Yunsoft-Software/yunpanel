import { createHash } from 'node:crypto';
import { apiKeyActor } from './api-key-actor.js';

// One-call tenant sites for the automation API: <slug>.<key's parent Domain> proxied to
// a loopback port inside the key's range. It reuses the panel's own site-create and
// provisioning engine; a hostname the panel did not create here is never adopted.
const SLUG = /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/;
const RESERVED = new Set(['www', 'api', 'admin', 'app', 'mail', 'webmail', 'smtp', 'imap', 'pop', 'ftp', 'ns1', 'ns2', 'status',
  'control', 'panel', 'billing', 'support', 'autodiscover', 'autoconfig', 'cpanel', 'st']);
const FIELDS = new Set(['upstreamPort', 'https']);
const STATE_FIELDS = new Set(['state', 'redirectUrl']);
const MODES = new Set(['active', 'stopped', 'archived']);
const ADVANCE_LIMIT = 20;

export class TenantSiteError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'TenantSiteError';
    this.code = code;
    this.status = status;
  }
}

// Stable identity: the same parent Domain and slug always map to the same site-create operation.
function operationIdFor(hostname) {
  const hex = createHash('sha256').update(`yunpanel:tenant-site:v1:${hostname}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[parseInt(hex[16], 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function slugOf(value) {
  if (typeof value !== 'string' || !SLUG.test(value) || value.includes('--')) {
    throw new TenantSiteError('invalid_tenant_slug', 'Use 3 to 30 lowercase letters, digits and single hyphens, starting with a letter');
  }
  if (RESERVED.has(value)) throw new TenantSiteError('tenant_slug_reserved', 'This name is reserved', 409);
  return value;
}

export function createTenantSiteService({ siteCreator, provisioning, domainRegistry, store, localServerId, publication = null, jobRegistry = null, removal = null }) {
  if (!siteCreator || !provisioning?.get || !provisioning?.runNext || !domainRegistry || !store || !localServerId) {
    throw new Error('Tenant sites require the site creator, provisioning engine, Domain registry and tenant store');
  }

  async function parentOf(key) {
    const parent = (await domainRegistry.listDomains())
      .find((domain) => domain.primaryDomain === key.scope.parentDomain && domain.serverId === localServerId);
    if (!parent) throw new TenantSiteError('tenant_parent_domain_missing', `Add ${key.scope.parentDomain} to the panel first`, 409);
    return parent;
  }

  // Provisioning acts for the Owner who created the key; host jobs re-check it (api-key-actor.js).
  const actorFor = apiKeyActor;

  async function advance(record, key, limit) {
    let operation = await provisioning.get(record.operationId);
    for (let step = 0; operation && !operation.ready && step < limit; step += 1) {
      const result = await provisioning.runNext(record.operationId, actorFor(key));
      operation = result.operation;
      if (!['progressed', 'reconciled'].includes(result.outcome)) break;
    }
    return operation;
  }

  function view(record, operation) {
    const failed = operation?.steps?.some((step) => ['failed', 'blocked', 'compensated'].includes(step.state)) || Boolean(record.publication?.error);
    return Object.freeze({
      hostname: record.hostname, slug: record.slug, upstreamPort: record.upstreamPort, websiteId: record.websiteId,
      state: failed ? 'attention' : !operation?.ready ? 'provisioning' : record.publication ? 'publishing' : 'active',
      mode: record.mode ?? 'active',
      ...(record.publication?.error ? { error: record.publication.error } : {}),
      steps: (operation?.steps ?? []).map((step) => Object.freeze({ id: step.id, state: step.state })),
    });
  }

  async function ensure(key, rawSlug, body) {
    const slug = slugOf(rawSlug);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((field) => !FIELDS.has(field))) {
      throw new TenantSiteError('invalid_tenant_site', 'Send upstreamPort and optionally https');
    }
    const { upstreamPort } = body;
    if (!Number.isInteger(upstreamPort) || upstreamPort < key.scope.portMin || upstreamPort > key.scope.portMax) {
      throw new TenantSiteError('tenant_port_out_of_scope', `upstreamPort must be between ${key.scope.portMin} and ${key.scope.portMax}`);
    }
    if (body.https !== undefined && typeof body.https !== 'boolean') throw new TenantSiteError('invalid_tenant_site', 'https must be a boolean');
    const parent = await parentOf(key);
    const hostname = `${slug}.${parent.primaryDomain}`;
    let record = await store.get(hostname);
    if (record?.removal) throw new TenantSiteError('tenant_site_removing', 'This tenant site is being removed', 409);
    if (record) {
      if (record.upstreamPort !== upstreamPort) throw new TenantSiteError('tenant_port_change_unsupported', 'A tenant site keeps its port', 409);
      return { created: false, site: view(record, await advance(record, key, ADVANCE_LIMIT)) };
    }
    const operationId = operationIdFor(hostname);
    const existing = (await domainRegistry.listDomains()).find((domain) => domain.primaryDomain === hostname || domain.aliases?.includes(hostname));
    if (existing) {
      // Only our own interrupted create (same deterministic operation, same Website) is resumed.
      const interrupted = await provisioning.get(operationId);
      if (!interrupted || interrupted.websiteId !== existing.websiteId || existing.primaryDomain !== hostname) {
        throw new TenantSiteError('existing_domain_protected', 'This hostname already exists in the panel and is not a tenant site', 409);
      }
      record = await store.put({ hostname, slug, parentDomain: parent.primaryDomain, upstreamPort, operationId, websiteId: existing.websiteId,
        domainId: existing.id, createdByKey: key.id, createdAt: new Date().toISOString() });
      return { created: false, site: view(record, await advance(record, key, ADVANCE_LIMIT)) };
    }
    const input = {
      operationId, serverId: localServerId, name: `Tenant ${slug}`, primaryDomain: hostname, parentDomainId: parent.id,
      wwwMode: 'none', httpsMode: body.https === false ? 'off' : 'managed',
      source: { kind: 'external_proxy', target: { host: '127.0.0.1', port: upstreamPort, websocket: true } },
    };
    const preview = await siteCreator.preview(input);
    if (preview.blockers?.length) {
      throw new TenantSiteError('tenant_site_blocked', `Site cannot be created: ${preview.blockers.map((blocker) => blocker.code ?? blocker).join(', ')}`, 409);
    }
    const result = await siteCreator.create(input, preview.previewDigest, preview.confirmation);
    // Like POST /api/sites: the plan is taken after create, so finished metadata steps start as succeeded.
    if (!(await provisioning.get(operationId))) await siteCreator.persistProvisioning((await siteCreator.preview(input)).provisioning);
    record = await store.put({
      hostname, slug, parentDomain: parent.primaryDomain, upstreamPort, operationId, websiteId: result.website.id,
      domainId: result.primaryDomain.id, createdByKey: key.id, createdAt: new Date().toISOString(),
    });
    return { created: true, site: view(record, await advance(record, key, ADVANCE_LIMIT)) };
  }

  async function owned(key, rawSlug) {
    const record = await store.get(`${slugOf(rawSlug)}.${key.scope.parentDomain}`);
    if (!record || record.parentDomain !== key.scope.parentDomain) throw new TenantSiteError('tenant_site_not_found', 'Tenant site was not found', 404);
    return record;
  }

  // Mode changes are published like a panel save: stage job, then activate job. Each
  // status read moves the publication one step, so the caller polls until 'active'.
  async function advancePublication(record) {
    const pending = record.publication;
    if (!pending || pending.error) return record;
    const job = await jobRegistry.getJob(pending.activateJobId ?? pending.stageJobId);
    if (job?.status === 'failed' || job?.status === 'cancelled') {
      return store.put({ ...record, publication: { ...pending, error: job.error?.code ?? 'tenant_publication_failed' } });
    }
    if (job?.status !== 'succeeded') return record;
    const domain = await domainRegistry.getDomain(record.domainId);
    if (!pending.activateJobId && domain?.stagedRevision === pending.revision) {
      const activate = await publication.activate(domain);
      return store.put({ ...record, publication: { ...pending, activateJobId: activate.id } });
    }
    if (pending.activateJobId && domain?.appliedRevision === pending.revision) {
      const { publication: _done, ...rest } = record;
      return store.put(rest);
    }
    return record;
  }

  async function setMode(key, rawSlug, body) {
    if (!publication || !jobRegistry) throw new TenantSiteError('tenant_publication_unavailable', 'Publishing is not available on this panel', 503);
    let record = await owned(key, rawSlug);
    if (record.removal) throw new TenantSiteError('tenant_site_removing', 'This tenant site is being removed', 409);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((field) => !STATE_FIELDS.has(field))
      || !MODES.has(body.state) || (body.state === 'archived') !== (typeof body.redirectUrl === 'string')) {
      throw new TenantSiteError('invalid_tenant_state', 'Send state active, stopped or archived; archived needs redirectUrl');
    }
    if (!(await provisioning.get(record.operationId))?.ready) {
      throw new TenantSiteError('tenant_site_not_ready', 'The site is still being set up; change its state once it is active', 409);
    }
    record = await advancePublication(record);
    if (record.publication && !record.publication.error) throw new TenantSiteError('tenant_site_busy', 'A previous change is still being published', 409);
    const override = body.state === 'stopped' ? { mode: 'unavailable' }
      : body.state === 'archived' ? { mode: 'redirect', url: body.redirectUrl, status: 302, preservePath: false } : null;
    const domain = await domainRegistry.getDomain(record.domainId);
    if (JSON.stringify(domain.nginxSettings.serviceOverride ?? null) === JSON.stringify(override)
      && domain.appliedRevision === domain.desiredRevision && !record.publication) {
      return view(record, await provisioning.get(record.operationId));
    }
    const changes = { nginxSettings: { serviceOverride: override } };
    const preview = await domainRegistry.previewDomainUpdate({ domainId: domain.id, changes });
    const { domain: updated } = await domainRegistry.updateDomain({ domainId: domain.id, changes, previewDigest: preview.previewDigest });
    const stage = await publication.stage(updated);
    record = await store.put({ ...record, mode: body.state, publication: { revision: updated.desiredRevision, stageJobId: stage.id, activateJobId: null } });
    return view(record, await provisioning.get(record.operationId));
  }

  // Removal uses the panel's website removal engine and its background worker. The tenant
  // record stays until the engine reports 'removed', because the worker re-authorizes the
  // key actor against it at every step.
  async function removalView(record) {
    const operation = await removal.get(record.removal.operationId);
    if (operation?.status === 'removed') {
      await store.remove(record.hostname);
      return Object.freeze({ hostname: record.hostname, slug: record.slug, state: 'removed' });
    }
    const failedStep = operation?.steps?.find((step) => ['failed', 'blocked'].includes(step.state));
    const error = failedStep?.error?.code ?? operation?.error?.code ?? null;
    return Object.freeze({ hostname: record.hostname, slug: record.slug,
      state: ['failed', 'blocked'].includes(operation?.status) || failedStep ? 'attention' : 'removing',
      ...(operation?.status ? { removalStatus: operation.status } : {}), ...(error ? { error } : {}),
      ...(failedStep ? { failedStep: failedStep.id } : {}) });
  }

  async function remove(key, rawSlug) {
    if (!removal) throw new TenantSiteError('tenant_removal_unavailable', 'Site removal is not available on this panel', 503);
    const record = await owned(key, rawSlug);
    if (record.removal) return removalView(record);
    const actor = apiKeyActor(key);
    const preview = await removal.preview({ websiteId: record.websiteId });
    if (preview.readyToStart !== true || typeof preview.confirmation !== 'string') {
      const blockers = (preview.hardBlockers ?? []).map((blocker) => blocker.code ?? blocker).join(', ');
      throw new TenantSiteError('tenant_removal_blocked', `Site cannot be removed yet${blockers ? `: ${blockers}` : ''}`, 409);
    }
    const started = await removal.start({ websiteId: record.websiteId, previewDigest: preview.previewDigest, confirmation: preview.confirmation, actor });
    await store.put({ ...record, removal: { operationId: started.id } });
    await removal.run({ websiteId: record.websiteId, operationId: started.id, expectedUpdatedAt: started.updatedAt,
      confirmation: `run-website-remove:${record.websiteId}:${started.id}:${started.updatedAt}`, actor });
    return removalView({ ...record, removal: { operationId: started.id } });
  }

  async function status(key, rawSlug) {
    let record = await owned(key, rawSlug);
    if (record.removal) return removalView(record);
    const operation = await advance(record, key, 1);
    if (operation?.ready && publication && jobRegistry) record = await advancePublication(record);
    return view(record, operation);
  }

  return Object.freeze({ ensure, status, setMode, remove, owned, internals: Object.freeze({ operationIdFor }) });
}
