import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_WEB_ROOT = '/usr/share/yunpanel/web';
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
]);

function parseAllowedClients(value) {
  return new Set((value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean));
}

function clientAddress(request) {
  const peer = request.socket.remoteAddress;
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  if (!loopback) return peer;
  const realAddress = request.headers['x-real-ip'];
  return typeof realAddress === 'string' ? realAddress.trim() : peer;
}

function reply(response, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function sameOriginMutation(request, publicOrigin) {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return true;
  const origin = request.headers.origin;
  const fetchSite = request.headers['sec-fetch-site'];
  if (typeof origin === 'string' && origin !== publicOrigin) return false;
  if (typeof fetchSite === 'string' && !['same-origin', 'none'].includes(fetchSite)) return false;
  return true;
}

function proxyRequest(request, response, { adminToken, apiHost, apiPort, publicOrigin }) {
  if (!sameOriginMutation(request, publicOrigin)) {
    reply(response, 403, 'Cross-origin panel mutations are not allowed.');
    return;
  }

  const requestUrl = new URL(request.url ?? '/', 'http://panel.local');
  const upstreamPath = requestUrl.pathname === '/api/health'
    ? `/api/health${requestUrl.search}`
    : `/api/${requestUrl.pathname.slice('/api/panel/'.length)}${requestUrl.search}`;
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name) && value !== undefined && name !== 'authorization') headers[name] = value;
  }
  headers.host = `${apiHost}:${apiPort}`;
  if (requestUrl.pathname !== '/api/health') headers.authorization = `Bearer ${adminToken}`;

  const upstream = http.request({
    host: apiHost,
    port: apiPort,
    method: request.method,
    path: upstreamPath,
    headers,
  }, (upstreamResponse) => {
    const responseHeaders = {};
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (!HOP_BY_HOP_HEADERS.has(name) && value !== undefined) responseHeaders[name] = value;
    }
    responseHeaders['cache-control'] = 'no-store';
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', () => reply(response, 502, 'Panel API is unavailable.'));
  request.pipe(upstream);
}

async function serveStatic(request, response, webRoot, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    reply(response, 405, 'Method not allowed.');
    return;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    reply(response, 400, 'Invalid path.');
    return;
  }

  const requestedPath = path.resolve(webRoot, `.${decodedPath}`);
  if (requestedPath !== webRoot && !requestedPath.startsWith(`${webRoot}${path.sep}`)) {
    reply(response, 403, 'Forbidden.');
    return;
  }

  let filePath = requestedPath;
  try {
    const metadata = await stat(filePath);
    if (metadata.isDirectory()) filePath = path.join(filePath, 'index.html');
    await stat(filePath);
  } catch {
    filePath = path.join(webRoot, 'index.html');
  }

  const extension = path.extname(filePath).toLowerCase();
  response.writeHead(200, {
    'cache-control': extension === '.html' ? 'no-store' : 'public, max-age=300',
    'content-type': CONTENT_TYPES.get(extension) ?? 'application/octet-stream',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(filePath)
    .on('error', () => {
      if (!response.headersSent) reply(response, 500, 'Unable to read panel asset.');
      else response.destroy();
    })
    .pipe(response);
}

export function createPanelServer({
  adminToken = process.env.YUNPANEL_ADMIN_BOOTSTRAP_TOKEN,
  allowedClientIps = process.env.YUNPANEL_ALLOWED_CLIENT_IPS,
  apiHost = process.env.YUNPANEL_API_HOST ?? '127.0.0.1',
  apiPort = Number.parseInt(process.env.YUNPANEL_API_PORT ?? '3001', 10),
  publicOrigin = process.env.YUNPANEL_PUBLIC_ORIGIN,
  webRoot = process.env.YUNPANEL_WEB_ROOT ?? DEFAULT_WEB_ROOT,
} = {}) {
  const allowedClients = parseAllowedClients(allowedClientIps);
  const resolvedWebRoot = path.resolve(webRoot);
  if (!adminToken) throw new Error('YUNPANEL_ADMIN_BOOTSTRAP_TOKEN is required');
  if (allowedClients.size === 0) throw new Error('YUNPANEL_ALLOWED_CLIENT_IPS is required');
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) throw new Error('YUNPANEL_API_PORT is invalid');
  if (!publicOrigin || new URL(publicOrigin).origin !== publicOrigin) throw new Error('YUNPANEL_PUBLIC_ORIGIN is required');

  return http.createServer(async (request, response) => {
    if (!allowedClients.has(clientAddress(request))) {
      reply(response, 403, 'This panel is restricted to an approved client address.');
      return;
    }

    const requestUrl = new URL(request.url ?? '/', 'http://panel.local');
    if (requestUrl.pathname === '/api/health' || requestUrl.pathname.startsWith('/api/panel/')) {
      proxyRequest(request, response, { adminToken, apiHost, apiPort, publicOrigin });
      return;
    }
    if (requestUrl.pathname.startsWith('/api/')) {
      reply(response, 404, 'Not found.');
      return;
    }
    await serveStatic(request, response, resolvedWebRoot, requestUrl.pathname);
  });
}

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
