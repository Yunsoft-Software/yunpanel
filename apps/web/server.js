import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_WEB_ROOT = '/usr/share/yunpanel/web';
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

function sameOriginMutation(request, publicOrigin) {
  if (request.method === 'GET' || request.method === 'HEAD') return true;
  const fetchSite = request.headers['sec-fetch-site'];
  return request.headers.origin === publicOrigin && (!fetchSite || ['same-origin', 'none'].includes(fetchSite));
}

function isTransportPath(pathname) {
  return pathname === '/api/servers/enroll'
    || /^\/api\/servers\/[^/]+\/(?:heartbeat|commands(?:\/|$)|applications\/[^/]+\/environment$)/.test(pathname);
}

function proxyRequest(request, response, { apiHost, apiPort, clientIp, proxyToken, publicOrigin }) {
  if (!sameOriginMutation(request, publicOrigin)) {
    reply(response, 403, 'Cross-origin panel mutations are not allowed.');
    return;
  }
  const requestUrl = new URL(request.url ?? '/', 'http://panel.local');
  const upstreamPathname = requestUrl.pathname.startsWith('/api/panel/')
    ? `/api/${requestUrl.pathname.slice('/api/panel/'.length)}` : requestUrl.pathname;
  if (isTransportPath(upstreamPathname)) { reply(response, 404, 'Not found.'); return; }
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name) && value !== undefined
      && !['authorization', 'forwarded', 'x-forwarded-for', 'x-real-ip', 'x-yunpanel-client-ip', 'x-yunpanel-proxy-token'].includes(name)) headers[name] = value;
  }
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
  proxyToken = process.env.YUNPANEL_INTERNAL_PROXY_TOKEN,
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
  return http.createServer(async (request, response) => {
    const clientIp = clientAddress(request, trustedProxies);
    if (!clientIp || !allowedClients.has(clientIp)) {
      reply(response, 403, 'This panel is restricted to an approved client address.'); return;
    }
    const requestUrl = new URL(request.url ?? '/', 'http://panel.local');
    if (requestUrl.pathname === '/api/health' || requestUrl.pathname.startsWith('/api/panel/') || requestUrl.pathname.startsWith('/api/auth/')) {
      proxyRequest(request, response, { apiHost, apiPort, clientIp, proxyToken, publicOrigin }); return;
    }
    if (requestUrl.pathname.startsWith('/api/')) { reply(response, 404, 'Not found.'); return; }
    await serveStatic(request, response, resolvedWebRoot, requestUrl.pathname);
  });
}

export const panelServerInternals = Object.freeze({ normalizeIp, parseIpSet, clientAddress });

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
