import { OPERATIONS } from '@yunpanel/protocol';
import { JobRegistryError } from './job-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const APPLY_FIELDS = new Set(['previewSha256', 'configSha256', 'fpmSha256']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MANAGED_ROUNDCUBE_MUTATIONS = new Set([OPERATIONS.ROUNDCUBE_CONFIG_APPLY]);

export class RoundcubeConfigurationHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'RoundcubeConfigurationHttpError';
    this.code = code;
    this.status = status;
  }
}

function exactBody(body, fields, code) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size
    || Object.keys(body).some((field) => !fields.has(field))) {
    throw new RoundcubeConfigurationHttpError(code, `Request must contain exactly ${[...fields].join(', ')}`);
  }
  return body;
}

function emptyBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
    throw new RoundcubeConfigurationHttpError('roundcube_configuration_prepare_input_invalid', 'Roundcube prepare request body must be an empty object');
  }
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new RoundcubeConfigurationHttpError('roundcube_configuration_query_invalid', 'Roundcube configuration does not accept query parameters');
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

function requireLocalServerId(localServerId) {
  if (typeof localServerId !== 'string' || !localServerId) {
    throw new RoundcubeConfigurationHttpError(
      'roundcube_configuration_local_server_unavailable',
      'Roundcube configuration requires the configured local server',
      503,
    );
  }
  return localServerId;
}

export async function ensureRoundcubeConfigurationIdle(jobRegistry, serverId) {
  const jobs = await jobRegistry.listJobs({ serverId });
  if (jobs.some((job) => MANAGED_ROUNDCUBE_MUTATIONS.has(job.operation)
    && (job.status === 'queued' || job.status === 'running'))) {
    throw new JobRegistryError(
      'roundcube_configuration_job_conflict',
      'Another Roundcube configuration change is already queued or running',
      409,
    );
  }
}

export function mountRoundcubeConfigurationRoutes(app, {
  roundcubeConfigurationService,
  jobRegistry,
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('Express application is required');
  }
  if (!roundcubeConfigurationService
    || typeof roundcubeConfigurationService.previewForServer !== 'function'
    || typeof roundcubeConfigurationService.prepareForServer !== 'function') {
    throw new Error('Roundcube configuration service is required');
  }
  if (!jobRegistry || typeof jobRegistry.enqueue !== 'function' || typeof jobRegistry.listJobs !== 'function') {
    throw new Error('Job registry is required');
  }

  app.get('/api/roundcube/config-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const serverId = requireLocalServerId(localServerId);
    return response.json({ data: await roundcubeConfigurationService.previewForServer(serverId) });
  }));

  app.post('/api/roundcube/config-prepare', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    emptyBody(request.body);
    const serverId = requireLocalServerId(localServerId);
    await ensureRoundcubeConfigurationIdle(jobRegistry, serverId);
    return response.json({ data: await roundcubeConfigurationService.prepareForServer(serverId) });
  }));

  app.post('/api/roundcube/config-apply', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, APPLY_FIELDS, 'roundcube_configuration_apply_input_invalid');
    if (!SHA256_PATTERN.test(body.previewSha256 ?? '')
      || !SHA256_PATTERN.test(body.configSha256 ?? '')
      || !SHA256_PATTERN.test(body.fpmSha256 ?? '')) {
      throw new RoundcubeConfigurationHttpError('roundcube_configuration_digest_invalid', 'Roundcube configuration digests are invalid');
    }
    const serverId = requireLocalServerId(localServerId);
    const preview = await roundcubeConfigurationService.previewForServer(serverId);
    if (!preview.readyToApply || !preview.configuration || !preview.fpm) {
      throw new RoundcubeConfigurationHttpError('roundcube_configuration_not_ready', 'Roundcube configuration is not ready to apply', 409);
    }
    if (preview.sha256 !== body.previewSha256
      || preview.configuration.sha256 !== body.configSha256
      || preview.fpm.sha256 !== body.fpmSha256) {
      throw new RoundcubeConfigurationHttpError('roundcube_preview_stale', 'Roundcube configuration changed after preview', 409);
    }

    await ensureRoundcubeConfigurationIdle(jobRegistry, serverId);
    const job = await jobRegistry.enqueue({
      serverId,
      type: OPERATIONS.ROUNDCUBE_CONFIG_APPLY,
      operation: OPERATIONS.ROUNDCUBE_CONFIG_APPLY,
      payload: {
        previewSha256: preview.sha256,
        configSha256: preview.configuration.sha256,
        fpmSha256: preview.fpm.sha256,
      },
      resourceType: 'server',
      resourceId: serverId,
    });
    return response.status(202).json({ data: job });
  }));
}

export const roundcubeConfigurationHttpInternals = Object.freeze({
  exactBody,
  emptyBody,
  emptyQuery,
  requireLocalServerId,
  ensureRoundcubeConfigurationIdle,
  managedRoundcubeMutations: MANAGED_ROUNDCUBE_MUTATIONS,
});
