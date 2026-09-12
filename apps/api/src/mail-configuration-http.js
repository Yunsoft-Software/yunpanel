import { OPERATIONS } from '@yunpanel/protocol';
import { JobRegistryError } from './job-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const PREVIEW_FIELDS = new Set(['expectedRevision', 'status']);
const APPLY_FIELDS = new Set([
  'expectedRevision',
  'status',
  'previewDigest',
  'configurationSha256',
  'confirmation',
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class MailConfigurationHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailConfigurationHttpError';
    this.code = code;
    this.status = status;
  }
}

function exactBody(body, fields, code) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size
    || Object.keys(body).some((field) => !fields.has(field))) {
    throw new MailConfigurationHttpError(code, `Request must contain exactly ${[...fields].join(', ')}`);
  }
  return body;
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new MailConfigurationHttpError('mail_configuration_query_invalid', 'Managed mail configuration does not accept query parameters');
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

async function scopedMailDomain({ mailDomainRegistry, domainRegistry, mailDomainId, localServerId }) {
  const mailDomain = await mailDomainRegistry.getMailDomain(mailDomainId);
  if (!mailDomain) throw new MailConfigurationHttpError('mail_domain_not_found', 'Mail domain was not found', 404);
  if (!mailDomain.webDomainId) {
    throw new MailConfigurationHttpError('mail_domain_server_unavailable', 'Mail domain is not bound to a local web domain', 409);
  }
  const domain = await domainRegistry.getDomain(mailDomain.webDomainId);
  if (!domain || (localServerId !== null && domain.serverId !== localServerId)) {
    throw new MailConfigurationHttpError('mail_domain_not_found', 'Mail domain was not found', 404);
  }
  return Object.freeze({ mailDomain, domain });
}

async function ensureMailConfigurationIdle(jobRegistry, serverId) {
  const jobs = await jobRegistry.listJobs({ serverId });
  if (jobs.some((job) => job.operation === OPERATIONS.MAIL_CONFIG_APPLY
    && (job.status === 'queued' || job.status === 'running'))) {
    throw new JobRegistryError(
      'mail_configuration_job_conflict',
      'Another managed mail configuration change is already queued or running',
      409,
    );
  }
}

export function mountMailConfigurationRoutes(app, {
  mailConfigurationService,
  mailDomainRegistry,
  domainRegistry,
  jobRegistry,
  localServerId = null,
} = {}) {
  if (!app || typeof app.post !== 'function') throw new Error('Express application is required');
  if (!mailConfigurationService || typeof mailConfigurationService.previewTransition !== 'function') {
    throw new Error('Managed mail configuration service is required');
  }
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function') {
    throw new Error('Mail domain registry is required');
  }
  if (!domainRegistry || typeof domainRegistry.getDomain !== 'function') {
    throw new Error('Domain registry is required');
  }
  if (!jobRegistry || typeof jobRegistry.enqueue !== 'function' || typeof jobRegistry.listJobs !== 'function') {
    throw new Error('Job registry is required');
  }

  app.post('/api/mail-domains/:mailDomainId/config-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, PREVIEW_FIELDS, 'mail_configuration_preview_input_invalid');
    await scopedMailDomain({
      mailDomainRegistry,
      domainRegistry,
      mailDomainId: request.params.mailDomainId,
      localServerId,
    });
    const preview = await mailConfigurationService.previewTransition({
      mailDomainId: request.params.mailDomainId,
      expectedRevision: body.expectedRevision,
      status: body.status,
    });
    return response.json({ data: preview });
  }));

  app.post('/api/mail-domains/:mailDomainId/config-apply', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, APPLY_FIELDS, 'mail_configuration_apply_input_invalid');
    if (!SHA256_PATTERN.test(body.previewDigest ?? '') || !SHA256_PATTERN.test(body.configurationSha256 ?? '')
      || typeof body.confirmation !== 'string' || body.confirmation.length > 256) {
      throw new MailConfigurationHttpError('mail_configuration_confirmation_invalid', 'Managed mail configuration confirmation is invalid');
    }
    const scoped = await scopedMailDomain({
      mailDomainRegistry,
      domainRegistry,
      mailDomainId: request.params.mailDomainId,
      localServerId,
    });
    const preview = await mailConfigurationService.previewTransition({
      mailDomainId: request.params.mailDomainId,
      expectedRevision: body.expectedRevision,
      status: body.status,
    });
    if (!preview.readyToApply || !preview.configuration) {
      throw new MailConfigurationHttpError('mail_configuration_not_ready', 'Managed mail configuration is not ready to apply', 409);
    }
    if (body.previewDigest !== preview.previewDigest
      || body.configurationSha256 !== preview.configuration.sha256
      || body.confirmation !== preview.confirmation) {
      throw new MailConfigurationHttpError('mail_configuration_preview_stale', 'Managed mail configuration changed after preview', 409);
    }

    const serverId = scoped.domain.serverId;
    if (typeof serverId !== 'string' || !serverId) {
      throw new MailConfigurationHttpError('mail_domain_server_unavailable', 'Mail domain server identity is unavailable', 409);
    }
    await ensureMailConfigurationIdle(jobRegistry, serverId);
    const job = await jobRegistry.enqueue({
      serverId,
      type: OPERATIONS.MAIL_CONFIG_APPLY,
      operation: OPERATIONS.MAIL_CONFIG_APPLY,
      payload: {
        mailDomainId: request.params.mailDomainId,
        expectedRevision: body.expectedRevision,
        desiredStatus: body.status,
        previewDigest: preview.previewDigest,
        configurationSha256: preview.configuration.sha256,
      },
      resourceType: 'mail_domain',
      resourceId: request.params.mailDomainId,
    });
    return response.status(202).json({ data: job });
  }));
}

export const mailConfigurationHttpInternals = Object.freeze({
  exactBody,
  emptyQuery,
  scopedMailDomain,
  ensureMailConfigurationIdle,
});
