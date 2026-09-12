import { OPERATIONS } from '@yunpanel/protocol';
import { ensureMailConfigurationIdle } from './mail-configuration-http.js';
import { MailDkimRegistryError } from './mail-dkim-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const CREATE_FIELDS = new Set(['expectedRevision', 'selector']);
const ROTATE_FIELDS = new Set(['expectedRevision', 'selector']);
const PREVIEW_FIELDS = new Set(['expectedKeyRevision']);
const APPLY_FIELDS = new Set([
  'expectedKeyRevision', 'previewDigest', 'configurationSha256', 'confirmation',
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class MailDkimHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDkimHttpError';
    this.code = code;
    this.status = status;
  }
}

function exactBody(body, fields, code) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size || Object.keys(body).some((field) => !fields.has(field))) {
    throw new MailDkimRegistryError(code, `Request must contain exactly ${[...fields].join(', ')}`);
  }
  return body;
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new MailDkimHttpError('mail_dkim_query_invalid', 'DKIM operation does not accept query parameters');
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

const keyGenerationSideEffects = Object.freeze({
  mailConfigurationChanged: false,
  mailDataChanged: false,
  requiresDnsPublish: true,
  requiresConfigurationApply: true,
});

async function scopedLocalMailDomain({ mailDomainRegistry, domainRegistry, mailDomainId, localServerId }) {
  const mailDomain = await mailDomainRegistry.getMailDomain(mailDomainId);
  if (!mailDomain) throw new MailDkimRegistryError('mail_domain_not_found', 'Mail domain was not found', 404);
  if (mailDomain.managementMode !== 'local') {
    throw new MailDkimRegistryError('mail_domain_not_locally_managed', 'Mail domain is not locally managed', 409);
  }
  if (!mailDomain.webDomainId) {
    throw new MailDkimHttpError(
      'mail_domain_server_unavailable',
      'Mail domain is not bound to a local web domain',
      409,
    );
  }
  const webDomain = await domainRegistry.getDomain(mailDomain.webDomainId);
  if (!webDomain || webDomain.primaryDomain !== mailDomain.domainName
    || (localServerId !== null && webDomain.serverId !== localServerId)) {
    throw new MailDkimRegistryError('mail_domain_not_found', 'Mail domain was not found', 404);
  }
  return Object.freeze({ mailDomain, webDomain });
}

export function mountMailDkimRoutes(app, {
  mailDkimRegistry,
  mailDkimConfigurationService = null,
  mailDomainRegistry,
  domainRegistry,
  jobRegistry = null,
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('Express application is required');
  }
  if (!mailDkimRegistry || typeof mailDkimRegistry.getKey !== 'function'
    || typeof mailDkimRegistry.createKey !== 'function' || typeof mailDkimRegistry.rotateKey !== 'function') {
    throw new Error('DKIM key registry is required');
  }
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function') {
    throw new Error('DKIM scope dependencies are required');
  }
  if ((mailDkimConfigurationService === null) !== (jobRegistry === null)) {
    throw new Error('DKIM configuration service and job registry must be configured together');
  }
  if (mailDkimConfigurationService !== null
    && (typeof mailDkimConfigurationService.previewApply !== 'function'
      || !jobRegistry || typeof jobRegistry.enqueue !== 'function' || typeof jobRegistry.listJobs !== 'function')) {
    throw new Error('DKIM configuration apply dependencies are invalid');
  }

  app.get('/api/mail-domains/:mailDomainId/dkim', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    await scopedLocalMailDomain({
      mailDomainRegistry,
      domainRegistry,
      mailDomainId: request.params.mailDomainId,
      localServerId,
    });
    return response.json({ data: await mailDkimRegistry.getKey(request.params.mailDomainId) });
  }));

  app.post('/api/mail-domains/:mailDomainId/dkim', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, CREATE_FIELDS, 'mail_dkim_create_input_invalid');
    await scopedLocalMailDomain({
      mailDomainRegistry,
      domainRegistry,
      mailDomainId: request.params.mailDomainId,
      localServerId,
    });
    const key = await mailDkimRegistry.createKey(request.params.mailDomainId, body);
    return response.status(201).json({ data: key, sideEffects: keyGenerationSideEffects });
  }));

  app.post('/api/mail-domains/:mailDomainId/dkim/rotate', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, ROTATE_FIELDS, 'mail_dkim_rotate_input_invalid');
    const scoped = await scopedLocalMailDomain({
      mailDomainRegistry,
      domainRegistry,
      mailDomainId: request.params.mailDomainId,
      localServerId,
    });
    if (!jobRegistry || typeof jobRegistry.listJobs !== 'function') {
      throw new MailDkimHttpError('mail_dkim_rotation_unavailable', 'DKIM rotation requires managed mail job coordination', 503);
    }
    await ensureMailConfigurationIdle(jobRegistry, scoped.webDomain.serverId);
    const key = await mailDkimRegistry.rotateKey(request.params.mailDomainId, body);
    return response.json({ data: key, sideEffects: keyGenerationSideEffects });
  }));

  if (mailDkimConfigurationService) {
    app.post('/api/mail-domains/:mailDomainId/dkim/config-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
      emptyQuery(request.query);
      const body = exactBody(request.body, PREVIEW_FIELDS, 'mail_dkim_preview_input_invalid');
      await scopedLocalMailDomain({
        mailDomainRegistry,
        domainRegistry,
        mailDomainId: request.params.mailDomainId,
        localServerId,
      });
      const preview = await mailDkimConfigurationService.previewApply({
        mailDomainId: request.params.mailDomainId,
        expectedKeyRevision: body.expectedKeyRevision,
      });
      return response.json({ data: preview });
    }));

    app.post('/api/mail-domains/:mailDomainId/dkim/config-apply', requirePanelRouteAccess, asyncRoute(async (request, response) => {
      emptyQuery(request.query);
      const body = exactBody(request.body, APPLY_FIELDS, 'mail_dkim_apply_input_invalid');
      if (!SHA256_PATTERN.test(body.previewDigest ?? '') || !SHA256_PATTERN.test(body.configurationSha256 ?? '')
        || typeof body.confirmation !== 'string' || body.confirmation.length > 256) {
        throw new MailDkimHttpError('mail_dkim_confirmation_invalid', 'Managed DKIM confirmation is invalid');
      }
      const scoped = await scopedLocalMailDomain({
        mailDomainRegistry,
        domainRegistry,
        mailDomainId: request.params.mailDomainId,
        localServerId,
      });
      const preview = await mailDkimConfigurationService.previewApply({
        mailDomainId: request.params.mailDomainId,
        expectedKeyRevision: body.expectedKeyRevision,
      });
      if (!preview.readyToApply || !preview.configuration) {
        throw new MailDkimHttpError('mail_dkim_not_ready', 'Managed DKIM configuration is not ready to apply', 409);
      }
      if (body.previewDigest !== preview.previewDigest
        || body.configurationSha256 !== preview.configuration.sha256
        || body.confirmation !== preview.confirmation) {
        throw new MailDkimHttpError('mail_dkim_preview_stale', 'Managed DKIM state changed after preview', 409);
      }
      const serverId = scoped.webDomain.serverId;
      if (typeof serverId !== 'string' || !serverId) {
        throw new MailDkimHttpError('mail_domain_server_unavailable', 'Mail domain server identity is unavailable', 409);
      }
      await ensureMailConfigurationIdle(jobRegistry, serverId);
      const job = await jobRegistry.enqueue({
        serverId,
        type: OPERATIONS.MAIL_DKIM_APPLY,
        operation: OPERATIONS.MAIL_DKIM_APPLY,
        payload: {
          mailDomainId: request.params.mailDomainId,
          expectedKeyRevision: body.expectedKeyRevision,
          previewDigest: preview.previewDigest,
          configurationSha256: preview.configuration.sha256,
        },
        resourceType: 'mail_domain',
        resourceId: request.params.mailDomainId,
      });
      return response.status(202).json({ data: job });
    }));
  }
}

export const mailDkimHttpInternals = Object.freeze({
  exactBody,
  emptyQuery,
  scopedLocalMailDomain,
  keyGenerationSideEffects,
  rotateFields: ROTATE_FIELDS,
  previewFields: PREVIEW_FIELDS,
  applyFields: APPLY_FIELDS,
});