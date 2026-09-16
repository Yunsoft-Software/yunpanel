import { requirePanelRouteAccess } from './panel-http-guard.js';

const ADD_FIELDS = new Set(['label', 'publicKey']);
const REVOKE_FIELDS = new Set(['expectedRevision']);
const ROTATE_FIELDS = new Set(['expectedRevision', 'label', 'publicKey']);

export class WebsiteSftpKeyHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteSftpKeyHttpError';
    this.code = code;
    this.status = status;
  }
}

function exactBody(value, fields, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size
    || Object.keys(value).some((field) => !fields.has(field))) {
    throw new WebsiteSftpKeyHttpError(code, message);
  }
  return value;
}

function emptyBody(value) {
  if (value === undefined || (value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 0)) return;
  throw new WebsiteSftpKeyHttpError(
    'sftp_key_reconcile_input_invalid',
    'SFTP key reconciliation does not accept request fields',
  );
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountWebsiteSftpKeyRoutes(app, { sftpKeyService } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('Express application is required');
  }
  if (!sftpKeyService
    || typeof sftpKeyService.list !== 'function'
    || typeof sftpKeyService.add !== 'function'
    || typeof sftpKeyService.revoke !== 'function'
    || typeof sftpKeyService.rotate !== 'function'
    || typeof sftpKeyService.reconcile !== 'function') {
    throw new Error('Website SFTP key service is required');
  }

  app.get('/api/websites/:websiteId/sftp/keys', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const result = await sftpKeyService.list(request.params.websiteId);
    return response.json({ data: result });
  }));

  app.post('/api/websites/:websiteId/sftp/keys', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = exactBody(
      request.body,
      ADD_FIELDS,
      'sftp_key_add_input_invalid',
      'Send exactly label and publicKey to add an SFTP key',
    );
    const result = await sftpKeyService.add({ websiteId: request.params.websiteId, ...body });
    return response.status(201).json({ data: result });
  }));

  app.post('/api/websites/:websiteId/sftp/keys/:keyId/revoke', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = exactBody(
      request.body,
      REVOKE_FIELDS,
      'sftp_key_revoke_input_invalid',
      'Send exactly expectedRevision to revoke an SFTP key',
    );
    const result = await sftpKeyService.revoke({
      websiteId: request.params.websiteId,
      keyId: request.params.keyId,
      expectedRevision: body.expectedRevision,
    });
    return response.json({ data: result });
  }));

  app.post('/api/websites/:websiteId/sftp/keys/:keyId/rotate', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = exactBody(
      request.body,
      ROTATE_FIELDS,
      'sftp_key_rotate_input_invalid',
      'Send exactly expectedRevision, label and publicKey to rotate an SFTP key',
    );
    const result = await sftpKeyService.rotate({
      websiteId: request.params.websiteId,
      keyId: request.params.keyId,
      ...body,
    });
    return response.json({ data: result });
  }));

  app.post('/api/websites/:websiteId/sftp/keys/reconcile', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyBody(request.body);
    const result = await sftpKeyService.reconcile(request.params.websiteId);
    return response.json({ data: result });
  }));
}

export const websiteSftpKeyHttpInternals = Object.freeze({
  exactBody,
  emptyBody,
});
