import { requirePanelRouteAccess } from './panel-http-guard.js';

const QUERY_FIELDS = new Set(['limit', 'q', 'queue']);
const SEARCH_PATTERN = /^[\p{L}\p{N} ._/@+\-]{1,100}$/u;
const QUEUE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export class MailQueueHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailQueueHttpError';
    this.code = code;
    this.status = status;
  }
}

function normalizeQuery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((field) => !QUERY_FIELDS.has(field) || typeof value[field] !== 'string')) {
    throw new MailQueueHttpError('invalid_mail_queue_query', 'Mail queue query fields are invalid');
  }
  const limit = value.limit === undefined ? 100 : Number(value.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || String(limit) !== (value.limit ?? '100')) {
    throw new MailQueueHttpError('invalid_mail_queue_query', 'Mail queue limit must be between 1 and 200');
  }
  const search = value.q ?? null;
  if (search !== null && !SEARCH_PATTERN.test(search)) {
    throw new MailQueueHttpError('invalid_mail_queue_query', 'Mail queue search contains unsupported characters');
  }
  const queueName = value.queue ?? null;
  if (queueName !== null && !QUEUE_NAME_PATTERN.test(queueName)) {
    throw new MailQueueHttpError('invalid_mail_queue_query', 'Mail queue name is invalid');
  }
  return Object.freeze({ limit, search, queueName });
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountMailQueueRoutes(app, {
  registry,
  mailQueueInspector,
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function'
    || !registry || typeof registry.getServer !== 'function'
    || !mailQueueInspector || typeof mailQueueInspector.query !== 'function') {
    throw new Error('Mail queue HTTP dependencies are required');
  }

  app.get('/api/servers/:serverId/mail/queue', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const server = await registry.getServer(request.params.serverId);
    if (!server) throw new MailQueueHttpError('server_not_found', 'Server not found', 404);
    if (!localServerId) {
      throw new MailQueueHttpError('local_mail_queue_unavailable', 'Local mail queue access is not enabled', 503);
    }
    if (server.id !== localServerId || server.executionMode !== 'local') {
      throw new MailQueueHttpError(
        'remote_mail_queue_unavailable',
        'Mail queue is available only for this panel\'s local managed server',
        409,
      );
    }
    const query = normalizeQuery(request.query);
    const result = await mailQueueInspector.query(query);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    return response.json({ data: result });
  }));
}

export const mailQueueHttpInternals = Object.freeze({
  queryFields: Object.freeze([...QUERY_FIELDS]),
  normalizeQuery,
});
