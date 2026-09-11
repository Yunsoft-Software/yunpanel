import { createHash } from 'node:crypto';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import { WebsiteRegistryError } from './website-registry.js';

const CREATE_FIELDS = new Set(['serverId', 'name', 'applicationId', 'dockerWorkloadId', 'runtimeType', 'proxyTarget']);
const UPDATE_CHANGE_FIELDS = new Set(['name', 'applicationId', 'dockerWorkloadId', 'runtimeType', 'proxyTarget']);
const APPLY_FIELDS = new Set(['revision', 'changes', 'previewDigest', 'confirmation']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function assertCreateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !CREATE_FIELDS.has(key))) {
    throw new WebsiteRegistryError('invalid_website_input', 'Send only documented Website fields');
  }
  return body;
}

function listFilter(query) {
  const keys = Object.keys(query ?? {});
  if (keys.some((key) => key !== 'serverId') || Array.isArray(query?.serverId)) {
    throw new WebsiteRegistryError('invalid_website_query', 'Website list accepts only one serverId filter');
  }
  return { serverId: query?.serverId || null };
}

function assertChanges(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0
    || Object.keys(value).some((key) => !UPDATE_CHANGE_FIELDS.has(key))) {
    throw new WebsiteRegistryError('invalid_website_update', 'Website changes must contain only name, applicationId, dockerWorkloadId, runtimeType or proxyTarget');
  }
  return value;
}

function assertPreviewBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'changes')) {
    throw new WebsiteRegistryError('invalid_website_update_preview', 'Send only the documented Website changes object');
  }
  return assertChanges(body.changes);
}

function assertApplyBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !APPLY_FIELDS.has(key)) || Object.keys(body).length !== APPLY_FIELDS.size) {
    throw new WebsiteRegistryError('invalid_website_update', 'Send revision, changes, previewDigest and confirmation');
  }
  if (!Number.isSafeInteger(body.revision) || body.revision < 1) {
    throw new WebsiteRegistryError('invalid_website_revision', 'A positive Website revision is required');
  }
  if (typeof body.previewDigest !== 'string' || !SHA256_PATTERN.test(body.previewDigest)) {
    throw new WebsiteRegistryError('invalid_website_update_digest', 'A current Website update preview digest is required');
  }
  if (typeof body.confirmation !== 'string') {
    throw new WebsiteRegistryError('website_update_confirmation_required', 'Exact Website update confirmation is required');
  }
  return Object.freeze({
    revision: body.revision,
    changes: assertChanges(body.changes),
    previewDigest: body.previewDigest,
    confirmation: body.confirmation,
  });
}

function domainImpact(domain) {
  return Object.freeze({
    id: domain.id,
    primaryDomain: domain.primaryDomain,
    targetType: domain.targetType,
    target: domain.target,
    httpsMode: domain.httpsMode,
    certificateId: domain.certificateId ?? null,
    desiredRevision: domain.desiredRevision,
    appliedRevision: domain.appliedRevision,
  });
}

function updatePreview(registryPlan, domains) {
  const linkedDomains = domains
    .filter((domain) => domain.websiteId === registryPlan.websiteId)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(domainImpact);
  const previewDigest = createHash('sha256').update(JSON.stringify({
    version: 1,
    registryFingerprint: registryPlan.fingerprint,
    linkedDomains,
  })).digest('hex');
  const requiresDomainRestage = linkedDomains.length > 0
    && (registryPlan.impact.bindingChanged || registryPlan.impact.proxyTargetChanged);
  const confirmation = `update:${registryPlan.websiteId}:${registryPlan.currentRevision}:${previewDigest}`;
  const result = {
    version: 1,
    websiteId: registryPlan.websiteId,
    currentRevision: registryPlan.currentRevision,
    nextWebsite: registryPlan.nextWebsite,
    impact: Object.freeze({
      ...registryPlan.impact,
      linkedDomainCount: linkedDomains.length,
      linkedDomains: Object.freeze(linkedDomains),
      requiresDomainRestage,
      domainTrafficChanged: false,
    }),
    previewDigest,
    confirmation,
  };
  Object.defineProperty(result, 'registryFingerprint', { value: registryPlan.fingerprint, enumerable: false });
  return Object.freeze(result);
}

async function currentUpdatePreview({ websiteId, changes, websiteRegistry, domainRegistry }) {
  const [registryPlan, domains] = await Promise.all([
    websiteRegistry.previewWebsiteUpdate(websiteId, changes),
    domainRegistry.listDomains(),
  ]);
  return updatePreview(registryPlan, domains);
}

async function requireLocalWebsite(websiteRegistry, websiteId, localServerId) {
  const website = await websiteRegistry.getWebsite(websiteId);
  if (!website || (localServerId && website.serverId !== localServerId)) {
    throw new WebsiteRegistryError('website_not_found', 'Website not found', 404);
  }
  return website;
}

function localListFilter(query, localServerId) {
  const filter = listFilter(query);
  if (!localServerId) return filter;
  if (filter.serverId && filter.serverId !== localServerId) {
    throw new WebsiteRegistryError('local_server_required', 'Websites can be listed only for this panel host', 404);
  }
  return { serverId: localServerId };
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountWebsiteRoutes(app, { websiteRegistry, domainRegistry, localServerId = null } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function' || typeof app.patch !== 'function') throw new Error('Express application is required');
  if (!websiteRegistry || typeof websiteRegistry.listWebsites !== 'function'
    || typeof websiteRegistry.getWebsite !== 'function' || typeof websiteRegistry.createWebsite !== 'function'
    || typeof websiteRegistry.previewWebsiteUpdate !== 'function' || typeof websiteRegistry.updateWebsite !== 'function') {
    throw new Error('Website registry is required');
  }
  if (!domainRegistry || typeof domainRegistry.listDomains !== 'function') throw new Error('Domain registry is required for Website relationships');

  app.get('/api/websites', requirePanelRouteAccess, asyncRoute(async (request, response) => (
    response.json({ data: await websiteRegistry.listWebsites(localListFilter(request.query, localServerId)) })
  )));

  app.get('/api/websites/:websiteId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const website = await requireLocalWebsite(websiteRegistry, request.params.websiteId, localServerId);
    return response.json({ data: website });
  }));

  app.get('/api/websites/:websiteId/domains', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const website = await requireLocalWebsite(websiteRegistry, request.params.websiteId, localServerId);
    const domains = (await domainRegistry.listDomains()).filter((domain) => domain.websiteId === website.id);
    return response.json({ data: domains });
  }));

  app.post('/api/websites', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = assertCreateBody(request.body);
    if (localServerId && body.serverId !== undefined && body.serverId !== localServerId) {
      throw new WebsiteRegistryError('local_server_required', 'Websites can be created only on this panel host', 404);
    }
    const website = await websiteRegistry.createWebsite({
      serverId: localServerId ?? body.serverId,
      name: body.name,
      applicationId: body.applicationId ?? null,
      dockerWorkloadId: body.dockerWorkloadId ?? null,
      runtimeType: body.runtimeType ?? null,
      proxyTarget: body.proxyTarget ?? null,
    });
    return response.status(201).json({ data: website });
  }));

  app.post('/api/websites/:websiteId/update-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const changes = assertPreviewBody(request.body);
    await requireLocalWebsite(websiteRegistry, request.params.websiteId, localServerId);
    const preview = await currentUpdatePreview({
      websiteId: request.params.websiteId,
      changes,
      websiteRegistry,
      domainRegistry,
    });
    return response.json({ data: preview });
  }));

  app.patch('/api/websites/:websiteId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const input = assertApplyBody(request.body);
    await requireLocalWebsite(websiteRegistry, request.params.websiteId, localServerId);
    const preview = await currentUpdatePreview({
      websiteId: request.params.websiteId,
      changes: input.changes,
      websiteRegistry,
      domainRegistry,
    });
    if (preview.currentRevision !== input.revision) {
      throw new WebsiteRegistryError('website_revision_conflict', 'Website changed after preview; request a new preview', 409);
    }
    if (preview.previewDigest !== input.previewDigest) {
      throw new WebsiteRegistryError('website_update_preview_stale', 'Website or linked Domain state changed after preview', 409);
    }
    if (input.confirmation !== preview.confirmation) {
      throw new WebsiteRegistryError('website_update_confirmation_required', `Confirm Website update with ${preview.confirmation}`);
    }
    const website = await websiteRegistry.updateWebsite({
      websiteId: request.params.websiteId,
      expectedRevision: input.revision,
      changes: input.changes,
      previewFingerprint: preview.registryFingerprint,
    });
    return response.json({ data: { website, impact: preview.impact } });
  }));
}

export const websiteHttpInternals = Object.freeze({
  assertCreateBody,
  assertChanges,
  assertPreviewBody,
  assertApplyBody,
  domainImpact,
  updatePreview,
  listFilter,
});
