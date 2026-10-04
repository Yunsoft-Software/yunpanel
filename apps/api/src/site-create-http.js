import { AuthError } from './auth-error.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import { createSite, previewSiteCreate, SiteCreateError } from './site-create-isolation-guard.js';
import { siteCreateProvisioningPlan as dnsAwareSiteCreateProvisioningPlan } from './site-create-dns-provisioning.js';
import { siteCreateProvisioningPlan as mailAwareSiteCreateProvisioningPlan } from './site-create-mail-provisioning.js';
import { provisionSiteAdmin } from './site-admin-provisioning.js';
import { createHostingSiteCreateRuntime } from './hosting-site-create-runtime.js';

const PREVIEW_FIELDS = new Set(['input']);
const APPLY_FIELDS = new Set(['input', 'previewDigest', 'confirmation']);
const HOSTED_PREVIEW_FIELDS = new Set(['customerId', 'input']);
const HOSTED_APPLY_FIELDS = new Set(['customerId', 'input', 'previewDigest', 'confirmation']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function exactBody(body, fields, code, message) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size
    || Object.keys(body).some((key) => !fields.has(key))) {
    throw new SiteCreateError(code, message);
  }
  return body;
}

function isHostedRequest(body) {
  return Boolean(body && typeof body === 'object' && !Array.isArray(body) && 'customerId' in body);
}

function previewBody(body) {
  return exactBody(body, PREVIEW_FIELDS, 'site_create_preview_input_invalid', 'Send only the documented site-create input');
}

function hostedPreviewBody(body) {
  const result = exactBody(body, HOSTED_PREVIEW_FIELDS, 'invalid_hosting_site_request', 'Use an explicit customer and the current hosted-site preview.');
  if (typeof result.customerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(result.customerId)) {
    throw new SiteCreateError('invalid_hosting_site_request', 'Use an explicit customer and the current hosted-site preview.');
  }
  return result;
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

function hostedApplyBody(body) {
  const input = exactBody(body, HOSTED_APPLY_FIELDS, 'invalid_hosting_site_request', 'Use an explicit customer and the current hosted-site preview.');
  if (typeof input.customerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.customerId)) {
    throw new SiteCreateError('invalid_hosting_site_request', 'Use an explicit customer and the current hosted-site preview.');
  }
  if (typeof input.previewDigest !== 'string' || !SHA256_PATTERN.test(input.previewDigest)) {
    throw new SiteCreateError('hosting_site_preview_stale', 'Confirm the current site plan for this customer before creating it.', 409);
  }
  if (typeof input.confirmation !== 'string') {
    throw new SiteCreateError('site_create_confirmation_required', 'Exact site-create confirmation is required');
  }
  return input;
}

function recoverReservationBody(body) {
  const input = exactBody(body, HOSTED_APPLY_FIELDS, 'invalid_hosting_site_request', 'Use an explicit customer and the current hosted-site preview.');
  if (typeof input.customerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.customerId)) {
    throw new SiteCreateError('invalid_hosting_site_request', 'Use an explicit customer and the current hosted-site preview.');
  }
  if (typeof input.previewDigest !== 'string' || !SHA256_PATTERN.test(input.previewDigest)) {
    throw new SiteCreateError('invalid_hosting_site_request', 'Use an explicit customer and the current hosted-site preview.');
  }
  if (typeof input.confirmation !== 'string') {
    throw new SiteCreateError('invalid_hosting_site_request', 'Use an explicit customer and the current hosted-site preview.');
  }
  return input;
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

function extractRawToken(request) {
  if (typeof request.rawToken === 'string' && request.rawToken.length > 0) return request.rawToken;
  if (typeof request.auth?.rawToken === 'string' && request.auth.rawToken.length > 0) return request.auth.rawToken;
  if (typeof request.auth?.token === 'string' && request.auth.token.length > 0) return request.auth.token;
  const cookieHeader = request.headers?.cookie ?? '';
  const entries = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('yunpanel_session=') || part.startsWith('__Host-yunpanel_session='));
  if (entries.length > 0) {
    const entry = entries[0];
    const eqIdx = entry.indexOf('=');
    return entry.slice(eqIdx + 1);
  }
  return '';
}

function resolveRequireManagement(dependencies, request) {
  if (typeof dependencies.requireManagement === 'function') {
    return dependencies.requireManagement;
  }
  if (typeof dependencies.ownerPolicy?.requireManagement === 'function') {
    const ownerRequire = dependencies.ownerPolicy.requireManagement;
    return (session) => {
      if (session?.user?.role === 'owner') {
        return ownerRequire(session);
      }
      if (session?.user?.role === 'reseller' || session?.user?.hosting?.kind === 'reseller') {
        if (session.user.active === false) {
          throw new AuthError('tenant_actor_inactive', 'Inactive reseller cannot perform account operations.', 403);
        }
        return session;
      }
      return ownerRequire(session);
    };
  }
  return (session) => {
    if (!session || (session.user?.role !== 'owner' && session.user?.role !== 'reseller' && session.user?.hosting?.kind !== 'reseller')) {
      throw new AuthError('forbidden', 'Owner access is required.', 403);
    }
    return session;
  };
}

function resolveHostingRuntime(dependencies) {
  if (dependencies.hostingSiteCreateRuntime) return dependencies.hostingSiteCreateRuntime;
  if (dependencies.userAdminStore?.hostingAccounts) {
    return createHostingSiteCreateRuntime(dependencies);
  }
  return null;
}

function localInput(input, localServerId) {
  return { ...input, serverId: localServerId ?? input?.serverId };
}

function provisioningPlanner(dependencies) {
  if (typeof dependencies.provisioningPlanner === 'function') {
    return dependencies.provisioningPlanner;
  }
  return dependencies.localServerId
    ? dnsAwareSiteCreateProvisioningPlan
    : mailAwareSiteCreateProvisioningPlan;
}

async function previewWithProvisioning({ input, dependencies }) {
  const previewFn = dependencies?.previewSiteCreate ?? previewSiteCreate;
  const arg = input && typeof input === 'object'
    ? Object.assign(Object.create(input), { input, ...dependencies })
    : { input, ...dependencies };
  const preview = await previewFn(arg);
  const planner = provisioningPlanner(dependencies);
  return Object.freeze({
    ...preview,
    provisioning: await planner(preview, dependencies),
  });
}

async function previewHostedWithProvisioning({ hostingRuntime, rawToken, policy, value, dependencies }) {
  const preview = await hostingRuntime.preview(rawToken, policy, value);
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
    if (isHostedRequest(request.body)) {
      const body = hostedPreviewBody(request.body);
      if (dependencies.localServerId && body.input?.serverId && body.input.serverId !== dependencies.localServerId) {
        throw new SiteCreateError('local_server_required', 'Sites can be created only on this panel host', 404);
      }
      const hostingRuntime = resolveHostingRuntime(dependencies);
      if (!hostingRuntime) {
        throw new SiteCreateError('hosting_accounts_unavailable', 'Hosting account administration is unavailable', 503);
      }
      const rawToken = extractRawToken(request);
      const policy = resolveRequireManagement(dependencies, request);
      const input = localInput(body.input, dependencies.localServerId);
      const value = { ...body, input };
      const preview = await previewHostedWithProvisioning({
        hostingRuntime, rawToken, policy, value, dependencies,
      });
      return response.json({ data: preview });
    }
    const body = previewBody(request.body);
    if (dependencies.localServerId && body.input?.serverId !== dependencies.localServerId) {
      throw new SiteCreateError('local_server_required', 'Sites can be created only on this panel host', 404);
    }
    const input = localInput(body.input, dependencies.localServerId);
    return response.json({ data: await previewWithProvisioning({ input, dependencies }) });
  }));

  app.post('/api/sites', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    if (isHostedRequest(request.body)) {
      const body = hostedApplyBody(request.body);
      if (dependencies.localServerId && body.input?.serverId && body.input.serverId !== dependencies.localServerId) {
        throw new SiteCreateError('local_server_required', 'Sites can be created only on this panel host', 404);
      }
      const hostingRuntime = resolveHostingRuntime(dependencies);
      if (!hostingRuntime) {
        throw new SiteCreateError('hosting_accounts_unavailable', 'Hosting account administration is unavailable', 503);
      }
      const rawToken = extractRawToken(request);
      const policy = resolveRequireManagement(dependencies, request);
      const input = localInput(body.input, dependencies.localServerId);
      const value = { ...body, input };
      const result = await hostingRuntime.create(rawToken, policy, value);
      let provisioning = result.provisioning ?? null;
      let provisioningError = result.provisioningError ?? null;
      if (!provisioning && !provisioningError) {
        try {
          const current = await previewWithProvisioning({ input, dependencies });
          provisioning = await persistProvisioning(current.provisioning, dependencies.websiteProvisioningRegistry);
        } catch (err) {
          provisioningError = Object.freeze({
            code: err?.code ?? 'provisioning_registration_failed',
            message: err?.message ?? 'Website provisioning registration failed.',
            status: err?.status ?? 503,
          });
        }
      }
      return response.status(result.created ? 201 : 200).json({
        data: Object.freeze({
          ...result,
          ...(provisioning ? { provisioning } : {}),
          ...(provisioningError ? { provisioningError } : {}),
        }),
      });
    }
    const body = applyBody(request.body);
    if (dependencies.localServerId && body.input?.serverId !== dependencies.localServerId) {
      throw new SiteCreateError('local_server_required', 'Sites can be created only on this panel host', 404);
    }
    const input = localInput(body.input, dependencies.localServerId);
    const createFn = dependencies.createSite ?? createSite;
    const result = await createFn({
      input,
      previewDigest: body.previewDigest,
      confirmation: body.confirmation,
      ...dependencies,
    });
    let siteAdmin = null;
    let siteAdminError = null;
    try {
      siteAdmin = await provisionSiteAdmin({
        input,
        result,
        userAdminStore: dependencies.userAdminStore,
        actorId: request.auth?.user?.id,
        operationId: result?.operationId ?? input?.operationId ?? null,
        rawToken: extractRawToken(request),
        requireManagement: resolveRequireManagement(dependencies, request),
        websiteLookup: dependencies.websiteRegistry ? (id) => dependencies.websiteRegistry.getWebsite(id) : (dependencies.websiteLookup ?? null),
      });
      if (siteAdmin?.status === 'attention') {
        siteAdminError = Object.freeze({
          code: siteAdmin.code ?? 'site_admin_result_unverified',
          message: 'Site administrator account creation requires attention.',
          status: siteAdmin.code === 'site_admin_conflict' ? 409 : 400,
        });
      }
    } catch (err) {
      siteAdmin = Object.freeze({
        status: 'attention',
        websiteId: result?.website?.id ?? null,
        code: err?.code ?? 'site_admin_result_unverified',
      });
      siteAdminError = Object.freeze({
        code: err?.code ?? 'site_admin_result_unverified',
        message: err?.message ?? 'Site administrator account creation failed.',
        status: err?.status ?? 500,
      });
    }
    let provisioning = null;
    let provisioningError = null;
    try {
      const current = await previewWithProvisioning({ input, dependencies });
      provisioning = await persistProvisioning(current.provisioning, dependencies.websiteProvisioningRegistry);
    } catch (err) {
      provisioningError = Object.freeze({
        code: err?.code ?? 'provisioning_registration_failed',
        message: err?.message ?? 'Website provisioning registration failed.',
        status: err?.status ?? 503,
      });
    }
    return response.status(result.created ? 201 : 200).json({
      data: Object.freeze({
        ...result,
        siteAdmin,
        ...(siteAdminError ? { siteAdminError } : {}),
        ...(provisioning ? { provisioning } : {}),
        ...(provisioningError ? { provisioningError } : {}),
      }),
    });
  }));

  app.post('/api/sites/hosted/create-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = hostedPreviewBody(request.body);
    if (dependencies.localServerId && body.input?.serverId && body.input.serverId !== dependencies.localServerId) {
      throw new SiteCreateError('local_server_required', 'Sites can be created only on this panel host', 404);
    }
    const hostingRuntime = resolveHostingRuntime(dependencies);
    if (!hostingRuntime) {
      throw new SiteCreateError('hosting_accounts_unavailable', 'Hosting account administration is unavailable', 503);
    }
    const rawToken = extractRawToken(request);
    const policy = resolveRequireManagement(dependencies, request);
    const input = localInput(body.input, dependencies.localServerId);
    const value = { ...body, input };
    const preview = await previewHostedWithProvisioning({
      hostingRuntime, rawToken, policy, value, dependencies,
    });
    return response.json({ data: preview });
  }));

  app.post('/api/sites/hosted', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = hostedApplyBody(request.body);
    if (dependencies.localServerId && body.input?.serverId && body.input.serverId !== dependencies.localServerId) {
      throw new SiteCreateError('local_server_required', 'Sites can be created only on this panel host', 404);
    }
    const hostingRuntime = resolveHostingRuntime(dependencies);
    if (!hostingRuntime) {
      throw new SiteCreateError('hosting_accounts_unavailable', 'Hosting account administration is unavailable', 503);
    }
    const rawToken = extractRawToken(request);
    const policy = resolveRequireManagement(dependencies, request);
    const input = localInput(body.input, dependencies.localServerId);
    const value = { ...body, input };
    const result = await hostingRuntime.create(rawToken, policy, value);
    let provisioning = result.provisioning ?? null;
    let provisioningError = result.provisioningError ?? null;
    if (!provisioning && !provisioningError) {
      try {
        const current = await previewWithProvisioning({ input, dependencies });
        provisioning = await persistProvisioning(current.provisioning, dependencies.websiteProvisioningRegistry);
      } catch (err) {
        provisioningError = Object.freeze({
          code: err?.code ?? 'provisioning_registration_failed',
          message: err?.message ?? 'Website provisioning registration failed.',
          status: err?.status ?? 503,
        });
      }
    }
    return response.status(result.created ? 201 : 200).json({
      data: Object.freeze({
        ...result,
        ...(provisioning ? { provisioning } : {}),
        ...(provisioningError ? { provisioningError } : {}),
      }),
    });
  }));

  const handleRecoverReservation = asyncRoute(async (request, response) => {
    const body = recoverReservationBody(request.body);
    if (dependencies.localServerId && body.input?.serverId && body.input.serverId !== dependencies.localServerId) {
      throw new SiteCreateError('local_server_required', 'Sites can be created only on this panel host', 404);
    }
    const hostingRuntime = resolveHostingRuntime(dependencies);
    if (!hostingRuntime) {
      throw new SiteCreateError('hosting_accounts_unavailable', 'Hosting account administration is unavailable', 503);
    }
    const rawToken = extractRawToken(request);
    const policy = resolveRequireManagement(dependencies, request);
    const input = localInput(body.input, dependencies.localServerId);
    const value = { ...body, input };
    const result = await hostingRuntime.recoverReservation(rawToken, policy, value);
    return response.status(200).json({ data: result });
  });

  app.post('/api/sites/hosted/recover-reservation', requirePanelRouteAccess, handleRecoverReservation);
  app.post('/api/sites/recover-reservation', requirePanelRouteAccess, handleRecoverReservation);
}

export { SiteCreateError };

export const siteCreateHttpInternals = Object.freeze({
  previewBody,
  applyBody,
  hostedPreviewBody,
  hostedApplyBody,
  recoverReservationBody,
  isHostedRequest,
  extractRawToken,
  resolveRequireManagement,
  resolveHostingRuntime,
  localInput,
  provisioningPlanner,
  previewWithProvisioning,
  previewHostedWithProvisioning,
  persistProvisioning,
  SiteCreateError,
});
