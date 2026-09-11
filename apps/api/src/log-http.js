import { createHash } from 'node:crypto';
import { OPERATIONS } from '@yunpanel/protocol';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const QUERY_FIELDS = new Set(['cursor', 'level', 'limit', 'q', 'since', 'until']);
const JOURNAL_LEVELS = Object.freeze(['emerg', 'alert', 'crit', 'error', 'warning', 'notice', 'info', 'debug']);
const JOB_LEVELS = Object.freeze(['error', 'warning', 'notice', 'info', 'debug']);
const SERVICE_UNITS = Object.freeze({
  nginx: 'nginx.service',
  mariadb: 'mariadb.service',
  mysql: 'mysql.service',
  docker: 'docker.service',
  cron: 'cron.service',
  postfix: 'postfix.service',
  dovecot: 'dovecot.service',
  rspamd: 'rspamd.service',
  'yunpanel-api': 'yunpanel-api.service',
  'yunpanel-web': 'yunpanel-web.service',
});
const DEPLOY_OPERATIONS = new Set([OPERATIONS.APP_STATIC_DEPLOY, OPERATIONS.APP_NODE_DEPLOY]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEARCH_PATTERN = /^[\p{L}\p{N} ._/@+\-]{1,100}$/u;
const DEFAULT_RANGE_MS = 24 * 60 * 60 * 1_000;
const MAX_RANGE_MS = 30 * 24 * 60 * 60 * 1_000;

export class LogHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'LogHttpError';
    this.code = code;
    this.status = status;
  }
}

function exactQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)
    || Object.keys(query).some((key) => !QUERY_FIELDS.has(key) || typeof query[key] !== 'string')) {
    throw new LogHttpError('invalid_log_query', 'Log query fields are invalid');
  }
  return query;
}

function isoTimestamp(value, fallback, field) {
  const candidate = value ?? new Date(fallback).toISOString();
  if (candidate.length !== 24 || !Number.isFinite(Date.parse(candidate)) || new Date(candidate).toISOString() !== candidate) {
    throw new LogHttpError('invalid_log_query', `${field} must be an ISO timestamp`);
  }
  return candidate;
}

export function normalizeLogQuery(query, { now = Date.now(), allowedLevels = JOURNAL_LEVELS, maxLimit = 200 } = {}) {
  const input = exactQuery(query);
  const until = isoTimestamp(input.until, now, 'until');
  const since = isoTimestamp(input.since, Date.parse(until) - DEFAULT_RANGE_MS, 'since');
  if (Date.parse(since) > Date.parse(until) || Date.parse(until) - Date.parse(since) > MAX_RANGE_MS) {
    throw new LogHttpError('invalid_log_query', 'Log time range must be ordered and at most 30 days');
  }
  const limit = input.limit === undefined ? Math.min(100, maxLimit) : Number(input.limit);
  if (!/^(?:[1-9]|[1-9][0-9]{1,2}|1000)$/.test(input.limit ?? String(limit))
    || !Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new LogHttpError('invalid_log_query', `Log limit must be between 1 and ${maxLimit}`);
  }
  const levels = input.level === undefined ? [...allowedLevels] : [...new Set(input.level.split(','))];
  if (levels.length < 1 || levels.some((level) => !allowedLevels.includes(level))) {
    throw new LogHttpError('invalid_log_query', 'Log level filter is invalid');
  }
  const search = input.q ?? null;
  if (search !== null && !SEARCH_PATTERN.test(search)) {
    throw new LogHttpError('invalid_log_query', 'Log search contains unsupported characters');
  }
  const cursor = input.cursor ?? null;
  if (cursor !== null && (cursor.length < 1 || cursor.length > 512 || /[\u0000-\u001f\u007f]/.test(cursor))) {
    throw new LogHttpError('invalid_log_query', 'Log cursor is invalid');
  }
  return { since, until, limit, levels, search, cursor };
}

function nodeUnit(applicationId) {
  if (typeof applicationId !== 'string' || !UUID_PATTERN.test(applicationId)) {
    throw new LogHttpError('application_not_found', 'Application not found', 404);
  }
  return `yunpanel-node-${createHash('sha256').update(applicationId.toLowerCase()).digest('hex').slice(0, 16)}.service`;
}

function requireLocalServer(server, localServerId) {
  if (!server) throw new LogHttpError('server_not_found', 'Server not found', 404);
  if (!localServerId) throw new LogHttpError('local_logs_unavailable', 'Local log access is not enabled', 503);
  if (server.id !== localServerId || server.executionMode !== 'local') {
    throw new LogHttpError('remote_logs_unavailable', 'Logs are available only for this panel\'s local managed server', 409);
  }
  return server;
}

function renderText(result) {
  const lines = result.entries.map((entry) => {
    const context = entry.unit ?? `${entry.source}${entry.stage ? `/${entry.stage}` : ''}`;
    return `${entry.timestamp} ${entry.level.toUpperCase()} ${context} ${entry.message.replace(/\r?\n/g, ' ↩ ')}`;
  });
  const dropped = result.page?.droppedEntries ? `# ${result.page.droppedEntries} older entries were removed by retention.\n` : '';
  return `${dropped}${lines.join('\n')}${lines.length ? '\n' : ''}`;
}

function sendResult(response, result, format, filename) {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  if (format === 'json') return response.json({ data: result });
  if (format === 'stream') {
    response.type('application/x-ndjson');
    const entries = result.entries.map((entry) => JSON.stringify({ type: 'entry', data: entry }));
    entries.push(JSON.stringify({ type: 'page', data: result.page, range: result.range }));
    return response.send(`${entries.join('\n')}\n`);
  }
  response.type('text/plain');
  response.setHeader('content-disposition', `attachment; filename="${filename}"`);
  return response.send(renderText(result));
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) {
      if (error instanceof LogHttpError) return next(error);
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
      return next(new LogHttpError(
        typeof error?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(error.code) ? error.code : 'log_backend_failed',
        status === 503 ? 'Log backend could not complete the request' : 'Log request failed',
        status,
      ));
    }
  };
}

function mountFormats(app, basePath, handler) {
  app.get(basePath, requirePanelRouteAccess, asyncRoute((request, response) => handler(request, response, 'json')));
  app.get(`${basePath}/stream`, requirePanelRouteAccess, asyncRoute((request, response) => handler(request, response, 'stream')));
  app.get(`${basePath}/download`, requirePanelRouteAccess, asyncRoute((request, response) => handler(request, response, 'download')));
}

export function mountLogRoutes(app, {
  registry, applicationRegistry, jobRegistry, journalLogReader = null, nginxLogReader = null,
  jobLogStore = null, localServerId = null, now = () => Date.now(),
} = {}) {
  if (!app || typeof app.get !== 'function' || !registry || typeof registry.getServer !== 'function'
    || !applicationRegistry || typeof applicationRegistry.getApplication !== 'function'
    || !jobRegistry || typeof jobRegistry.getJob !== 'function' || typeof now !== 'function') {
    throw new Error('Log HTTP dependencies are required');
  }

  mountFormats(app, '/api/applications/:applicationId/logs/node', async (request, response, format) => {
    if (!journalLogReader || typeof journalLogReader.query !== 'function') throw new LogHttpError('journal_logs_unavailable', 'System journal log reader is unavailable', 503);
    const application = await applicationRegistry.getApplication(request.params.applicationId);
    if (!application) throw new LogHttpError('application_not_found', 'Application not found', 404);
    if (application.type !== 'node') throw new LogHttpError('node_logs_not_supported', 'Node logs require a Node application', 409);
    requireLocalServer(await registry.getServer(application.serverId), localServerId);
    const query = normalizeLogQuery(request.query, { now: now(), allowedLevels: JOURNAL_LEVELS, maxLimit: 200 });
    const result = await journalLogReader.query({
      unit: nodeUnit(application.id), since: query.since, until: query.until,
      priorities: query.levels.map((level) => JOURNAL_LEVELS.indexOf(level)),
      search: query.search, limit: query.limit, cursor: query.cursor,
    });
    return sendResult(response, result, format, `yunpanel-node-${application.id}-logs.txt`);
  });

  mountFormats(app, '/api/servers/:serverId/logs/:serviceId', async (request, response, format) => {
    const nginxKind = request.params.serviceId === 'nginx-access' ? 'access'
      : request.params.serviceId === 'nginx-error' ? 'error'
        : null;
    const unit = SERVICE_UNITS[request.params.serviceId];
    if (!unit && !nginxKind) throw new LogHttpError('unsupported_log_service', 'Log service is not managed by YunPanel', 404);
    requireLocalServer(await registry.getServer(request.params.serverId), localServerId);
    const query = normalizeLogQuery(request.query, { now: now(), allowedLevels: JOURNAL_LEVELS, maxLimit: 200 });
    let result;
    if (nginxKind) {
      if (!nginxLogReader || typeof nginxLogReader.query !== 'function') throw new LogHttpError('nginx_logs_unavailable', 'Nginx file log reader is unavailable', 503);
      result = await nginxLogReader.query({
        kind: nginxKind, since: query.since, until: query.until, levels: query.levels,
        search: query.search, limit: query.limit, cursor: query.cursor,
      });
    } else {
      if (!journalLogReader || typeof journalLogReader.query !== 'function') throw new LogHttpError('journal_logs_unavailable', 'System journal log reader is unavailable', 503);
      result = await journalLogReader.query({
        unit, since: query.since, until: query.until,
        priorities: query.levels.map((level) => JOURNAL_LEVELS.indexOf(level)),
        search: query.search, limit: query.limit, cursor: query.cursor,
      });
    }
    return sendResult(response, result, format, `yunpanel-${request.params.serviceId}-logs.txt`);
  });

  mountFormats(app, '/api/jobs/:jobId/logs/deploy', async (request, response, format) => {
    if (!jobLogStore || typeof jobLogStore.query !== 'function') throw new LogHttpError('deploy_logs_unavailable', 'Deploy log store is unavailable', 503);
    const job = await jobRegistry.getJob(request.params.jobId);
    if (!job) throw new LogHttpError('job_not_found', 'Job not found', 404);
    if (!DEPLOY_OPERATIONS.has(job.operation)) throw new LogHttpError('deploy_logs_not_supported', 'Job is not a deployment', 409);
    requireLocalServer(await registry.getServer(job.serverId), localServerId);
    const query = normalizeLogQuery(request.query, { now: now(), allowedLevels: JOB_LEVELS, maxLimit: format === 'download' ? 1_000 : 200 });
    const result = await jobLogStore.query(job.id, query);
    return sendResult(response, result, format, `yunpanel-deploy-${job.id}-logs.txt`);
  });
}

export const logHttpInternals = Object.freeze({
  serviceUnits: SERVICE_UNITS,
  nodeUnit,
  renderText,
  requireLocalServer,
});
