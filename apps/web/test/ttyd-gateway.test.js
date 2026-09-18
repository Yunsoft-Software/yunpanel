import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { createPanelServer, panelServerInternals } from '../server.js';

const proxyToken = 'p'.repeat(43);
const sessionId = '12345678-1234-4234-8234-123456789012';
const origin = 'https://panel.example.com';

async function listenTcp(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function closeServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

test('ttyd path policy derives only exact UUID session sockets', () => {
  const root = '/run/yunpanel/ttyd';
  assert.deepEqual(
    panelServerInternals.parseTtydGatewayPath(`/tools/ttyd/${sessionId}/`),
    {
      sessionId,
      basePath: `/tools/ttyd/${sessionId}`,
      upstreamPath: `/tools/ttyd/${sessionId}/`,
    },
  );
  assert.equal(
    panelServerInternals.ttydSocketPath(root, sessionId),
    `${root}/${sessionId}.sock`,
  );
  for (const pathname of [
    '/tools/ttyd/',
    '/tools/ttyd/not-a-uuid/',
    `/tools/ttyd/${sessionId}/../other`,
    `/tools/ttyd/${sessionId}/%2e%2e/other`,
  ]) assert.equal(panelServerInternals.parseTtydGatewayPath(pathname), null);
  assert.equal(panelServerInternals.ttydSocketPath('/relative', sessionId), null);
  assert.equal(panelServerInternals.ttydSocketPath(root, 'not-a-uuid'), null);
});

test('ttyd HTTP gateway authorizes the path session and strips browser credentials before Unix proxy', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-ttyd-http-'));
  const socketRoot = path.join(directory, 'ttyd');
  const webRoot = path.join(directory, 'web');
  await mkdir(socketRoot);
  await mkdir(webRoot);
  await writeFile(path.join(webRoot, 'index.html'), '<title>YunPanel</title>');

  const accessRequests = [];
  const api = http.createServer((request, response) => {
    accessRequests.push({
      url: request.url,
      cookie: request.headers.cookie,
      toolSession: request.headers['x-yunpanel-tool-session'],
      transport: request.headers['x-yunpanel-tool-transport'],
      clientIp: request.headers['x-yunpanel-client-ip'],
      proxyToken: request.headers['x-yunpanel-proxy-token'],
    });
    const ok = request.url === '/api/ttyd-gateway-access'
      && request.headers.cookie === '__Host-yunpanel_session=owner'
      && request.headers['x-yunpanel-tool-session'] === sessionId
      && request.headers['x-yunpanel-proxy-token'] === proxyToken;
    response.writeHead(ok ? 204 : 403);
    response.end();
  });
  const apiPort = await listenTcp(api);

  const ttydRequests = [];
  const ttyd = http.createServer((request, response) => {
    ttydRequests.push({
      method: request.method,
      url: request.url,
      host: request.headers.host,
      origin: request.headers.origin,
      auth: request.headers['x-yunpanel-ttyd-auth'],
      cookie: request.headers.cookie,
      toolSession: request.headers['x-yunpanel-tool-session'],
      csrf: request.headers['x-csrf-token'],
    });
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<title>ttyd</title>');
  });
  const ttydSocket = path.join(socketRoot, `${sessionId}.sock`);
  ttyd.listen(ttydSocket);
  await once(ttyd, 'listening');

  const panel = createPanelServer({
    allowedClientIps: '203.0.113.8',
    apiPort,
    proxyToken,
    publicOrigin: origin,
    ttydSocketRoot: socketRoot,
    webRoot,
  });
  const panelPort = await listenTcp(panel);

  t.after(async () => {
    await closeServer(panel);
    await closeServer(api);
    await closeServer(ttyd);
    await rm(directory, { recursive: true, force: true });
  });

  const response = await fetch(
    `http://127.0.0.1:${panelPort}/tools/ttyd/${sessionId}/`,
    {
      headers: {
        'x-real-ip': '203.0.113.8',
        cookie: '__Host-yunpanel_session=owner',
        origin,
        'x-csrf-token': 'browser-csrf',
        'x-yunpanel-tool-session': 'browser-forged',
        'x-yunpanel-tool-transport': 'websocket',
        'x-yunpanel-ttyd-auth': 'browser-forged',
      },
    },
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /ttyd/);
  assert.deepEqual(accessRequests, [{
    url: '/api/ttyd-gateway-access',
    cookie: '__Host-yunpanel_session=owner',
    toolSession: sessionId,
    transport: 'http',
    clientIp: '203.0.113.8',
    proxyToken,
  }]);
  assert.deepEqual(ttydRequests, [{
    method: 'GET',
    url: `/tools/ttyd/${sessionId}/`,
    host: 'panel.example.com',
    origin,
    auth: 'owner',
    cookie: undefined,
    toolSession: undefined,
    csrf: undefined,
  }]);

  const denied = await fetch(
    `http://127.0.0.1:${panelPort}/tools/ttyd/${sessionId}/token`,
    {
      headers: {
        'x-real-ip': '203.0.113.8',
        cookie: '__Host-yunpanel_session=wrong',
        origin,
      },
    },
  );
  assert.equal(denied.status, 403);
  assert.equal(ttydRequests.length, 1);

  const malformed = await fetch(
    `http://127.0.0.1:${panelPort}/tools/ttyd/not-a-session/`,
    { headers: { 'x-real-ip': '203.0.113.8', cookie: '__Host-yunpanel_session=owner' } },
  );
  assert.equal(malformed.status, 404);
  assert.equal(ttydRequests.length, 1);
});

test('ttyd WebSocket gateway authenticates before upgrading the same private session socket', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-ttyd-ws-'));
  const socketRoot = path.join(directory, 'ttyd');
  const webRoot = path.join(directory, 'web');
  await mkdir(socketRoot);
  await mkdir(webRoot);
  await writeFile(path.join(webRoot, 'index.html'), '<title>YunPanel</title>');

  const apiCalls = [];
  const api = http.createServer((request, response) => {
    apiCalls.push({
      url: request.url,
      toolSession: request.headers['x-yunpanel-tool-session'],
      transport: request.headers['x-yunpanel-tool-transport'],
      cookie: request.headers.cookie,
    });
    const ok = request.url === '/api/ttyd-gateway-access'
      && request.headers['x-yunpanel-tool-session'] === sessionId
      && request.headers.cookie === '__Host-yunpanel_session=owner';
    response.writeHead(ok ? 204 : 403);
    response.end();
  });
  const apiPort = await listenTcp(api);

  const upgradeHeaders = [];
  const ttyd = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  ttyd.on('upgrade', (request, socket, head) => {
    upgradeHeaders.push({
      url: request.url,
      host: request.headers.host,
      origin: request.headers.origin,
      auth: request.headers['x-yunpanel-ttyd-auth'],
      cookie: request.headers.cookie,
      toolSession: request.headers['x-yunpanel-tool-session'],
    });
    wss.handleUpgrade(request, socket, head, (websocket) => {
      websocket.send('ttyd-ready');
      websocket.on('message', (message) => websocket.send(message));
    });
  });
  const ttydSocket = path.join(socketRoot, `${sessionId}.sock`);
  ttyd.listen(ttydSocket);
  await once(ttyd, 'listening');

  const panel = createPanelServer({
    allowedClientIps: '203.0.113.8',
    apiPort,
    proxyToken,
    publicOrigin: origin,
    ttydSocketRoot: socketRoot,
    webRoot,
  });
  const panelPort = await listenTcp(panel);

  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    await closeServer(panel);
    await closeServer(api);
    await closeServer(ttyd);
    await rm(directory, { recursive: true, force: true });
  });

  const websocket = new WebSocket(
    `ws://127.0.0.1:${panelPort}/tools/ttyd/${sessionId}/ws`,
    {
      headers: {
        origin,
        cookie: '__Host-yunpanel_session=owner',
        'x-real-ip': '203.0.113.8',
        'x-yunpanel-tool-session': 'browser-forged',
        'x-yunpanel-tool-transport': 'http',
        'x-yunpanel-ttyd-auth': 'browser-forged',
      },
    },
  );
  const ready = new Promise((resolve, reject) => {
    websocket.once('message', (message) => resolve(message.toString()));
    websocket.once('error', reject);
  });
  assert.equal(await ready, 'ttyd-ready');
  assert.deepEqual(apiCalls, [{
    url: '/api/ttyd-gateway-access',
    toolSession: sessionId,
    transport: 'websocket',
    cookie: '__Host-yunpanel_session=owner',
  }]);
  assert.deepEqual(upgradeHeaders, [{
    url: `/tools/ttyd/${sessionId}/ws`,
    host: 'panel.example.com',
    origin,
    auth: 'owner',
    cookie: undefined,
    toolSession: undefined,
  }]);

  const echo = new Promise((resolve, reject) => {
    websocket.once('message', (message) => resolve(message.toString()));
    websocket.once('error', reject);
  });
  websocket.send('ping');
  assert.equal(await echo, 'ping');
  websocket.close();
  await once(websocket, 'close');
});
