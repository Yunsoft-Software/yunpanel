import { requirePanelRouteAccess } from './panel-http-guard.js';

const BACKUP_APPLY_FIELDS = new Set(['expectedRevision', 'expectedPreviewDigest', 'confirmation']);
const RESTORE_PREVIEW_FIELDS = new Set(['backupId']);
const RESTORE_APPLY_FIELDS = new Set([
  'backupId', 'expectedRevision', 'expectedPreviewDigest', 'confirmation',
]);
const DELETE_PREVIEW_FIELDS = new Set(['backupId']);
const DELETE_APPLY_FIELDS = new Set([
  'backupId', 'expectedRevision', 'expectedPreviewDigest', 'confirmation',
]);

export class MailDataHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDataHttpError';
    this.code = code;
    this.status = status;
  }
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new MailDataHttpError('mail_data_query_invalid', 'Mail data operation does not accept query parameters');
  }
}

function exactBody(body, fields, code) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size || Object.keys(body).some((field) => !fields.has(field))) {
    throw new MailDataHttpError(code, `Request must contain exactly ${[...fields].join(', ')}`);
  }
  return body;
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

function mountScope(app, { prefix, param, scope, service }) {
  app.get(`${prefix}/backup-preview`, requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    return response.json({ data: await service.previewBackup({
      scope,
      resourceId: request.params[param],
    }) });
  }));

  app.post(`${prefix}/backup`, requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, BACKUP_APPLY_FIELDS, 'mail_data_backup_input_invalid');
    const result = await service.queueBackup({
      scope,
      resourceId: request.params[param],
      ...body,
    });
    return response.status(202).json({ data: result });
  }));

  app.post(`${prefix}/restore-preview`, requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, RESTORE_PREVIEW_FIELDS, 'mail_data_restore_preview_input_invalid');
    return response.json({ data: await service.previewRestore({
      scope,
      resourceId: request.params[param],
      backupId: body.backupId,
    }) });
  }));

  app.post(`${prefix}/restore`, requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, RESTORE_APPLY_FIELDS, 'mail_data_restore_input_invalid');
    const result = await service.queueRestore({
      scope,
      resourceId: request.params[param],
      ...body,
    });
    return response.status(202).json({ data: result });
  }));

  app.post(`${prefix}/delete-preview`, requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, DELETE_PREVIEW_FIELDS, 'mail_data_delete_preview_input_invalid');
    return response.json({ data: await service.previewDelete({
      scope,
      resourceId: request.params[param],
      backupId: body.backupId,
    }) });
  }));

  app.post(`${prefix}/delete`, requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, DELETE_APPLY_FIELDS, 'mail_data_delete_input_invalid');
    const result = await service.queueDelete({
      scope,
      resourceId: request.params[param],
      ...body,
    });
    return response.status(202).json({ data: result });
  }));
}

export function mountMailDataRoutes(app, { mailDataOperationsService } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('Express application is required');
  }
  if (!mailDataOperationsService || typeof mailDataOperationsService.previewBackup !== 'function'
    || typeof mailDataOperationsService.queueBackup !== 'function'
    || typeof mailDataOperationsService.previewRestore !== 'function'
    || typeof mailDataOperationsService.queueRestore !== 'function'
    || typeof mailDataOperationsService.previewDelete !== 'function'
    || typeof mailDataOperationsService.queueDelete !== 'function') {
    throw new Error('Mail data operations service is required');
  }

  mountScope(app, {
    prefix: '/api/mailboxes/:mailboxId/data',
    param: 'mailboxId',
    scope: 'mailbox',
    service: mailDataOperationsService,
  });
  mountScope(app, {
    prefix: '/api/mail-domains/:mailDomainId/data',
    param: 'mailDomainId',
    scope: 'domain',
    service: mailDataOperationsService,
  });
}

export const mailDataHttpInternals = Object.freeze({
  backupApplyFields: Object.freeze([...BACKUP_APPLY_FIELDS]),
  restorePreviewFields: Object.freeze([...RESTORE_PREVIEW_FIELDS]),
  restoreApplyFields: Object.freeze([...RESTORE_APPLY_FIELDS]),
  deletePreviewFields: Object.freeze([...DELETE_PREVIEW_FIELDS]),
  deleteApplyFields: Object.freeze([...DELETE_APPLY_FIELDS]),
  emptyQuery,
  exactBody,
});