import { requirePanelRouteAccess } from './panel-http-guard.js';

export class WebsiteCronHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteCronHttpError';
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

function exactBody(value, allowedFields, requiredFields, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebsiteCronHttpError(code, message);
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !allowedFields.has(key))) {
    throw new WebsiteCronHttpError(code, message);
  }
  if (requiredFields && [...requiredFields].some((field) => !keys.includes(field))) {
    throw new WebsiteCronHttpError(code, message);
  }
  return value;
}

const CREATE_ALLOWED = new Set(['name', 'schedule', 'command', 'enabled']);
const CREATE_REQUIRED = new Set(['name', 'schedule', 'command']);

const UPDATE_ALLOWED = new Set(['expectedRevision', 'name', 'schedule', 'command', 'enabled']);
const UPDATE_REQUIRED = new Set(['expectedRevision']);

const DELETE_ALLOWED = new Set(['expectedRevision']);
const DELETE_REQUIRED = new Set(['expectedRevision']);

function requestActor(request) {
  const auth = request?.auth;
  if (!auth || typeof auth.id !== 'string' || typeof auth.user?.id !== 'string'
    || !['owner', 'site_manager'].includes(auth.user.role)) {
    throw new WebsiteCronHttpError('cron_actor_invalid', 'Live panel actor context is required', 403);
  }
  return Object.freeze({ sessionId: auth.id, userId: auth.user.id, role: auth.user.role });
}

export function mountWebsiteCronRoutes(app, { websiteCronApplyService } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('Express application is required');
  }
  if (!websiteCronApplyService
    || typeof websiteCronApplyService.listCrons !== 'function'
    || typeof websiteCronApplyService.getCron !== 'function'
    || typeof websiteCronApplyService.createCron !== 'function'
    || typeof websiteCronApplyService.updateCron !== 'function'
    || typeof websiteCronApplyService.deleteCron !== 'function') {
    throw new Error('Website cron apply service is required');
  }

  app.get('/api/websites/:websiteId/crons', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const result = await websiteCronApplyService.listCrons(request.params.websiteId);
    return response.json({ data: result });
  }));

  app.post('/api/websites/:websiteId/crons', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = exactBody(
      request.body,
      CREATE_ALLOWED,
      CREATE_REQUIRED,
      'cron_create_input_invalid',
      'name, schedule and command are required to create a cron task',
    );
    const result = await websiteCronApplyService.createCron({
      websiteId: request.params.websiteId,
      ...body,
    }, requestActor(request));
    return response.status(201).json({ data: result });
  }));

  app.get('/api/websites/:websiteId/crons/:cronId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const result = await websiteCronApplyService.getCron(request.params.cronId);
    if (result.websiteId !== request.params.websiteId) {
      throw new WebsiteCronHttpError('cron_task_not_found', 'Cron task was not found for this website', 404);
    }
    return response.json({ data: result });
  }));

  app.patch('/api/websites/:websiteId/crons/:cronId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = exactBody(
      request.body,
      UPDATE_ALLOWED,
      UPDATE_REQUIRED,
      'cron_update_input_invalid',
      'expectedRevision is required and only name, schedule, command, enabled may be updated',
    );
    const current = await websiteCronApplyService.getCron(request.params.cronId);
    if (current.websiteId !== request.params.websiteId) {
      throw new WebsiteCronHttpError('cron_task_not_found', 'Cron task was not found for this website', 404);
    }
    const result = await websiteCronApplyService.updateCron(request.params.cronId, body, requestActor(request));
    return response.json({ data: result });
  }));

  app.delete('/api/websites/:websiteId/crons/:cronId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const rawRevision = request.body?.expectedRevision ?? (request.query?.expectedRevision ? Number.parseInt(request.query.expectedRevision, 10) : undefined);
    const body = exactBody(
      { expectedRevision: rawRevision },
      DELETE_ALLOWED,
      DELETE_REQUIRED,
      'cron_delete_input_invalid',
      'expectedRevision is required to delete a cron task',
    );
    const current = await websiteCronApplyService.getCron(request.params.cronId);
    if (current.websiteId !== request.params.websiteId) {
      throw new WebsiteCronHttpError('cron_task_not_found', 'Cron task was not found for this website', 404);
    }
    const result = await websiteCronApplyService.deleteCron(request.params.cronId, {
      expectedRevision: body.expectedRevision,
    }, requestActor(request));
    return response.json({ data: result });
  }));
}

export const websiteCronHttpInternals = Object.freeze({ requestActor });
