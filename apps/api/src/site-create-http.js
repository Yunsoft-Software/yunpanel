import { requirePanelRouteAccess } from './panel-http-guard.js';
import { createSite, previewSiteCreate, SiteCreateError } from './site-create-isolation-guard.js';
import { siteCreateProvisioningPlan as dnsAwareSiteCreateProvisioningPlan } from './site-create-dns-provisioning.js';
import { siteCreateProvisioningPlan as mailAwareSiteCreateProvisioningPlan } from './site-create-mail-provisioning.js';

const PREVIEW_FIELDS = new Set(['input']);
const APPLY_FIELDS = new Set(['input', 'previewDigest', 'confirmation']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function exactBody(body, fields, code, message) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size
    || Object.keys(body).some((key) => !fields.has(key))) {
    throw new SiteCreateError(code, message);
  }
  return body;
}

function previewBody(body) {
  return exactBody(body, PREVIEW_FIELDS, 'site_create_preview_input_invalid', 'Send only the documented site-create input');
}

function applyBody(body) {
  const input = exactBody(body, APPLY_FIELDS, 'site_create_apply_input_invalid', 'Send input, previewDigest and confirmation');
  if (typeof input.previewDigest !== 'string' || !SHA256_PATTERN.test(input.previewDigest)) {
    throw new SiteCreateError('site_create_preview_digest_invalid', 'A current site-create preview digest is required');
  }
  if (typeof input.confirmation !== 'string') {
    throw new SiteCreateError('site_create_confirmation_required', 'Exact site-create confirmation is required');
  }
  return input;
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

function localInput(input, localServerId) {
  return { ...input, serverId: localServerId ?? input?.serverId };
}

function provisioningPlanner(dependencies) {
  return dependencies.localServerId
    ? dnsAwareSiteCreateProvisioningPlan
    : mailAwareSiteCreateProvisioningPlan;
}

async function previewWithProvisioning({ input, dependencies }) {
  const preview = await previewSiteCreate({ input, ...dependencies });
  const planner = provisioningPlanner(dependencies);
  return Object.freeze({
    ...preview,
    provisioning: await planner(preview, dependencies),
  });
}

async function persistProvisioning(plan, registry) {
  if (!registry) return plan;
  if (typeof registry.create !== 'function') {
    throw new SiteCreateError('site_create_dependencies_invalid', 'Website provisioning registry is unavailable', 503);
  }
  return registry.create(plan);
}

export function mountSiteCreateRoutes(app, dependencies = {}) {
  if (!app || typeof app.post !== 'function') throw new Error('Express application is required');

  app.post('/api/sites/create-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = previewBody(request.body);
    if (dependencies.localServerId && body.input?.serverId !== dependencies.localServerId) {
      throw new SiteCreateError('local_server_required', 'Sites can be created only on this panel host', 404);
    }
    const input = localInput(body.input, dependencies.localServerId);
    return response.json({ data: await previewWithProvisioning({ input, dependencies }) });
  }));

  app.post('/api/sites', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = applyBody(request.body);
    if (dependencies.localServerId && body.input?.serverId !== dependencies.localServerId) {
      throw new SiteCreateError('local_server_required', 'Sites can be created only on this panel host', 404);
    }
    const input = localInput(body.input, dependencies.localServerId);
    const result = await createSite({
      input,
      previewDigest: body.previewDigest,
      confirmation: body.confirmation,
      ...dependencies,
    });
    if (input.siteAdmin && dependencies.userAdminStore && result.website?.id) {
      try {
        await dependencies.userAdminStore.createSiteManager({
          username: input.siteAdmin.email,
          password: input.siteAdmin.password,
          websiteId: result.website.id,
          actorId: request.auth?.user?.id ?? 'system',
        });
      } catch (adminError) {
        console.error('Failed to create site manager:', adminError);
      }
    }
    const current = await previewWithProvisioning({ input, dependencies });
    const provisioning = await persistProvisioning(current.provisioning, dependencies.websiteProvisioningRegistry);
    return response.status(result.created ? 201 : 200).json({
      data: Object.freeze({
        ...result,
        provisioning,
      }),
    });
  }));
}

export const siteCreateHttpInternals = Object.freeze({
  previewBody,
  applyBody,
  localInput,
  provisioningPlanner,
  previewWithProvisioning,
  persistProvisioning,
});
