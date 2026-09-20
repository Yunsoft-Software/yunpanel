import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { integratedToolGateway } from '../../packages/protocol/src/tool-gateway.js';

const DEFAULT_WEB_ROOT = '/usr/share/yunpanel/web';
const PHPMYADMIN_GATEWAY = integratedToolGateway('phpmyadmin');
const PHPMYADMIN_PREFIX = PHPMYADMIN_GATEWAY.publicPrefix;
const PHPMYADMIN_GATEWAY_ACCESS_PATH = PHPMYADMIN_GATEWAY.accessPath;
const PHPMYADMIN_SOCKET_PATH = PHPMYADMIN_GATEWAY.socketPath;
const ELFINDER_GATEWAY = integratedToolGateway('elfinder');
const ELFINDER_PREFIX = ELFINDER_GATEWAY.publicPrefix;
const ELFINDER_GATEWAY_ACCESS_PATH = ELFINDER_GATEWAY.accessPath;
const ELFINDER_GATEWAY_SOCKET_PATH = ELFINDER_GATEWAY.socketPath;
const TTYD_GATEWAY = integratedToolGateway('ttyd');
const TTYD_PREFIX = TTYD_GATEWAY.publicPrefix;
const TTYD_GATEWAY_ACCESS_PATH = TTYD_GATEWAY.accessPath;
const TTYD_SOCKET_ROOT = TTYD_GATEWAY.socketRoot;
const NETDATA_GATEWAY = integratedToolGateway('netdata');
const NETDATA_PREFIX = NETDATA_GATEWAY.publicPrefix;
const NETDATA_GATEWAY_ACCESS_PATH = NETDATA_GATEWAY.accessPath;
const NETDATA_LOOPBACK_PORT = NETDATA_GATEWAY.loopbackPort;
const TTYD_AUTH_HEADER = 'x-yunpanel-ttyd-auth';
const TTYD_REAUTHORIZE_MS = 15_000;
const TTYD_SESSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ELFINDER_HANDOFF_SOCKET_PATH = '/run/yunpanel-elfinder/handoff.sock';
const ELFINDER_HANDOFF_PATH = '/__yunpanel/handoff';
const ELFINDER_SESSION_TTL_MS = 60 * 60 * 1000;
const ELFINDER_SESSION_LIMIT = 100;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const APP_USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'], ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'], ['.svg', 'image/svg+xml'], ['.webp', 'image/webp'],
]);
const PROXY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TRUSTED_PROXY_DEFAULT = '127.0.0.1,::1';
const PROXY_CREDENTIAL_NAME = 'yunpanel-internal-proxy-token';

function internalProxyToken(env = process.env, readFile = readFileSync) {
  if (typeof env.YUNPANEL_INTERNAL_PROXY_TOKEN === 'string') return env.YUNPANEL_INTERNAL_PROXY_TOKEN;
  if (typeof env.CREDENTIALS_DIRECTORY !== 'string' || !path.isAbsolute(env.CREDENTIALS_DIRECTORY)) return undefined;
  try { return readFile(path.join(env.CREDENTIALS_DIRECTORY, PROXY_CREDENTIAL_NAME), 'utf8').trim(); }
  catch { return undefined; }
}

function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const candidate = trimmed.toLowerCase().startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
  const version = isIP(candidate);
  if (version === 4) return candidate;
  if (version === 6) return new URL(`http://[${candidate}]`).hostname.slice(1, -1);
  return null;
}

function parseIpSet(value, label) {
  const entries = (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const normalized = entries.map(normalizeIp);
  if (normalized.some((entry) => entry === null)) throw new Error(`${label} must contain only IP addresses`);
  return new Set(normalized);
}

function singleForwardedIp(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.includes(',')) return false;
  return normalizeIp(value) ?? false;
}

function clientAddress(request, trustedProxies) {
  const peer = normalizeIp(request.socket.remoteAddress);
  if (!peer) return null;
  const realAddress = singleForwardedIp(request.headers['x-real-ip']);
  const forwardedFor = singleForwardedIp(request.headers['x-forwarded-for']);
  const hasForwarded = request.headers.forwarded !== undefined || realAddress !== null || forwardedFor !== null;
  if (!trustedProxies.has(peer)) return hasForwarded ? null : peer;
  if (request.headers.forwarded !== undefined || realAddress === false || forwardedFor === false) return null;
  if (realAddress && forwardedFor && realAddress !== forwardedFor) return null;
  return realAddress || forwardedFor || peer;
}

function reply(response, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, {
    'cache-control': 'no-store', 'content-type': contentType, 'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function rejectSocket(socket, statusCode) {
  if (socket.destroyed) return;
  const status = [400, 401, 403, 404, 409, 429, 502, 503].includes(statusCode) ? statusCode : 502;
  const labels = {
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    409: 'Conflict', 429: 'Too Many Requests', 502: 'Bad Gateway', 503: 'Service Unavailable',
  };
  socket.end(`HTTP/1.1 ${status} ${labels[status]}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`);
}

function sameOriginMutation(request, publicOrigin) {
  if (request.method === 'GET' || request.method === 'HEAD') return true;
  const fetchSite = request.headers['sec-fetch-site'];
  return request.headers.origin === publicOrigin && (!fetchSite || ['same-origin', 'none'].includes(fetchSite));
}

function browserProxyHeaders(request) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name) && value !== undefined
      && !['authorization', 'forwarded', 'host', 'x-forwarded-for', 'x-real-ip',
        'x-yunpanel-client-ip', 'x-yunpanel-proxy-token', 'x-yunpanel-tool-session',
        'x-yunpanel-tool-transport', 'x-yunpanel-ttyd-auth',
        'x-yunpanel-elfinder-unix-user', 'x-yunpanel-elfinder-website-id',
        'x-yunpanel-elfinder-application-id'].includes(name)) {
      headers[name] = value;
    }
  }
  return headers;
}

function authorizeToolGateway(request, {
  apiHost, apiPort, clientIp, proxyToken, accessPath, label, extraHeaders = null,
}) {
  return new Promise((resolve) => {
    const headers = {
      host: `${apiHost}:${apiPort}`,
      'x-yunpanel-client-ip': clientIp,
      'x-yunpanel-proxy-token': proxyToken,
    };
    if (typeof request.headers.cookie === 'string') headers.cookie = request.headers.cookie;
    if (extraHeaders) {
      for (const [name, value] of Object.entries(extraHeaders)) {
        if (typeof value !== 'string' || !/^[a-z0-9-]+$/.test(name)
          || /[\r\n]/.test(value)) {
          resolve(503);
          return;
        }
        headers[name] = value;
      }
    }
    const upstream = http.request({
      host: apiHost,
      port: apiPort,
      method: 'GET',
      path: accessPath,
      headers,
    }, (upstreamResponse) => {
      const status = upstreamResponse.statusCode ?? 503;
      upstreamResponse.resume();
      upstreamResponse.once('end', () => resolve(status));
    });
    upstream.setTimeout(5_000, () => upstream.destroy(new Error(`${label} access gate timeout`)));
    upstream.once('error', () => resolve(503));
    upstream.end();
  });
}

function authorizePhpMyAdminGateway(request, options) {
  return authorizeToolGateway(request, {
    ...options,
    accessPath: PHPMYADMIN_GATEWAY_ACCESS_PATH,
    label: 'phpMyAdmin',
  });
}

function authorizeElFinderGateway(request, options) {
  return authorizeToolGateway(request, {
    ...options,
    accessPath: ELFINDER_GATEWAY_ACCESS_PATH,
    label: 'elFinder',
  });
}

function authorizeNetdataGateway(request, options) {
  return authorizeToolGateway(request, {
    ...options,
    accessPath: NETDATA_GATEWAY_ACCESS_PATH,
    label: 'Netdata',
  });
}

function authorizeTtydGateway(request, sessionId, transport, options) {
  if (!['http', 'websocket'].includes(transport)) return Promise.resolve(503);
  return authorizeToolGateway(request, {
    ...options,
    accessPath: TTYD_GATEWAY_ACCESS_PATH,
    label: 'ttyd',
    extraHeaders: {
      'x-yunpanel-tool-session': sessionId,
      'x-yunpanel-tool-transport': transport,
    },
  });
}

class ElFinderGatewayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ElFinderGatewayError';
    this.status = status;
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function applicationUser(applicationId) {
  return `yunapp-${sha256(applicationId).slice(0, 12)}`;
}

function readSingleCookie(request, name) {
  const entries = String(request.headers.cookie ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${name}=`));
  if (entries.length !== 1) return null;
  const value = entries[0].slice(name.length + 1);
  return value.length > 0 ? value : null;
}

function panelSessionDigest(request) {
  const production = readSingleCookie(request, '__Host-yunpanel_session');
  const development = readSingleCookie(request, 'yunpanel_session');
  if (production && development) return null;
  const value = production ?? development;
  return value ? sha256(value) : null;
}

function elFinderSessionCookieName(publicOrigin) {
  return new URL(publicOrigin).protocol === 'https:'
    ? '__Secure-yunpanel_elfinder'
    : 'yunpanel_elfinder';
}

function createElFinderGatewaySessions({
  now = Date.now,
  ttlMs = ELFINDER_SESSION_TTL_MS,
  maxSessions = ELFINDER_SESSION_LIMIT,
} = {}) {
  if (typeof now !== 'function'
    || !Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 12 * 60 * 60 * 1000
    || !Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 1_000) {
    throw new TypeError('elFinder gateway session policy is invalid');
  }
  const sessions = new Map();

  function pruneExpired() {
    const current = now();
    for (const [key, record] of sessions) {
      if (record.expiresAt <= current) sessions.delete(key);
    }
  }

  function issue(bundle, authDigest) {
    if (!validElFinderBundle(bundle) || typeof authDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(authDigest)) {
      throw new TypeError('elFinder gateway session input is invalid');
    }
    pruneExpired();
    while (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now() + ttlMs;
    sessions.set(sha256(token), Object.freeze({ bundle, authDigest, expiresAt }));
    return Object.freeze({ token, expiresAt });
  }

  function resolve(token, authDigest) {
    if (typeof token !== 'string' || !CAPABILITY_PATTERN.test(token)
      || typeof authDigest !== 'string' || !/^[a-f0-9]{64}$/.test(authDigest)) return null;
    pruneExpired();
    const record = sessions.get(sha256(token));
    if (!record || record.expiresAt <= now() || record.authDigest !== authDigest) return null;
    return record.bundle;
  }

  function revoke(token) {
    if (typeof token !== 'string' || !CAPABILITY_PATTERN.test(token)) return false;
    return sessions.delete(sha256(token));
  }

  return Object.freeze({ issue, resolve, revoke, size: () => sessions.size });
}

function validElFinderBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)
    || bundle.version !== 1 || bundle.protocol !== 'yunpanel-elfinder-handoff-v1'
    || bundle.audience !== 'elfinder'
    || !UUID_PATTERN.test(bundle.serverId ?? '')
    || !UUID_PATTERN.test(bundle.websiteId ?? '')
    || !Number.isSafeInteger(bundle.websiteRevision) || bundle.websiteRevision < 1
    || !UUID_PATTERN.test(bundle.applicationId ?? '')
    || !APP_USER_PATTERN.test(bundle.unixUser ?? '')
    || !Number.isSafeInteger(bundle.expiresAt)) return false;
  const applicationId = bundle.applicationId.toLowerCase();
  return bundle.unixUser === applicationUser(applicationId)
    && bundle.root === `/var/lib/yunpanel/data/${applicationId}`;
}

function readElFinderHandoffBody(request) {
  return new Promise((resolve, reject) => {
    const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(contentType)) {
      reject(new ElFinderGatewayError(415, 'elfinder_gateway_json_required', 'Send application/json.'));
      return;
    }
    let bytes = 0;
    let rejected = false;
    const chunks = [];
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024) {
        if (!rejected) {
          rejected = true;
          reject(new ElFinderGatewayError(
            413,
            'elfinder_gateway_body_too_large',
            'Request is too large.',
          ));
        }
        return;
      }
      if (!rejected) chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).length !== 1
          || typeof value.capability !== 'string'
          || !CAPABILITY_PATTERN.test(value.capability)) {
          throw new Error('invalid payload');
        }
        resolve(value.capability);
      } catch {
        reject(new ElFinderGatewayError(400, 'elfinder_gateway_request_invalid', 'elFinder handoff request is invalid.'));
      }
    });
    request.on('aborted', () => {
      if (!rejected) reject(new ElFinderGatewayError(
        400,
        'elfinder_gateway_request_aborted',
        'elFinder handoff request was interrupted.',
      ));
    });
    request.on('error', () => {
      if (!rejected) reject(new ElFinderGatewayError(
        400,
        'elfinder_gateway_request_failed',
        'elFinder handoff request failed.',
      ));
    });
  });
}

function consumeElFinderHandoff(capability, {
  handoffSocketPath = ELFINDER_HANDOFF_SOCKET_PATH,
  requestImpl = http.request,
} = {}) {
  if (typeof capability !== 'string' || !CAPABILITY_PATTERN.test(capability)) {
    return Promise.reject(new ElFinderGatewayError(
      400,
      'elfinder_gateway_capability_invalid',
      'elFinder handoff is invalid.',
    ));
  }
  if (typeof handoffSocketPath !== 'string' || !path.isAbsolute(handoffSocketPath)
    || path.resolve(handoffSocketPath) !== handoffSocketPath || handoffSocketPath === '/') {
    return Promise.reject(new ElFinderGatewayError(
      503,
      'elfinder_gateway_handoff_unavailable',
      'elFinder handoff service is unavailable.',
    ));
  }

  const body = JSON.stringify({ capability });
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const upstream = requestImpl({
      socketPath: handoffSocketPath,
      method: 'POST',
      path: '/consume',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      },
    }, (upstreamResponse) => {
      const chunks = [];
      let bytes = 0;
      upstreamResponse.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024) {
          upstreamResponse.destroy();
          fail(new ElFinderGatewayError(
            503,
            'elfinder_gateway_handoff_invalid',
            'elFinder handoff response is invalid.',
          ));
          return;
        }
        chunks.push(chunk);
      });
      upstreamResponse.on('end', () => {
        if (settled) return;
        const status = upstreamResponse.statusCode ?? 503;
        let payload;
        try { payload = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
        catch {
          fail(new ElFinderGatewayError(
            503,
            'elfinder_gateway_handoff_invalid',
            'elFinder handoff response is invalid.',
          ));
          return;
        }
        if (status !== 200) {
          const safeStatus = [400, 401, 403, 404, 409, 429, 503].includes(status) ? status : 503;
          fail(new ElFinderGatewayError(
            safeStatus,
            payload?.error?.code ?? 'elfinder_gateway_handoff_rejected',
            'elFinder handoff was rejected.',
          ));
          return;
        }
        if (!validElFinderBundle(payload?.data)) {
          fail(new ElFinderGatewayError(
            503,
            'elfinder_gateway_handoff_invalid',
            'elFinder handoff response is invalid.',
          ));
          return;
        }
        settled = true;
        resolve(Object.freeze({ ...payload.data }));
      });
    });
    upstream.setTimeout(5_000, () => upstream.destroy(new Error('elFinder handoff timeout')));
    upstream.once('error', () => {
      fail(new ElFinderGatewayError(
        503,
        'elfinder_gateway_handoff_unavailable',
        'elFinder handoff service is unavailable.',
      ));
    });
    upstream.end(body);
  });
}

function elFinderSessionCookie(session, publicOrigin) {
  const secure = new URL(publicOrigin).protocol === 'https:';
  const maxAge = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));
  return `${elFinderSessionCookieName(publicOrigin)}=${session.token}; Path=${ELFINDER_PREFIX}/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function rewritePhpMyAdminLocation(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return value;
  if (value === PHPMYADMIN_PREFIX || value.startsWith(`${PHPMYADMIN_PREFIX}/`)) return value;
  return `${PHPMYADMIN_PREFIX}${value}`;
}

function scopePhpMyAdminSetCookie(value) {
  const rewrite = (cookie) => String(cookie).replace(/;\s*Path=\/(?:;|$)/i, `; Path=${PHPMYADMIN_PREFIX}/;`);
  if (Array.isArray(value)) return value.map(rewrite);
  return typeof value === 'string' ? rewrite(value) : value;
}

function proxyPhpMyAdmin(request, response, {
  phpMyAdminSocketPath, publicOrigin,
}) {
  if (!sameOriginMutation(request, publicOrigin)) {
    reply(response, 403, 'Cross-origin phpMyAdmin mutations are not allowed.');
    return;
  }
  if (!['GET', 'HEAD', 'POST'].includes(request.method ?? '')) {
    reply(response, 405, 'Method not allowed.');
    return;
  }
  const requestUrl = new URL(request.url ?? '/', 'http://panel.local');
  const upstreamPath = requestUrl.pathname.slice(PHPMYADMIN_PREFIX.length) || '/';
  if (!upstreamPath.startsWith('/')) {
    reply(response, 404, 'Not found.');
    return;
  }
  const publicUrl = new URL(publicOrigin);
  const headers = browserProxyHeaders(request);
  headers.host = publicUrl.host;
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-host'] = publicUrl.host;
  headers['x-forwarded-prefix'] = `${PHPMYADMIN_PREFIX}/`;

  const upstream = http.request({
    socketPath: phpMyAdminSocketPath,
    method: request.method,
    path: `${upstreamPath}${requestUrl.search}`,
    headers,
  }, (upstreamResponse) => {
    const responseHeaders = {};
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (HOP_BY_HOP_HEADERS.has(name) || value === undefined) continue;
      if (name === 'location') {
        responseHeaders[name] = rewritePhpMyAdminLocation(value);
        continue;
      }
      if (name === 'set-cookie') {
        responseHeaders[name] = scopePhpMyAdminSetCookie(value);
        continue;
      }
      responseHeaders[name] = value;
    }
    responseHeaders['cache-control'] = 'no-store';
    responseHeaders['x-robots-tag'] = 'noindex, nofollow, noarchive';
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.pipe(response);
  });
  upstream.setTimeout(120_000, () => upstream.destroy(new Error('phpMyAdmin upstream timeout')));
  upstream.once('error', () => {
    if (!response.headersSent) reply(response, 503, 'phpMyAdmin is unavailable.');
    else response.destroy();
  });
  request.once('aborted', () => upstream.destroy());
  request.pipe(upstream);
}

function rewriteNetdataLocation(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return value;
  if (value === NETDATA_PREFIX || value.startsWith(`${NETDATA_PREFIX}/`)) return value;
  return `${NETDATA_PREFIX}${value}`;
}

function scopeNetdataSetCookie(value) {
  const rewrite = (cookie) => String(cookie).replace(/;\s*Path=\/(?:;|$)/i, `; Path=${NETDATA_PREFIX}/;`);
  if (Array.isArray(value)) return value.map(rewrite);
  return typeof value === 'string' ? rewrite(value) : value;
}

function proxyNetdata(request, response, {
  netdataPort, netdataHost = '127.0.0.1', publicOrigin,
}) {
  if (!sameOriginMutation(request, publicOrigin)) {
    reply(response, 403, 'Cross-origin Netdata mutations are not allowed.');
    return;
  }
  if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'].includes(request.method ?? '')) {
    reply(response, 405, 'Method not allowed.');
    return;
  }
  const requestUrl = new URL(request.url ?? '/', 'http://panel.local');
  const upstreamPath = requestUrl.pathname.slice(NETDATA_PREFIX.length) || '/';
  if (!upstreamPath.startsWith('/')) {
    reply(response, 404, 'Not found.');
    return;
  }
  const publicUrl = new URL(publicOrigin);
  const headers = browserProxyHeaders(request);
  headers.host = publicUrl.host;
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-host'] = publicUrl.host;
  headers['x-forwarded-prefix'] = `${NETDATA_PREFIX}/`;

  const upstream = http.request({
    host: netdataHost,
    port: netdataPort,
    method: request.method,
    path: `${upstreamPath}${requestUrl.search}`,
    headers,
  }, (upstreamResponse) => {
    const responseHeaders = {};
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (HOP_BY_HOP_HEADERS.has(name) || value === undefined) continue;
      if (name === 'location') {
        responseHeaders[name] = rewriteNetdataLocation(value);
        continue;
      }
      if (name === 'set-cookie') {
        responseHeaders[name] = scopeNetdataSetCookie(value);
        continue;
      }
      responseHeaders[name] = value;
    }
    responseHeaders['cache-control'] = responseHeaders['cache-control'] || 'no-store';
    responseHeaders['x-robots-tag'] = 'noindex, nofollow, noarchive';
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.pipe(response);
  });
  upstream.setTimeout(120_000, () => upstream.destroy(new Error('Netdata upstream timeout')));
  upstream.once('error', () => {
    if (!response.headersSent) reply(response, 502, 'Netdata upstream is unavailable.');
    else response.destroy();
  });
  request.once('aborted', () => upstream.destroy());
  request.pipe(upstream);
}

function rewriteElFinderLocation(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return value;
  if (value === ELFINDER_PREFIX || value.startsWith(`${ELFINDER_PREFIX}/`)) return value;
  return `${ELFINDER_PREFIX}${value}`;
}

function resolveElFinderGatewayBundle(request, { sessions, publicOrigin }) {
  const authDigest = panelSessionDigest(request);
  if (!authDigest) return null;
  const token = readSingleCookie(request, elFinderSessionCookieName(publicOrigin));
  if (!token) return null;
  return sessions.resolve(token, authDigest);
}

async function establishElFinderGatewaySession(request, response, {
  sessions, publicOrigin, handoffSocketPath,
}) {
  if (request.method !== 'POST') {
    throw new ElFinderGatewayError(405, 'elfinder_gateway_method_not_allowed', 'Use POST.');
  }
  if (!sameOriginMutation(request, publicOrigin)) {
    throw new ElFinderGatewayError(
      403,
      'elfinder_gateway_origin_forbidden',
      'Cross-origin elFinder handoff is not allowed.',
    );
  }
  const authDigest = panelSessionDigest(request);
  if (!authDigest) {
    throw new ElFinderGatewayError(
      401,
      'elfinder_gateway_session_missing',
      'Authentication required.',
    );
  }
  const capability = await readElFinderHandoffBody(request);
  const bundle = await consumeElFinderHandoff(capability, { handoffSocketPath });
  const session = sessions.issue(bundle, authDigest);
  response.writeHead(204, {
    'cache-control': 'no-store',
    'set-cookie': elFinderSessionCookie(session, publicOrigin),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end();
}

function proxyElFinder(request, response, {
  elFinderSocketPath, publicOrigin, bundle = null,
}) {
  if (!sameOriginMutation(request, publicOrigin)) {
    reply(response, 403, 'Cross-origin elFinder mutations are not allowed.');
    return;
  }
  if (!['GET', 'HEAD', 'POST'].includes(request.method ?? '')) {
    reply(response, 405, 'Method not allowed.');
    return;
  }

  const requestUrl = new URL(request.url ?? '/', 'http://panel.local');
  const upstreamPath = requestUrl.pathname.slice(ELFINDER_PREFIX.length) || '/';
  if (!upstreamPath.startsWith('/') || upstreamPath.includes('..')) {
    reply(response, 404, 'Not found.');
    return;
  }
  const connector = upstreamPath === '/connector.php';
  if (request.method === 'POST' && !connector) {
    reply(response, 405, 'Method not allowed.');
    return;
  }
  if (connector && !validElFinderBundle(bundle)) {
    reply(response, 401, 'Open Website Files from YunPanel again.');
    return;
  }

  const publicUrl = new URL(publicOrigin);
  const headers = browserProxyHeaders(request);
  delete headers.cookie;
  headers.host = publicUrl.host;
  headers['x-forwarded-proto'] = publicUrl.protocol.slice(0, -1);
  headers['x-forwarded-host'] = publicUrl.host;
  headers['x-forwarded-prefix'] = `${ELFINDER_PREFIX}/`;
  if (connector) {
    headers['x-yunpanel-elfinder-unix-user'] = bundle.unixUser;
    headers['x-yunpanel-elfinder-website-id'] = bundle.websiteId;
    headers['x-yunpanel-elfinder-application-id'] = bundle.applicationId;
  }

  const upstream = http.request({
    socketPath: elFinderSocketPath,
    method: request.method,
    path: `${upstreamPath}${requestUrl.search}`,
    headers,
  }, (upstreamResponse) => {
    const responseHeaders = {};
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (HOP_BY_HOP_HEADERS.has(name) || value === undefined || name === 'set-cookie') continue;
      responseHeaders[name] = name === 'location' ? rewriteElFinderLocation(value) : value;
    }
    responseHeaders['cache-control'] = 'no-store';
    responseHeaders['x-robots-tag'] = 'noindex, nofollow, noarchive';
    responseHeaders['x-frame-options'] = 'SAMEORIGIN';
    responseHeaders['content-security-policy'] = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.pipe(response);
  });
  upstream.setTimeout(120_000, () => upstream.destroy(new Error('elFinder upstream timeout')));
  upstream.once('error', () => {
    if (!response.headersSent) reply(response, 503, 'elFinder is unavailable.');
    else response.destroy();
  });
  request.once('aborted', () => upstream.destroy());
  request.pipe(upstream);
}

function parseTtydGatewayPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(`${TTYD_PREFIX}/`)) return null;
  const remainder = pathname.slice(TTYD_PREFIX.length + 1);
  const slash = remainder.indexOf('/');
  const sessionId = (slash === -1 ? remainder : remainder.slice(0, slash)).toLowerCase();
  if (!TTYD_SESSION_PATTERN.test(sessionId)) return null;
  const suffix = slash === -1 ? '' : remainder.slice(slash);
  if (suffix.includes('..') || /%2e/i.test(suffix) || /[\u0000-\u001f\u007f]/.test(suffix)) return null;
  return Object.freeze({
    sessionId,
    basePath: `${TTYD_PREFIX}/${sessionId}`,
    upstreamPath: `${TTYD_PREFIX}/${sessionId}${suffix}`,
  });
}

function ttydSocketPath(socketRoot, sessionId) {
  if (typeof socketRoot !== 'string' || !path.isAbsolute(socketRoot)
    || path.resolve(socketRoot) !== socketRoot || socketRoot === '/'
    || !TTYD_SESSION_PATTERN.test(sessionId)) return null;
  return path.join(socketRoot, `${sessionId.toLowerCase()}.sock`);
}

function proxyTtyd(request, response, {
  socketPath, publicOrigin, route,
}) {
  if (!route || !socketPath) {
    reply(response, 404, 'Not found.');
    return;
  }
  if (!['GET', 'HEAD'].includes(request.method ?? '')) {
    reply(response, 405, 'Method not allowed.');
    return;
  }
  const requestUrl = new URL(request.url ?? '/', 'http://panel.local');
  const publicUrl = new URL(publicOrigin);
  const headers = browserProxyHeaders(request);
  delete headers.cookie;
  delete headers['x-csrf-token'];
  headers.host = publicUrl.host;
  headers[TTYD_AUTH_HEADER] = 'owner';
  headers['x-forwarded-proto'] = publicUrl.protocol.slice(0, -1);
  headers['x-forwarded-host'] = publicUrl.host;
  headers['x-forwarded-prefix'] = route.basePath;

  const upstream = http.request({
    socketPath,
    method: request.method,
    path: `${route.upstreamPath}${requestUrl.search}`,
    headers,
  }, (upstreamResponse) => {
    const responseHeaders = {};
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (HOP_BY_HOP_HEADERS.has(name) || value === undefined || name === 'set-cookie') continue;
      responseHeaders[name] = value;
    }
    responseHeaders['cache-control'] = 'no-store';
    responseHeaders['x-robots-tag'] = 'noindex, nofollow, noarchive';
    responseHeaders['x-frame-options'] = 'SAMEORIGIN';
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.pipe(response);
  });
  upstream.setTimeout(30_000, () => upstream.destroy(new Error('ttyd upstream timeout')));
  upstream.once('error', () => {
    if (!response.headersSent) reply(response, 503, 'Terminal is unavailable.');
    else response.destroy();
  });
  request.once('aborted', () => upstream.destroy());
  request.pipe(upstream);
}

function proxyTtydWebSocket(request, socket, head, {
  socketPath,
  publicOrigin,
  route,
  reauthorize = null,
  reauthorizeIntervalMs = TTYD_REAUTHORIZE_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  const fetchSite = request.headers['sec-fetch-site'];
  if (!route || !socketPath || request.method !== 'GET'
    || request.headers.origin !== publicOrigin
    || (fetchSite && !['same-origin', 'none'].includes(fetchSite))
    || (reauthorize !== null && typeof reauthorize !== 'function')
    || !Number.isSafeInteger(reauthorizeIntervalMs)
    || reauthorizeIntervalMs < 5_000 || reauthorizeIntervalMs > 60_000
    || typeof setIntervalFn !== 'function' || typeof clearIntervalFn !== 'function') {
    rejectSocket(socket, 403);
    return;
  }

  const requestUrl = new URL(request.url ?? '/', 'http://panel.local');
  const publicUrl = new URL(publicOrigin);
  const headers = browserProxyHeaders(request);
  delete headers.cookie;
  delete headers['x-csrf-token'];
  headers.host = publicUrl.host;
  headers.connection = 'Upgrade';
  headers.upgrade = 'websocket';
  headers[TTYD_AUTH_HEADER] = 'owner';
  headers['x-forwarded-proto'] = publicUrl.protocol.slice(0, -1);
  headers['x-forwarded-host'] = publicUrl.host;
  headers['x-forwarded-prefix'] = route.basePath;

  const upstream = http.request({
    socketPath,
    method: 'GET',
    path: `${route.upstreamPath}${requestUrl.search}`,
    headers,
  });
  upstream.setTimeout(10_000, () => upstream.destroy(new Error('ttyd websocket timeout')));
  upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
    upstream.setTimeout(0);
    const allowed = ['upgrade', 'connection', 'sec-websocket-accept', 'sec-websocket-protocol'];
    const responseHeaders = [];
    for (const name of allowed) {
      const value = upstreamResponse.headers[name];
      if (typeof value === 'string' && !/[\r\n]/.test(value)) {
        responseHeaders.push(`${name}: ${value}`);
      }
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${responseHeaders.join('\r\n')}\r\n\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    socket.pipe(upstreamSocket).pipe(socket);

    let authorizationCheck = null;
    let authorizationPending = false;
    const clearAuthorizationCheck = () => {
      if (authorizationCheck !== null) {
        clearIntervalFn(authorizationCheck);
        authorizationCheck = null;
      }
    };
    if (reauthorize) {
      authorizationCheck = setIntervalFn(() => {
        if (authorizationPending || socket.destroyed || upstreamSocket.destroyed) return;
        authorizationPending = true;
        Promise.resolve()
          .then(() => reauthorize())
          .then((status) => {
            if (status !== 204) {
              clearAuthorizationCheck();
              upstreamSocket.destroy();
              socket.destroy();
            }
          })
          .catch(() => {
            clearAuthorizationCheck();
            upstreamSocket.destroy();
            socket.destroy();
          })
          .finally(() => { authorizationPending = false; });
      }, reauthorizeIntervalMs);
      authorizationCheck?.unref?.();
    }

    socket.on('error', () => upstreamSocket.destroy());
    upstreamSocket.on('error', () => socket.destroy());
    socket.on('close', clearAuthorizationCheck);
    upstreamSocket.on('close', clearAuthorizationCheck);
  });
  upstream.on('response', (upstreamResponse) => {
    upstreamResponse.resume();
    rejectSocket(
      socket,
      [400, 401, 403, 404, 409, 429, 503].includes(upstreamResponse.statusCode)
        ? upstreamResponse.statusCode
        : 502,
    );
  });
  upstream.on('error', () => rejectSocket(socket, 502));
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.end();
}

function isTransportPath(pathname) {
  return pathname === '/api/servers/enroll'
    || /^\/api\/servers\/[^/]+\/(?:heartbeat|commands(?:\/|$)|applications\/[^/]+\/environment$)/.test(pathname);
}

function isGithubWebhookPath(pathname) {
  return /^\/api\/webhooks\/github\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pathname);
}

function proxyRequest(request, response, { apiHost, apiPort, clientIp, proxyToken, publicOrigin, signedWebhook = false }) {
  if (!signedWebhook && !sameOriginMutation(request, publicOrigin)) {
    reply(response, 403, 'Cross-origin panel mutations are not allowed.');
    return;
  }
  const requestUrl = new URL(request.url ?? '/', 'http://panel.local');
  const upstreamPathname = requestUrl.pathname.startsWith('/api/panel/')
    ? `/api/${requestUrl.pathname.slice('/api/panel/'.length)}` : requestUrl.pathname;
  if (isTransportPath(upstreamPathname)) { reply(response, 404, 'Not found.'); return; }
  const headers = browserProxyHeaders(request);
  headers.host = `${apiHost}:${apiPort}`;
  headers['x-yunpanel-client-ip'] = clientIp;
  headers['x-yunpanel-proxy-token'] = proxyToken;
  // Cookies and CSRF headers pass through. The gateway never grants an administrator identity.
  const upstream = http.request({
    host: apiHost, port: apiPort, method: request.method,
    path: `${upstreamPathname}${requestUrl.search}`, headers,
  }, (upstreamResponse) => {
    const responseHeaders = {};
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (!HOP_BY_HOP_HEADERS.has(name) && value !== undefined) responseHeaders[name] = value;
    }
    responseHeaders['cache-control'] = 'no-store';
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.pipe(response);
  });
  upstream.setTimeout(30_000, () => upstream.destroy(new Error('Upstream timeout')));
  upstream.on('error', () => {
    if (!response.headersSent) reply(response, 502, 'Panel API is unavailable.');
    else response.destroy();
  });
  request.on('aborted', () => upstream.destroy());
  request.pipe(upstream);
}

function proxyWebSocket(request, socket, head, { apiHost, apiPort, clientIp, proxyToken, publicOrigin }) {
  const fetchSite = request.headers['sec-fetch-site'];
  if (request.method !== 'GET' || request.headers.origin !== publicOrigin
    || (fetchSite && !['same-origin', 'none'].includes(fetchSite))) {
    rejectSocket(socket, 403);
    return;
  }
  const headers = browserProxyHeaders(request);
  headers.host = `${apiHost}:${apiPort}`;
  headers.connection = 'Upgrade';
  headers.upgrade = 'websocket';
  headers['x-yunpanel-client-ip'] = clientIp;
  headers['x-yunpanel-proxy-token'] = proxyToken;

  const upstream = http.request({ host: apiHost, port: apiPort, method: 'GET', path: '/api/terminal', headers });
  upstream.setTimeout(10_000, () => upstream.destroy(new Error('Upstream timeout')));
  upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
    upstream.setTimeout(0);
    const allowed = ['upgrade', 'connection', 'sec-websocket-accept', 'sec-websocket-protocol'];
    const responseHeaders = [];
    for (const name of allowed) {
      const value = response.headers[name];
      if (typeof value === 'string' && !/[\r\n]/.test(value)) responseHeaders.push(`${name}: ${value}`);
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${responseHeaders.join('\r\n')}\r\n\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    socket.pipe(upstreamSocket).pipe(socket);
    socket.on('error', () => upstreamSocket.destroy());
    upstreamSocket.on('error', () => socket.destroy());
  });
  upstream.on('response', (response) => {
    response.resume();
    rejectSocket(socket, [400, 401, 403, 404, 409, 429, 503].includes(response.statusCode) ? response.statusCode : 502);
  });
  upstream.on('error', () => rejectSocket(socket, 502));
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.end();
}

function proxyNetdataWebSocket(request, socket, head, {
  netdataPort, netdataHost = '127.0.0.1', publicOrigin,
}) {
  const fetchSite = request.headers['sec-fetch-site'];
  if (request.method !== 'GET' || request.headers.origin !== publicOrigin
    || (fetchSite && !['same-origin', 'none'].includes(fetchSite))) {
    rejectSocket(socket, 403);
    return;
  }
  const requestUrl = new URL(request.url ?? '/', 'http://panel.local');
  const upstreamPath = requestUrl.pathname.slice(NETDATA_PREFIX.length) || '/';
  const headers = browserProxyHeaders(request);
  const publicUrl = new URL(publicOrigin);
  headers.host = publicUrl.host;
  headers.connection = 'Upgrade';
  headers.upgrade = 'websocket';
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-host'] = publicUrl.host;
  headers['x-forwarded-prefix'] = `${NETDATA_PREFIX}/`;

  const upstream = http.request({
    host: netdataHost,
    port: netdataPort,
    method: 'GET',
    path: `${upstreamPath}${requestUrl.search}`,
    headers,
  });
  upstream.setTimeout(10_000, () => upstream.destroy(new Error('Netdata WebSocket timeout')));
  upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
    upstream.setTimeout(0);
    const allowed = ['upgrade', 'connection', 'sec-websocket-accept', 'sec-websocket-protocol'];
    const responseHeaders = [];
    for (const name of allowed) {
      const value = response.headers[name];
      if (typeof value === 'string' && !/[\r\n]/.test(value)) responseHeaders.push(`${name}: ${value}`);
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${responseHeaders.join('\r\n')}\r\n\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    socket.pipe(upstreamSocket).pipe(socket);
    socket.on('error', () => upstreamSocket.destroy());
    upstreamSocket.on('error', () => socket.destroy());
  });
  upstream.on('response', (response) => {
    response.resume();
    rejectSocket(socket, [400, 401, 403, 404, 409, 429, 503].includes(response.statusCode) ? response.statusCode : 502);
  });
  upstream.on('error', () => rejectSocket(socket, 502));
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.end();
}

async function serveStatic(request, response, webRoot, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') { reply(response, 405, 'Method not allowed.'); return; }
  let decodedPath;
  try { decodedPath = decodeURIComponent(pathname); }
  catch { reply(response, 400, 'Invalid path.'); return; }
  const requestedPath = path.resolve(webRoot, `.${decodedPath}`);
  if (requestedPath !== webRoot && !requestedPath.startsWith(`${webRoot}${path.sep}`)) { reply(response, 403, 'Forbidden.'); return; }
  let filePath = requestedPath;
  try {
    const metadata = await stat(filePath);
    if (metadata.isDirectory()) filePath = path.join(filePath, 'index.html');
    await stat(filePath);
  } catch { filePath = path.join(webRoot, 'index.html'); }
  const extension = path.extname(filePath).toLowerCase();
  response.writeHead(200, {
    'cache-control': extension === '.html' ? 'no-store' : 'public, max-age=300',
    'content-type': CONTENT_TYPES.get(extension) ?? 'application/octet-stream',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
  });
  if (request.method === 'HEAD') { response.end(); return; }
  createReadStream(filePath).on('error', () => {
    if (!response.headersSent) reply(response, 500, 'Unable to read panel asset.');
    else response.destroy();
  }).pipe(response);
}

export function createPanelServer({
  allowedClientIps = process.env.YUNPANEL_ALLOWED_CLIENT_IPS,
  apiHost = process.env.YUNPANEL_API_HOST ?? '127.0.0.1',
  apiPort = Number.parseInt(process.env.YUNPANEL_API_PORT ?? '3001', 10),
  publicOrigin = process.env.YUNPANEL_PUBLIC_ORIGIN,
  proxyToken = internalProxyToken(),
  phpMyAdminSocketPath = PHPMYADMIN_SOCKET_PATH,
  elFinderSocketPath = ELFINDER_GATEWAY_SOCKET_PATH,
  elFinderHandoffSocketPath = ELFINDER_HANDOFF_SOCKET_PATH,
  elFinderGatewaySessions = createElFinderGatewaySessions(),
  ttydSocketRoot = TTYD_SOCKET_ROOT,
  netdataPort = NETDATA_LOOPBACK_PORT,
  netdataHost = '127.0.0.1',
  trustedProxyIps = process.env.YUNPANEL_TRUSTED_PROXY_IPS ?? TRUSTED_PROXY_DEFAULT,
  webRoot = process.env.YUNPANEL_WEB_ROOT ?? DEFAULT_WEB_ROOT,
} = {}) {
  const allowedClients = parseIpSet(allowedClientIps, 'YUNPANEL_ALLOWED_CLIENT_IPS');
  const trustedProxies = parseIpSet(trustedProxyIps, 'YUNPANEL_TRUSTED_PROXY_IPS');
  const resolvedWebRoot = path.resolve(webRoot);
  if (allowedClients.size === 0) throw new Error('YUNPANEL_ALLOWED_CLIENT_IPS is required');
  if (trustedProxies.size === 0) throw new Error('YUNPANEL_TRUSTED_PROXY_IPS is required');
  if (typeof proxyToken !== 'string' || !PROXY_TOKEN_PATTERN.test(proxyToken)) throw new Error('YUNPANEL_INTERNAL_PROXY_TOKEN is required');
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) throw new Error('YUNPANEL_API_PORT is invalid');
  if (!publicOrigin || new URL(publicOrigin).origin !== publicOrigin) throw new Error('YUNPANEL_PUBLIC_ORIGIN is required');
  if (!Number.isInteger(netdataPort) || netdataPort < 1024 || netdataPort > 65535) throw new Error('netdataPort is invalid');
  if (typeof netdataHost !== 'string' || !['127.0.0.1', '::1', 'localhost'].includes(netdataHost)) throw new Error('netdataHost must be a loopback address');
  if (typeof phpMyAdminSocketPath !== 'string' || !path.isAbsolute(phpMyAdminSocketPath)
    || path.resolve(phpMyAdminSocketPath) !== phpMyAdminSocketPath || phpMyAdminSocketPath === '/') {
    throw new Error('phpMyAdmin socket path is invalid');
  }
  for (const [label, socketPath] of [
    ['elFinder gateway', elFinderSocketPath],
    ['elFinder handoff', elFinderHandoffSocketPath],
  ]) {
    if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)
      || path.resolve(socketPath) !== socketPath || socketPath === '/') {
      throw new Error(`${label} socket path is invalid`);
    }
  }
  if (!elFinderGatewaySessions
    || typeof elFinderGatewaySessions.issue !== 'function'
    || typeof elFinderGatewaySessions.resolve !== 'function'
    || typeof elFinderGatewaySessions.revoke !== 'function') {
    throw new Error('elFinder gateway session registry is invalid');
  }
  if (typeof ttydSocketRoot !== 'string' || !path.isAbsolute(ttydSocketRoot)
    || path.resolve(ttydSocketRoot) !== ttydSocketRoot || ttydSocketRoot === '/') {
    throw new Error('ttyd socket root is invalid');
  }
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://panel.local');
    const signedWebhook = isGithubWebhookPath(requestUrl.pathname);
    const clientIp = clientAddress(request, trustedProxies);
    if (!clientIp || (!signedWebhook && !allowedClients.has(clientIp))) {
      reply(response, 403, 'This panel is restricted to an approved client address.'); return;
    }
    if (signedWebhook) {
      proxyRequest(request, response, {
        apiHost, apiPort, clientIp, proxyToken, publicOrigin, signedWebhook: true,
      });
      return;
    }
    const ttydPath = requestUrl.pathname === TTYD_PREFIX
      || requestUrl.pathname.startsWith(`${TTYD_PREFIX}/`);
    const ttydRoute = ttydPath ? parseTtydGatewayPath(requestUrl.pathname) : null;
    if (ttydPath) {
      if (!ttydRoute) {
        reply(response, 404, 'Not found.');
        return;
      }
      const accessStatus = await authorizeTtydGateway(request, ttydRoute.sessionId, 'http', {
        apiHost, apiPort, clientIp, proxyToken,
      });
      if (accessStatus !== 204) {
        const status = accessStatus === 401 || accessStatus === 403 || accessStatus === 404
          ? accessStatus
          : 503;
        reply(response, status, status === 401 ? 'Authentication required.' : 'Terminal access denied.');
        return;
      }
      const sessionSocket = ttydSocketPath(ttydSocketRoot, ttydRoute.sessionId);
      if (!sessionSocket) {
        reply(response, 404, 'Not found.');
        return;
      }
      proxyTtyd(request, response, {
        socketPath: sessionSocket,
        publicOrigin,
        route: ttydRoute,
      });
      return;
    }
    if (requestUrl.pathname === ELFINDER_PREFIX) {
      response.writeHead(308, {
        'cache-control': 'no-store',
        location: `${ELFINDER_PREFIX}/${requestUrl.search}`,
      });
      response.end();
      return;
    }
    if (requestUrl.pathname.startsWith(`${ELFINDER_PREFIX}/`)) {
      const accessStatus = await authorizeElFinderGateway(request, {
        apiHost, apiPort, clientIp, proxyToken,
      });
      if (accessStatus !== 204) {
        const status = accessStatus === 401 || accessStatus === 403 ? accessStatus : 503;
        reply(response, status, status === 401 ? 'Authentication required.' : 'elFinder access denied.');
        return;
      }

      if (requestUrl.pathname === `${ELFINDER_PREFIX}${ELFINDER_HANDOFF_PATH}`) {
        if (requestUrl.search) {
          reply(response, 400, 'elFinder handoff does not accept query parameters.');
          return;
        }
        try {
          await establishElFinderGatewaySession(request, response, {
            sessions: elFinderGatewaySessions,
            publicOrigin,
            handoffSocketPath: elFinderHandoffSocketPath,
          });
        } catch (error) {
          if (response.headersSent || response.destroyed) {
            response.destroy();
            return;
          }
          if (error instanceof ElFinderGatewayError) {
            reply(response, error.status, error.message);
          } else {
            reply(response, 503, 'elFinder handoff is unavailable.');
          }
        }
        return;
      }

      const connector = requestUrl.pathname === `${ELFINDER_PREFIX}/connector.php`;
      const protectedAsset = connector
        || requestUrl.pathname.startsWith(`${ELFINDER_PREFIX}/vendor/`)
        || requestUrl.pathname.startsWith(`${ELFINDER_PREFIX}/assets/`);
      const bundle = protectedAsset
        ? resolveElFinderGatewayBundle(request, {
            sessions: elFinderGatewaySessions,
            publicOrigin,
          })
        : null;
      if (protectedAsset && !bundle) {
        reply(response, 401, 'Open Website Files from YunPanel again.');
        return;
      }
      proxyElFinder(request, response, {
        elFinderSocketPath,
        publicOrigin,
        bundle,
      });
      return;
    }
    if (requestUrl.pathname === PHPMYADMIN_PREFIX) {
      response.writeHead(308, {
        'cache-control': 'no-store',
        location: `${PHPMYADMIN_PREFIX}/${requestUrl.search}`,
      });
      response.end();
      return;
    }
    if (requestUrl.pathname.startsWith(`${PHPMYADMIN_PREFIX}/`)) {
      const accessStatus = await authorizePhpMyAdminGateway(request, {
        apiHost, apiPort, clientIp, proxyToken,
      });
      if (accessStatus !== 204) {
        const status = accessStatus === 401 || accessStatus === 403 ? accessStatus : 503;
        reply(response, status, status === 401 ? 'Authentication required.' : 'phpMyAdmin access denied.');
        return;
      }
      proxyPhpMyAdmin(request, response, { phpMyAdminSocketPath, publicOrigin });
      return;
    }
    if (requestUrl.pathname === NETDATA_PREFIX) {
      response.writeHead(308, {
        'cache-control': 'no-store',
        location: `${NETDATA_PREFIX}/${requestUrl.search}`,
      });
      response.end();
      return;
    }
    if (requestUrl.pathname.startsWith(`${NETDATA_PREFIX}/`)) {
      const accessStatus = await authorizeNetdataGateway(request, {
        apiHost, apiPort, clientIp, proxyToken,
      });
      if (accessStatus !== 204) {
        const status = accessStatus === 401 || accessStatus === 403 ? accessStatus : 503;
        reply(response, status, status === 401 ? 'Authentication required.' : 'Netdata access denied.');
        return;
      }
      proxyNetdata(request, response, { netdataPort, netdataHost, publicOrigin });
      return;
    }
    if (requestUrl.pathname === '/api/health' || requestUrl.pathname.startsWith('/api/panel/') || requestUrl.pathname.startsWith('/api/auth/')) {
      proxyRequest(request, response, { apiHost, apiPort, clientIp, proxyToken, publicOrigin }); return;
    }
    if (requestUrl.pathname.startsWith('/api/')) { reply(response, 404, 'Not found.'); return; }
    await serveStatic(request, response, resolvedWebRoot, requestUrl.pathname);
  });
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    let requestUrl;
    try { requestUrl = new URL(request.url ?? '/', 'http://panel.local'); }
    catch { rejectSocket(socket, 400); return; }
    const clientIp = clientAddress(request, trustedProxies);
    if (!clientIp || !allowedClients.has(clientIp)) { rejectSocket(socket, 403); return; }
    const ttydRoute = parseTtydGatewayPath(requestUrl.pathname);
    if (ttydRoute) {
      void authorizeTtydGateway(request, ttydRoute.sessionId, 'websocket', {
        apiHost, apiPort, clientIp, proxyToken,
      }).then((accessStatus) => {
        if (socket.destroyed) return;
        if (accessStatus !== 204) {
          rejectSocket(
            socket,
            accessStatus === 401 || accessStatus === 403 || accessStatus === 404
              ? accessStatus
              : 503,
          );
          return;
        }
        const sessionSocket = ttydSocketPath(ttydSocketRoot, ttydRoute.sessionId);
        if (!sessionSocket) {
          rejectSocket(socket, 404);
          return;
        }
        proxyTtydWebSocket(request, socket, head, {
          socketPath: sessionSocket,
          publicOrigin,
          route: ttydRoute,
          reauthorize: () => authorizeTtydGateway(request, ttydRoute.sessionId, 'websocket', {
            apiHost, apiPort, clientIp, proxyToken,
          }),
        });
      }).catch(() => rejectSocket(socket, 503));
      return;
    }
    if (requestUrl.pathname === NETDATA_PREFIX || requestUrl.pathname.startsWith(`${NETDATA_PREFIX}/`)) {
      void authorizeNetdataGateway(request, {
        apiHost, apiPort, clientIp, proxyToken,
      }).then((accessStatus) => {
        if (socket.destroyed) return;
        if (accessStatus !== 204) {
          rejectSocket(
            socket,
            accessStatus === 401 || accessStatus === 403 ? accessStatus : 503,
          );
          return;
        }
        proxyNetdataWebSocket(request, socket, head, {
          netdataPort,
          netdataHost,
          publicOrigin,
        });
      }).catch(() => rejectSocket(socket, 503));
      return;
    }
    if (requestUrl.pathname !== '/api/terminal' || requestUrl.search) { rejectSocket(socket, 404); return; }
    proxyWebSocket(request, socket, head, { apiHost, apiPort, clientIp, proxyToken, publicOrigin });
  });
  return server;
}

export const panelServerInternals = Object.freeze({
  normalizeIp,
  parseIpSet,
  clientAddress,
  internalProxyToken,
  isGithubWebhookPath,
  proxyWebSocket,
  browserProxyHeaders,
  authorizePhpMyAdminGateway,
  authorizeElFinderGateway,
  authorizeTtydGateway,
  authorizeNetdataGateway,
  proxyPhpMyAdmin,
  proxyElFinder,
  proxyTtyd,
  proxyTtydWebSocket,
  proxyNetdata,
  proxyNetdataWebSocket,
  parseTtydGatewayPath,
  ttydSocketPath,
  rewritePhpMyAdminLocation,
  rewriteElFinderLocation,
  rewriteNetdataLocation,
  scopePhpMyAdminSetCookie,
  scopeNetdataSetCookie,
  panelSessionDigest,
  createElFinderGatewaySessions,
  validElFinderBundle,
  readElFinderHandoffBody,
  consumeElFinderHandoff,
  resolveElFinderGatewayBundle,
  elFinderSessionCookieName,
  phpMyAdminPrefix: PHPMYADMIN_PREFIX,
  phpMyAdminGatewayAccessPath: PHPMYADMIN_GATEWAY_ACCESS_PATH,
  phpMyAdminSocketPath: PHPMYADMIN_SOCKET_PATH,
  elFinderPrefix: ELFINDER_PREFIX,
  elFinderGatewayAccessPath: ELFINDER_GATEWAY_ACCESS_PATH,
  elFinderGatewaySocketPath: ELFINDER_GATEWAY_SOCKET_PATH,
  elFinderHandoffSocketPath: ELFINDER_HANDOFF_SOCKET_PATH,
  elFinderHandoffPath: ELFINDER_HANDOFF_PATH,
  elFinderSessionTtlMs: ELFINDER_SESSION_TTL_MS,
  ttydPrefix: TTYD_PREFIX,
  ttydGatewayAccessPath: TTYD_GATEWAY_ACCESS_PATH,
  ttydSocketRoot: TTYD_SOCKET_ROOT,
  ttydAuthHeader: TTYD_AUTH_HEADER,
  ttydReauthorizeMs: TTYD_REAUTHORIZE_MS,
  netdataPrefix: NETDATA_PREFIX,
  netdataGatewayAccessPath: NETDATA_GATEWAY_ACCESS_PATH,
  netdataLoopbackPort: NETDATA_LOOPBACK_PORT,
});

export function startPanelServer(options = {}) {
  const host = options.host ?? process.env.YUNPANEL_WEB_HOST ?? '127.0.0.1';
  const port = options.port ?? Number.parseInt(process.env.YUNPANEL_WEB_PORT ?? '4300', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('YUNPANEL_WEB_PORT is invalid');
  const server = createPanelServer(options);
  server.listen(port, host, () => console.log(`[yunpanel-web] listening on http://${host}:${port}`));
  return server;
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  const server = startPanelServer();
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
