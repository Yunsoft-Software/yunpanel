import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { createPanelServer, panelServerInternals } from '../server.js';

const proxyToken = 'p'.repeat(43);

test('web gateway reads the scoped hop token from the systemd credential directory', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-web-credential-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'yunpanel-internal-proxy-token'), `${proxyToken}\n`, { mode: 0o600 });
  assert.equal(panelServerInternals.internalProxyToken({ CREDENTIALS_DIRECTORY: directory }), proxyToken);
  assert.equal(panelServerInternals.internalProxyToken({ CREDENTIALS_DIRECTORY: 'relative' }), undefined);
  assert.equal(panelServerInternals.internalProxyToken({ CREDENTIALS_DIRECTORY: path.join(directory, 'missing') }), undefined);
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  return server.address().port;
}
async function close(server) {
  await new Promise((resolve, reject) => { server.close((error) => (error ? reject(error) : resolve())); server.closeAllConnections(); });
}
async function fixture(t, listener) {
  const upstream = http.createServer(listener);
  const upstreamPort = await listen(upstream);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-web-'));
  await writeFile(path.join(directory, 'index.html'), '<title>YunPanel</title>');
  const panel = createPanelServer({
    allowedClientIps: '203.0.113.8',
    apiPort: upstreamPort,
    proxyToken,
    publicOrigin: 'https://panel.example.com',
    webRoot: directory,
  });
  const panelPort = await listen(panel);
  t.after(async () => { await close(panel); await close(upstream); await rm(directory, { recursive: true, force: true }); });
  return {
    panelPort,
    upstream,
    request: (pathname, options = {}) => fetch(`http://127.0.0.1:${panelPort}${pathname}`, { ...options, headers: { 'x-real-ip': '203.0.113.8', ...options.headers } }),
  };
}

test('panel gateway keeps the IP restriction but never injects admin authorization', async (t) => {
  const requests = [];
  const app = await fixture(t, (request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      clientIp: request.headers['x-yunpanel-client-ip'],
      proxyToken: request.headers['x-yunpanel-proxy-token'],
    });
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}');
  });
  assert.equal((await app.request('/', { headers: { 'x-real-ip': '192.0.2.9' } })).status, 403);
  const page = await app.request('/settings');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /YunPanel/);
  assert.equal((await app.request('/api/panel/servers?active=true', { headers: {
    authorization: 'Bearer rejected-browser-value',
    cookie: '__Host-yunpanel_session=test-cookie',
    'x-yunpanel-client-ip': '192.0.2.55',
    'x-yunpanel-proxy-token': 'attacker-value',
  } })).status, 200);
  assert.deepEqual(requests[0], {
    method: 'GET',
    url: '/api/servers?active=true',
    authorization: undefined,
    cookie: '__Host-yunpanel_session=test-cookie',
    clientIp: '203.0.113.8',
    proxyToken,
  });
});

test('gateway exposes only the exact signed webhook path outside the panel IP allowlist', async (t) => {
  const requests = [];
  const app = await fixture(t, (request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      clientIp: request.headers['x-yunpanel-client-ip'],
      signature: request.headers['x-hub-signature-256'],
      origin: request.headers.origin,
    });
    response.writeHead(202, { 'content-type': 'application/json' });
    response.end('{"data":{"status":"queued"}}');
  });
  const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
  const response = await app.request(`/api/webhooks/github/${applicationId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-real-ip': '192.0.2.90',
      'x-github-delivery': '12345678-1234-4234-9234-123456789012',
      'x-github-event': 'push',
      'x-hub-signature-256': `sha256=${'a'.repeat(64)}`,
    },
    body: '{}',
  });
  assert.equal(response.status, 202);
  assert.deepEqual(requests, [{
    method: 'POST',
    url: `/api/webhooks/github/${applicationId}`,
    clientIp: '192.0.2.90',
    signature: `sha256=${'a'.repeat(64)}`,
    origin: undefined,
  }]);
  assert.equal((await app.request(`/api/webhooks/github/${applicationId}/extra`, {
    headers: { 'x-real-ip': '192.0.2.90' },
  })).status, 403);
});

test('gateway rejects spoofed or ambiguous forwarding chains before proxying', async (t) => {
  let requests = 0;
  const app = await fixture(t, (_request, response) => { requests += 1; response.end('{}'); });
  for (const headers of [
    { forwarded: 'for=203.0.113.8' },
    { 'x-forwarded-for': '203.0.113.8, 192.0.2.1' },
    { 'x-forwarded-for': '192.0.2.1' },
    { 'x-real-ip': 'not-an-ip' },
  ]) assert.equal((await app.request('/api/auth/session', { headers })).status, 403);
  assert.equal(requests, 0);
});

test('panel gateway rejects cross-origin and missing-origin mutations', async (t) => {
  let requests = 0;
  const app = await fixture(t, (_request, response) => { requests += 1; response.end('{}'); });
  for (const origin of [undefined, 'https://attacker.example']) {
    const response = await app.request('/api/panel/domains/domain-id/stage', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: '{}' });
    assert.equal(response.status, 403);
  }
  assert.equal(requests, 0);
});

test('auth proxy preserves cookies, CSRF headers and Set-Cookie responses', async (t) => {
  const requests = [];
  const app = await fixture(t, (request, response) => {
    requests.push(request);
    response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': '__Host-yunpanel_session=fixture; Path=/; Secure; HttpOnly; SameSite=Strict' });
    response.end('{"data":{}}');
  });
  const response = await app.request('/api/auth/session', { headers: { cookie: '__Host-yunpanel_session=fixture', 'x-csrf-token': 'fixture-csrf' } });
  assert.equal(response.status, 200);
  assert.equal(requests[0].url, '/api/auth/session');
  assert.equal(requests[0].headers.cookie, '__Host-yunpanel_session=fixture');
  assert.equal(requests[0].headers['x-csrf-token'], 'fixture-csrf');
  assert.equal(requests[0].headers.authorization, undefined);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
});

test('browser proxy does not expose agent transport or raw API routes', async (t) => {
  let requests = 0;
  const app = await fixture(t, (_request, response) => { requests += 1; response.end('{}'); });
  for (const pathname of ['/api/panel/servers/local/commands/next', '/api/panel/servers/enroll', '/api/panel/servers/local/applications/app/environment', '/api/servers', '/api/dev/servers']) {
    assert.equal((await app.request(pathname)).status, 404);
  }
  assert.equal(requests, 0);
});

test('IP-approved browser still needs login through the complete gateway/API chain', async (t) => {
  const { createAuthStore } = await import('../../api/src/auth-store.js');
  const { createAuthenticatedApi } = await import('../../api/src/auth-http.js');
  const { randomBytes } = await import('node:crypto');
  const { createRequire } = await import('node:module');
  const { TOTP } = createRequire(new URL('../../api/package.json', import.meta.url))('otpauth');
  const now = 1_700_000_010_000;
  const store = createAuthStore({ filePath: ':memory:', masterKey: randomBytes(32), now: () => now });
  t.after(() => store.close());
  const { token: setupToken } = store.issueSetupToken();
  const password = randomBytes(32).toString('base64url');
  await store.completeSetup({ setupToken, username: 'owner', password });
  const listener = createAuthenticatedApi({ store, proxyToken, publicOrigin: 'https://panel.example.com', createHandler: () => (_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); } });
  const app = await fixture(t, listener);
  assert.equal((await app.request('/api/panel/servers')).status, 401);
  const headers = { origin: 'https://panel.example.com', 'content-type': 'application/json' };
  const login = await app.request('/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ username: 'owner', password }) });
  assert.equal(login.status, 200);
  let cookie = login.headers.get('set-cookie').split(';')[0];
  let session = (await login.json()).data;
  assert.equal(session.security.enrollmentRequired, true);
  assert.equal((await app.request('/api/panel/servers', { headers: { cookie } })).status, 403);
  const ownHeaders = { ...headers, cookie, 'x-csrf-token': session.csrfToken };
  const enrollment = await app.request('/api/auth/mfa/enroll', { method: 'POST', headers: ownHeaders, body: JSON.stringify({ password }) });
  assert.equal(enrollment.status, 200);
  const { secret } = (await enrollment.json()).data;
  const confirm = await app.request('/api/auth/mfa/confirm', { method: 'POST', headers: ownHeaders, body: JSON.stringify({ code: new TOTP({ secret }).generate({ timestamp: now }) }) });
  assert.equal(confirm.status, 200);
  cookie = confirm.headers.getSetCookie()[0].split(';')[0];
  session = (await confirm.json()).data.session;
  assert.equal(session.security.managementAllowed, true);
  assert.equal((await app.request('/api/panel/servers', { headers: { cookie } })).status, 200);
  assert.equal((await app.request('/api/auth/logout', { method: 'POST', headers: { ...headers, cookie, 'x-csrf-token': session.csrfToken } })).status, 204);
  assert.equal((await app.request('/api/panel/servers', { headers: { cookie } })).status, 401);
});

test('terminal WebSocket upgrade preserves browser auth but replaces forwarding identity', async (t) => {
  const requests = [];
  const app = await fixture(t, (_request, response) => { response.writeHead(404); response.end(); });
  const upstreamWebSocket = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has('yunpanel-terminal-v1') ? 'yunpanel-terminal-v1' : false) });
  app.upstream.on('upgrade', (request, socket, head) => {
    requests.push(request.headers);
    upstreamWebSocket.handleUpgrade(request, socket, head, (websocket) => {
      websocket.on('message', (data) => websocket.send(data));
    });
  });
  t.after(() => upstreamWebSocket.close());

  const websocket = new WebSocket(`ws://127.0.0.1:${app.panelPort}/api/terminal`, [
    'yunpanel-terminal-v1', `yunpanel-terminal-capability.${'a'.repeat(43)}`,
  ], {
    headers: {
      origin: 'https://panel.example.com',
      cookie: '__Host-yunpanel_session=session-cookie',
      authorization: 'Bearer attacker-value',
      'x-real-ip': '203.0.113.8',
      'x-yunpanel-client-ip': '192.0.2.4',
      'x-yunpanel-proxy-token': 'attacker-value',
    },
  });
  await once(websocket, 'open');
  const echoed = once(websocket, 'message');
  websocket.send('terminal-frame');
  assert.equal((await echoed)[0].toString(), 'terminal-frame');
  assert.equal(websocket.protocol, 'yunpanel-terminal-v1');
  assert.equal(requests[0].cookie, '__Host-yunpanel_session=session-cookie');
  assert.equal(requests[0].authorization, undefined);
  assert.equal(requests[0]['x-yunpanel-client-ip'], '203.0.113.8');
  assert.equal(requests[0]['x-yunpanel-proxy-token'], proxyToken);
  websocket.close();
  await once(websocket, 'close');
});

test('terminal WebSocket gateway rejects wrong Origin, client IP, path and query before upstream', async (t) => {
  const app = await fixture(t, (_request, response) => { response.writeHead(404); response.end(); });
  let upgrades = 0;
  app.upstream.on('upgrade', (_request, socket) => { upgrades += 1; socket.destroy(); });

  async function rejected(pathname, headers, expected) {
    const websocket = new WebSocket(`ws://127.0.0.1:${app.panelPort}${pathname}`, ['yunpanel-terminal-v1'], { headers });
    websocket.on('error', () => {});
    const [, response] = await once(websocket, 'unexpected-response');
    assert.equal(response.statusCode, expected);
    response.resume();
  }
  await rejected('/api/terminal', { origin: 'https://attacker.example', 'x-real-ip': '203.0.113.8' }, 403);
  await rejected('/api/terminal', { origin: 'https://panel.example.com', 'x-real-ip': '192.0.2.9' }, 403);
  await rejected('/api/terminal/extra', { origin: 'https://panel.example.com', 'x-real-ip': '203.0.113.8' }, 404);
  await rejected('/api/terminal?token=forbidden', { origin: 'https://panel.example.com', 'x-real-ip': '203.0.113.8' }, 404);
  assert.equal(upgrades, 0);
});


test('phpMyAdmin gateway authenticates Owner access before proxying the vendor Unix socket', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-phpmyadmin-web-'));
  const socketPath = path.join(directory, 'phpmyadmin.sock');
  const vendorRequests = [];
  const vendor = http.createServer((request, response) => {
    vendorRequests.push({
      method: request.method,
      url: request.url,
      host: request.headers.host,
      cookie: request.headers.cookie,
      internalToken: request.headers['x-yunpanel-proxy-token'],
      forwardedPrefix: request.headers['x-forwarded-prefix'],
      forwardedProto: request.headers['x-forwarded-proto'],
    });
    response.writeHead(302, {
      location: '/index.php?route=/database/structure',
      'set-cookie': 'phpMyAdmin=fixture; Path=/; Secure; HttpOnly',
      'content-type': 'text/plain',
    });
    response.end('redirect');
  });
  vendor.listen(socketPath);
  await once(vendor, 'listening');

  const accessRequests = [];
  const api = http.createServer((request, response) => {
    accessRequests.push({
      method: request.method,
      url: request.url,
      cookie: request.headers.cookie,
      proxyToken: request.headers['x-yunpanel-proxy-token'],
      clientIp: request.headers['x-yunpanel-client-ip'],
    });
    if (request.url !== '/api/phpmyadmin-gateway-access') {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(request.headers.cookie === '__Host-yunpanel_session=owner' ? 204 : 403, {
      'cache-control': 'no-store',
    });
    response.end();
  });
  const apiPort = await listen(api);
  const webRoot = path.join(directory, 'web');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(webRoot));
  await writeFile(path.join(webRoot, 'index.html'), '<title>YunPanel</title>');
  const panel = createPanelServer({
    allowedClientIps: '203.0.113.8',
    apiPort,
    proxyToken,
    publicOrigin: 'https://panel.example.com',
    phpMyAdminSocketPath: socketPath,
    webRoot,
  });
  const panelPort = await listen(panel);
  t.after(async () => {
    await close(panel);
    await close(api);
    await new Promise((resolve) => vendor.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const response = await fetch(
    `http://127.0.0.1:${panelPort}/tools/phpmyadmin/index.php?route=/sql`,
    {
      redirect: 'manual',
      headers: {
        'x-real-ip': '203.0.113.8',
        cookie: '__Host-yunpanel_session=owner',
      },
    },
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/tools/phpmyadmin/index.php?route=/database/structure');
  assert.match(response.headers.get('set-cookie'), /Path=\/tools\/phpmyadmin\//);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.deepEqual(accessRequests, [{
    method: 'GET',
    url: '/api/phpmyadmin-gateway-access',
    cookie: '__Host-yunpanel_session=owner',
    proxyToken,
    clientIp: '203.0.113.8',
  }]);
  assert.deepEqual(vendorRequests, [{
    method: 'GET',
    url: '/index.php?route=/sql',
    host: 'panel.example.com',
    cookie: '__Host-yunpanel_session=owner',
    internalToken: undefined,
    forwardedPrefix: '/tools/phpmyadmin/',
    forwardedProto: 'https',
  }]);
});

test('phpMyAdmin vendor socket is not reached for unauthenticated or cross-origin browser requests', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-phpmyadmin-web-deny-'));
  const socketPath = path.join(directory, 'phpmyadmin.sock');
  let vendorRequests = 0;
  const vendor = http.createServer((_request, response) => {
    vendorRequests += 1;
    response.end('vendor');
  });
  vendor.listen(socketPath);
  await once(vendor, 'listening');

  const api = http.createServer((request, response) => {
    const cookies = request.headers.cookie?.split(';').map((value) => value.trim()) ?? [];
    response.writeHead(cookies.includes('__Host-yunpanel_session=owner') ? 204 : 403);
    response.end();
  });
  const apiPort = await listen(api);
  const webRoot = path.join(directory, 'web');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(webRoot));
  await writeFile(path.join(webRoot, 'index.html'), '<title>YunPanel</title>');
  const panel = createPanelServer({
    allowedClientIps: '203.0.113.8',
    apiPort,
    proxyToken,
    publicOrigin: 'https://panel.example.com',
    phpMyAdminSocketPath: socketPath,
    webRoot,
  });
  const panelPort = await listen(panel);
  t.after(async () => {
    await close(panel);
    await close(api);
    await new Promise((resolve) => vendor.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${panelPort}/tools/phpmyadmin/index.php`;
  const denied = await fetch(url, {
    headers: { 'x-real-ip': '203.0.113.8' },
  });
  assert.equal(denied.status, 403);

  const crossOrigin = await fetch(url, {
    method: 'POST',
    headers: {
      'x-real-ip': '203.0.113.8',
      cookie: '__Host-yunpanel_session=owner',
      origin: 'https://attacker.example',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'token=ignored',
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(vendorRequests, 0);
});

test('phpMyAdmin gateway canonicalizes the trailing slash without touching the vendor socket', async (t) => {
  const app = await fixture(t, (_request, response) => {
    response.writeHead(500);
    response.end();
  });
  const response = await app.request('/tools/phpmyadmin?db=test', { redirect: 'manual' });
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), '/tools/phpmyadmin/?db=test');
});


test('elFinder gateway consumes a fragment handoff once and injects only server-verified Website identity', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-elfinder-web-'));
  const gatewaySocketPath = path.join(directory, 'elfinder-http.sock');
  const handoffSocketPath = path.join(directory, 'elfinder-handoff.sock');
  const applicationId = '22345678-1234-4234-8234-123456789012';
  const websiteId = '12345678-1234-4234-8234-123456789012';
  const serverId = '32345678-1234-4234-8234-123456789012';
  const unixUser = `yunapp-${createHash('sha256').update(applicationId).digest('hex').slice(0, 12)}`;
  const capability = 'c'.repeat(43);
  const handoffRequests = [];

  const handoff = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      handoffRequests.push({
        method: request.method,
        url: request.url,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        data: {
          version: 1,
          protocol: 'yunpanel-elfinder-handoff-v1',
          audience: 'elfinder',
          serverId,
          websiteId,
          websiteRevision: 7,
          applicationId,
          unixUser,
          root: `/var/lib/yunpanel/data/${applicationId}`,
          expiresAt: Date.now() + 30_000,
        },
      }));
    });
  });
  handoff.listen(handoffSocketPath);
  await once(handoff, 'listening');

  const vendorRequests = [];
  const gateway = http.createServer((request, response) => {
    vendorRequests.push({
      method: request.method,
      url: request.url,
      unixUser: request.headers['x-yunpanel-elfinder-unix-user'],
      websiteId: request.headers['x-yunpanel-elfinder-website-id'],
      applicationId: request.headers['x-yunpanel-elfinder-application-id'],
      cookie: request.headers.cookie,
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  gateway.listen(gatewaySocketPath);
  await once(gateway, 'listening');

  const accessRequests = [];
  const api = http.createServer((request, response) => {
    accessRequests.push({
      url: request.url,
      cookie: request.headers.cookie,
      proxyToken: request.headers['x-yunpanel-proxy-token'],
      clientIp: request.headers['x-yunpanel-client-ip'],
    });
    if (request.url !== '/api/elfinder-gateway-access') {
      response.writeHead(404);
      response.end();
      return;
    }
    const cookies = request.headers.cookie?.split(';').map((value) => value.trim()) ?? [];
    response.writeHead(cookies.includes('__Host-yunpanel_session=owner') ? 204 : 403);
    response.end();
  });
  const apiPort = await listen(api);

  const webRoot = path.join(directory, 'web');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(webRoot));
  await writeFile(path.join(webRoot, 'index.html'), '<title>YunPanel</title>');

  const panel = createPanelServer({
    allowedClientIps: '203.0.113.8',
    apiPort,
    proxyToken,
    publicOrigin: 'https://panel.example.com',
    elFinderSocketPath: gatewaySocketPath,
    elFinderHandoffSocketPath: handoffSocketPath,
    webRoot,
  });
  const panelPort = await listen(panel);

  t.after(async () => {
    await close(panel);
    await close(api);
    await new Promise((resolve) => gateway.close(() => resolve()));
    await new Promise((resolve) => handoff.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const bootstrap = await fetch(
    `http://127.0.0.1:${panelPort}/tools/elfinder/__yunpanel/handoff`,
    {
      method: 'POST',
      headers: {
        'x-real-ip': '203.0.113.8',
        cookie: '__Host-yunpanel_session=owner',
        origin: 'https://panel.example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ capability }),
    },
  );
  assert.equal(bootstrap.status, 204);
  const setCookie = bootstrap.headers.get('set-cookie');
  assert.match(setCookie, /^__Secure-yunpanel_elfinder=[A-Za-z0-9_-]{43};/);
  assert.match(setCookie, /Path=\/tools\/elfinder\//);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Secure/);
  const toolCookie = setCookie.split(';')[0];

  assert.deepEqual(handoffRequests, [{
    method: 'POST',
    url: '/consume',
    body: { capability },
  }]);
  assert.equal(vendorRequests.length, 0);

  const connector = await fetch(
    `http://127.0.0.1:${panelPort}/tools/elfinder/connector.php`,
    {
      method: 'POST',
      headers: {
        'x-real-ip': '203.0.113.8',
        cookie: `__Host-yunpanel_session=owner; ${toolCookie}`,
        origin: 'https://panel.example.com',
        'content-type': 'application/x-www-form-urlencoded',
        'x-yunpanel-elfinder-unix-user': 'yunapp-ffffffffffff',
        'x-yunpanel-elfinder-website-id': 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        'x-yunpanel-elfinder-application-id': 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      },
      body: 'cmd=open&target=l1_Lw',
    },
  );
  assert.equal(connector.status, 200);
  assert.deepEqual(vendorRequests, [{
    method: 'POST',
    url: '/connector.php',
    unixUser,
    websiteId,
    applicationId,
    cookie: undefined,
  }]);

  const missingToolSession = await fetch(
    `http://127.0.0.1:${panelPort}/tools/elfinder/connector.php`,
    {
      method: 'POST',
      headers: {
        'x-real-ip': '203.0.113.8',
        cookie: '__Host-yunpanel_session=owner',
        origin: 'https://panel.example.com',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'cmd=open',
    },
  );
  assert.equal(missingToolSession.status, 401);
  assert.equal(vendorRequests.length, 1);

  const missingVendorSession = await fetch(
    `http://127.0.0.1:${panelPort}/tools/elfinder/vendor/js/elfinder.min.js`,
    {
      headers: {
        'x-real-ip': '203.0.113.8',
        cookie: '__Host-yunpanel_session=owner',
      },
    },
  );
  assert.equal(missingVendorSession.status, 401);
  assert.equal(vendorRequests.length, 1);

  const vendorAsset = await fetch(
    `http://127.0.0.1:${panelPort}/tools/elfinder/vendor/js/elfinder.min.js`,
    {
      headers: {
        'x-real-ip': '203.0.113.8',
        cookie: `__Host-yunpanel_session=owner; ${toolCookie}`,
      },
    },
  );
  assert.equal(vendorAsset.status, 200);
  assert.equal(vendorRequests.length, 2);
  assert.equal(vendorRequests[1].url, '/vendor/js/elfinder.min.js');
  assert.equal(vendorRequests[1].unixUser, undefined);
  assert.equal(vendorRequests[1].cookie, undefined);

  const wrongPanelSession = await fetch(
    `http://127.0.0.1:${panelPort}/tools/elfinder/connector.php`,
    {
      method: 'POST',
      headers: {
        'x-real-ip': '203.0.113.8',
        cookie: `__Host-yunpanel_session=other-owner; ${toolCookie}`,
        origin: 'https://panel.example.com',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'cmd=open',
    },
  );
  assert.equal(wrongPanelSession.status, 403);
  assert.equal(vendorRequests.length, 2);

  assert.ok(accessRequests.length >= 4);
  assert.ok(accessRequests.every((entry) => entry.url === '/api/elfinder-gateway-access'));
  assert.ok(accessRequests.every((entry) => entry.proxyToken === proxyToken));
  assert.ok(accessRequests.every((entry) => entry.clientIp === '203.0.113.8'));
});

test('elFinder gateway rejects query handoff, cross-origin bootstrap and direct connector access', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-elfinder-web-deny-'));
  const gatewaySocketPath = path.join(directory, 'elfinder-http.sock');
  const handoffSocketPath = path.join(directory, 'elfinder-handoff.sock');
  let gatewayRequests = 0;
  let handoffRequests = 0;

  const gateway = http.createServer((_request, response) => {
    gatewayRequests += 1;
    response.end('vendor');
  });
  gateway.listen(gatewaySocketPath);
  await once(gateway, 'listening');

  const handoff = http.createServer((_request, response) => {
    handoffRequests += 1;
    response.writeHead(500);
    response.end();
  });
  handoff.listen(handoffSocketPath);
  await once(handoff, 'listening');

  const api = http.createServer((request, response) => {
    response.writeHead(
      request.url === '/api/elfinder-gateway-access'
        && request.headers.cookie === '__Host-yunpanel_session=owner'
        ? 204 : 403,
    );
    response.end();
  });
  const apiPort = await listen(api);
  const webRoot = path.join(directory, 'web');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(webRoot));
  await writeFile(path.join(webRoot, 'index.html'), '<title>YunPanel</title>');
  const panel = createPanelServer({
    allowedClientIps: '203.0.113.8',
    apiPort,
    proxyToken,
    publicOrigin: 'https://panel.example.com',
    elFinderSocketPath: gatewaySocketPath,
    elFinderHandoffSocketPath: handoffSocketPath,
    webRoot,
  });
  const panelPort = await listen(panel);
  t.after(async () => {
    await close(panel);
    await close(api);
    await new Promise((resolve) => gateway.close(() => resolve()));
    await new Promise((resolve) => handoff.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const baseHeaders = {
    'x-real-ip': '203.0.113.8',
    cookie: '__Host-yunpanel_session=owner',
    'content-type': 'application/json',
  };
  assert.equal((await fetch(
    `http://127.0.0.1:${panelPort}/tools/elfinder/__yunpanel/handoff?capability=${'x'.repeat(43)}`,
    {
      method: 'POST',
      headers: { ...baseHeaders, origin: 'https://panel.example.com' },
      body: JSON.stringify({ capability: 'x'.repeat(43) }),
    },
  )).status, 400);
  assert.equal((await fetch(
    `http://127.0.0.1:${panelPort}/tools/elfinder/__yunpanel/handoff`,
    {
      method: 'POST',
      headers: { ...baseHeaders, origin: 'https://attacker.example' },
      body: JSON.stringify({ capability: 'x'.repeat(43) }),
    },
  )).status, 403);
  assert.equal((await fetch(
    `http://127.0.0.1:${panelPort}/tools/elfinder/connector.php`,
    {
      method: 'POST',
      headers: {
        'x-real-ip': '203.0.113.8',
        cookie: '__Host-yunpanel_session=owner',
        origin: 'https://panel.example.com',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'cmd=open',
    },
  )).status, 401);

  assert.equal(handoffRequests, 0);
  assert.equal(gatewayRequests, 0);
});

test('netdata gateway authenticates Owner access before proxying loopback HTTP', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-netdata-web-'));
  const netdataRequests = [];
  const netdataServer = http.createServer((request, response) => {
    netdataRequests.push({
      method: request.method,
      url: request.url,
      host: request.headers.host,
      cookie: request.headers.cookie,
      forwardedPrefix: request.headers['x-forwarded-prefix'],
      forwardedProto: request.headers['x-forwarded-proto'],
    });
    if (request.url === '/api/v1/info') {
      response.writeHead(302, {
        location: '/index.html',
        'set-cookie': 'netdata_session=fixture; Path=/; Secure; HttpOnly',
        'content-type': 'application/json',
      });
      response.end('{"version":"1.43.2"}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  const netdataPort = await listen(netdataServer);

  const accessRequests = [];
  const api = http.createServer((request, response) => {
    accessRequests.push({
      method: request.method,
      url: request.url,
      cookie: request.headers.cookie,
      proxyToken: request.headers['x-yunpanel-proxy-token'],
      clientIp: request.headers['x-yunpanel-client-ip'],
    });
    if (request.url !== '/api/netdata-gateway-access') {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(request.headers.cookie === '__Host-yunpanel_session=owner' ? 204 : 403, {
      'cache-control': 'no-store',
    });
    response.end();
  });
  const apiPort = await listen(api);
  const webRoot = path.join(directory, 'web');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(webRoot));
  await writeFile(path.join(webRoot, 'index.html'), '<title>YunPanel</title>');
  const panel = createPanelServer({
    allowedClientIps: '203.0.113.8',
    apiPort,
    proxyToken,
    publicOrigin: 'https://panel.example.com',
    netdataPort,
    webRoot,
  });
  const panelPort = await listen(panel);
  t.after(async () => {
    await close(panel);
    await close(api);
    await close(netdataServer);
    await rm(directory, { recursive: true, force: true });
  });

  // Canonicalize trailing slash
  const redirectResponse = await fetch(
    `http://127.0.0.1:${panelPort}/tools/netdata?chart=system.cpu`,
    {
      redirect: 'manual',
      headers: { 'x-real-ip': '203.0.113.8' },
    },
  );
  assert.equal(redirectResponse.status, 308);
  assert.equal(redirectResponse.headers.get('location'), '/tools/netdata/?chart=system.cpu');

  // Authenticated Owner request
  const response = await fetch(
    `http://127.0.0.1:${panelPort}/tools/netdata/api/v1/info`,
    {
      redirect: 'manual',
      headers: {
        'x-real-ip': '203.0.113.8',
        cookie: '__Host-yunpanel_session=owner',
      },
    },
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/tools/netdata/index.html');
  assert.match(response.headers.get('set-cookie'), /Path=\/tools\/netdata\//);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.deepEqual(accessRequests[0], {
    method: 'GET',
    url: '/api/netdata-gateway-access',
    cookie: '__Host-yunpanel_session=owner',
    proxyToken,
    clientIp: '203.0.113.8',
  });
  assert.deepEqual(netdataRequests[0], {
    method: 'GET',
    url: '/api/v1/info',
    host: 'panel.example.com',
    cookie: '__Host-yunpanel_session=owner',
    forwardedPrefix: '/tools/netdata/',
    forwardedProto: 'https',
  });

  // Unauthenticated request
  const unauth = await fetch(
    `http://127.0.0.1:${panelPort}/tools/netdata/api/v1/info`,
    {
      headers: { 'x-real-ip': '203.0.113.8' },
    },
  );
  assert.equal(unauth.status, 403);

  // Cross-origin mutation
  const crossOrigin = await fetch(
    `http://127.0.0.1:${panelPort}/tools/netdata/api/v1/data`,
    {
      method: 'POST',
      headers: {
        'x-real-ip': '203.0.113.8',
        cookie: '__Host-yunpanel_session=owner',
        origin: 'https://attacker.example',
      },
    },
  );
  assert.equal(crossOrigin.status, 403);
});

test('netdata gateway proxies WebSocket upgrade for live metrics', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-netdata-ws-'));
  const netdataServer = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  let netdataWsConnected = false;
  const netdataWs = new WebSocketServer({ noServer: true });
  netdataServer.on('upgrade', (request, socket, head) => {
    netdataWs.handleUpgrade(request, socket, head, (ws) => {
      netdataWsConnected = true;
      ws.send('netdata-metric-stream');
    });
  });
  const netdataPort = await listen(netdataServer);

  const api = http.createServer((request, response) => {
    response.writeHead(request.headers.cookie === '__Host-yunpanel_session=owner' ? 204 : 403);
    response.end();
  });
  const apiPort = await listen(api);
  const webRoot = path.join(directory, 'web');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(webRoot));
  await writeFile(path.join(webRoot, 'index.html'), '<title>YunPanel</title>');
  const panel = createPanelServer({
    allowedClientIps: '203.0.113.8',
    apiPort,
    proxyToken,
    publicOrigin: 'https://panel.example.com',
    netdataPort,
    webRoot,
  });
  const panelPort = await listen(panel);
  t.after(async () => {
    netdataWs.close();
    await close(panel);
    await close(api);
    await close(netdataServer);
    await rm(directory, { recursive: true, force: true });
  });

  // Successful authenticated WebSocket upgrade
  const clientWs = new WebSocket(`ws://127.0.0.1:${panelPort}/tools/netdata/websocket`, {
    headers: {
      origin: 'https://panel.example.com',
      'x-real-ip': '203.0.113.8',
      cookie: '__Host-yunpanel_session=owner',
    },
  });
  await once(clientWs, 'open');
  const [message] = await once(clientWs, 'message');
  assert.equal(message.toString(), 'netdata-metric-stream');
  assert.equal(netdataWsConnected, true);
  clientWs.close();
  await once(clientWs, 'close');

  // Unauthenticated WebSocket upgrade rejected
  const unauthWs = new WebSocket(`ws://127.0.0.1:${panelPort}/tools/netdata/websocket`, {
    headers: {
      origin: 'https://panel.example.com',
      'x-real-ip': '203.0.113.8',
    },
  });
  unauthWs.on('error', () => {});
  const [, unauthResp] = await once(unauthWs, 'unexpected-response');
  assert.equal(unauthResp.statusCode, 403);
  unauthResp.resume();
});

test('goaccess gateway authenticates Owner access before serving HTML report with rewritten WebSocket URL', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-goaccess-report-'));
  const reportsDir = path.join(directory, 'reports');
  const socketDir = path.join(directory, 'sockets');
  await import('node:fs/promises').then(({ mkdir }) => Promise.all([
    mkdir(reportsDir, { recursive: true }),
    mkdir(socketDir, { recursive: true }),
  ]));

  const sampleHtml = '<!DOCTYPE html><html><head><title>GoAccess</title></head><body><script>var connection = {"url": "/tools/goaccess/site-1/ws", "port": 7890};</script><h1>Report</h1></body></html>';
  await writeFile(path.join(reportsDir, 'site-1.html'), sampleHtml, 'utf8');

  const accessRequests = [];
  const api = http.createServer((request, response) => {
    accessRequests.push({
      method: request.method,
      url: request.url,
      cookie: request.headers.cookie,
      proxyToken: request.headers['x-yunpanel-proxy-token'],
      clientIp: request.headers['x-yunpanel-client-ip'],
    });
    response.writeHead(request.headers.cookie === '__Host-yunpanel_session=owner' ? 204 : 403);
    response.end();
  });
  const apiPort = await listen(api);

  const webRoot = path.join(directory, 'web');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(webRoot));
  await writeFile(path.join(webRoot, 'index.html'), '<title>YunPanel</title>');

  const panel = createPanelServer({
    allowedClientIps: '203.0.113.8',
    apiPort,
    proxyToken,
    publicOrigin: 'https://panel.example.com',
    goaccessReportsRoot: reportsDir,
    goaccessSocketRoot: socketDir,
    webRoot,
  });
  const panelPort = await listen(panel);
  t.after(async () => {
    await close(panel);
    await close(api);
    await rm(directory, { recursive: true, force: true });
  });

  // Redirect /tools/goaccess -> /tools/goaccess/
  const redirectBase = await fetch(`http://127.0.0.1:${panelPort}/tools/goaccess`, {
    redirect: 'manual',
    headers: { 'x-real-ip': '203.0.113.8' },
  });
  assert.equal(redirectBase.status, 308);
  assert.equal(redirectBase.headers.get('location'), '/tools/goaccess/');

  // Redirect /tools/goaccess/site-1 -> /tools/goaccess/site-1/
  const redirectSite = await fetch(`http://127.0.0.1:${panelPort}/tools/goaccess/site-1?refresh=1`, {
    redirect: 'manual',
    headers: { 'x-real-ip': '203.0.113.8' },
  });
  assert.equal(redirectSite.status, 308);
  assert.equal(redirectSite.headers.get('location'), '/tools/goaccess/site-1/?refresh=1');

  // Unauthenticated request
  const unauth = await fetch(`http://127.0.0.1:${panelPort}/tools/goaccess/site-1/`, {
    headers: { 'x-real-ip': '203.0.113.8' },
  });
  assert.equal(unauth.status, 403);

  // Authenticated Owner request
  const response = await fetch(`http://127.0.0.1:${panelPort}/tools/goaccess/site-1/`, {
    headers: {
      'x-real-ip': '203.0.113.8',
      cookie: '__Host-yunpanel_session=owner',
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  const body = await response.text();
  assert.match(body, /var connection = \{"url": "wss:\/\/panel\.example\.com:443\/tools\/goaccess\/site-1\/ws", "port": 443\};/);
  assert.match(body, /<h1>Report<\/h1>/);

  // Non-existent report returns 404
  const notFound = await fetch(`http://127.0.0.1:${panelPort}/tools/goaccess/missing-site/`, {
    headers: {
      'x-real-ip': '203.0.113.8',
      cookie: '__Host-yunpanel_session=owner',
    },
  });
  assert.equal(notFound.status, 404);
});

test('goaccess gateway proxies WebSocket upgrade over Unix domain socket', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-goaccess-ws-'));
  const reportsDir = path.join(directory, 'reports');
  const socketDir = path.join(directory, 'sockets');
  await import('node:fs/promises').then(({ mkdir }) => Promise.all([
    mkdir(reportsDir, { recursive: true }),
    mkdir(socketDir, { recursive: true }),
  ]));

  const socketPath = path.join(socketDir, 'site-1.sock');
  let goaccessWsConnected = false;
  const goaccessWs = new WebSocketServer({ noServer: true });
  const daemonServer = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  daemonServer.on('upgrade', (request, socket, head) => {
    goaccessWs.handleUpgrade(request, socket, head, (ws) => {
      goaccessWsConnected = true;
      ws.send('goaccess-realtime-update');
    });
  });
  daemonServer.listen(socketPath);
  await once(daemonServer, 'listening');

  const api = http.createServer((request, response) => {
    response.writeHead(request.headers.cookie === '__Host-yunpanel_session=owner' ? 204 : 403);
    response.end();
  });
  const apiPort = await listen(api);

  const webRoot = path.join(directory, 'web');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(webRoot));
  await writeFile(path.join(webRoot, 'index.html'), '<title>YunPanel</title>');

  const panel = createPanelServer({
    allowedClientIps: '203.0.113.8',
    apiPort,
    proxyToken,
    publicOrigin: 'https://panel.example.com',
    goaccessReportsRoot: reportsDir,
    goaccessSocketRoot: socketDir,
    webRoot,
  });
  const panelPort = await listen(panel);
  t.after(async () => {
    goaccessWs.close();
    await close(panel);
    await close(api);
    await close(daemonServer);
    await rm(directory, { recursive: true, force: true });
  });

  // Successful authenticated WebSocket upgrade
  const clientWs = new WebSocket(`ws://127.0.0.1:${panelPort}/tools/goaccess/site-1/ws`, {
    headers: {
      origin: 'https://panel.example.com',
      'x-real-ip': '203.0.113.8',
      cookie: '__Host-yunpanel_session=owner',
    },
  });
  await once(clientWs, 'open');
  const [message] = await once(clientWs, 'message');
  assert.equal(message.toString(), 'goaccess-realtime-update');
  assert.equal(goaccessWsConnected, true);
  clientWs.close();
  await once(clientWs, 'close');

  // Unauthenticated WebSocket upgrade rejected
  const unauthWs = new WebSocket(`ws://127.0.0.1:${panelPort}/tools/goaccess/site-1/ws`, {
    headers: {
      origin: 'https://panel.example.com',
      'x-real-ip': '203.0.113.8',
    },
  });
  unauthWs.on('error', () => {});
  const [, unauthResp] = await once(unauthWs, 'unexpected-response');
  assert.equal(unauthResp.statusCode, 403);
  unauthResp.resume();
});


