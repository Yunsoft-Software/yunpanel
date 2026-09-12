import { JobRegistryError } from './job-registry.js';
import { ensureMailConfigurationIdle } from './mail-configuration-http.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const ROTATE_FIELDS = new Set(['expectedRevision', 'confirmation']);

export class MailSrsHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailSrsHttpError';
    this.code = code;
    this.status = status;
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new MailSrsHttpError('mail_srs_query_invalid', 'SRS configuration does not accept query parameters');
  }
}

function emptyBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
    throw new MailSrsHttpError('mail_srs_prepare_input_invalid', 'SRS prepare requires an empty JSON object');
  }
}

function rotateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== ROTATE_FIELDS.size
    || Object.keys(body).some((field) => !ROTATE_FIELDS.has(field))
    || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1
    || typeof body.confirmation !== 'string' || body.confirmation.length > 256) {
    throw new MailSrsHttpError('mail_srs_rotation_input_invalid', 'SRS rotation input is invalid');
  }
  return body;
}

function requireLocalServerId(value) {
  if (typeof value !== 'string' || !value) {
    throw new MailSrsHttpError('mail_srs_local_server_unavailable', 'Local server identity is unavailable', 503);
  }
  return value;
}

export function mountMailSrsRoutes(app, {
  mailSrsConfigurationService,
  jobRegistry,
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('Express application is required');
  }
  if (!mailSrsConfigurationService
    || typeof mailSrsConfigurationService.previewForServer !== 'function'
    || typeof mailSrsConfigurationService.prepareForServer !== 'function'
    || typeof mailSrsConfigurationService.rotateForServer !== 'function') {
    throw new Error('SRS configuration service is required');
  }
  if (!jobRegistry || typeof jobRegistry.listJobs !== 'function') {
    throw new Error('Job registry is required');
  }

  app.get('/api/mail/srs', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const serverId = requireLocalServerId(localServerId);
    return response.json({ data: await mailSrsConfigurationService.previewForServer(serverId) });
  }));

  app.post('/api/mail/srs/prepare', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    emptyBody(request.body);
    const serverId = requireLocalServerId(localServerId);
    await ensureMailConfigurationIdle(jobRegistry, serverId);
    return response.json({ data: await mailSrsConfigurationService.prepareForServer(serverId) });
  }));

  app.post('/api/mail/srs/rotate', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = rotateBody(request.body);
    const serverId = requireLocalServerId(localServerId);
    await ensureMailConfigurationIdle(jobRegistry, serverId);
    try {
      return response.json({
        data: await mailSrsConfigurationService.rotateForServer(serverId, {
          expectedRevision: body.expectedRevision,
          confirmation: body.confirmation,
        }),
      });
    } catch (error) {
      if (error?.code === 'mail_srs_secret_confirmation_invalid') {
        throw new JobRegistryError(error.code, error.message, 409);
      }
      throw error;
    }
  }));
}

export const mailSrsHttpInternals = Object.freeze({ emptyQuery, emptyBody, rotateBody, requireLocalServerId });
