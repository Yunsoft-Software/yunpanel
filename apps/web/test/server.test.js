import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPanelServer } from '../server.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test('panel gateway restricts clients and injects admin authorization upstream', async () => {
  const upstreamRequests = [];
  const upstream = http.createServer((request, response) => {
    upstreamRequests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"data":[]}');
  });
  const upstreamPort = await listen(upstream);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-web-'));
  await writeFile(path.join(directory, 'index.html'), '<title>YunPanel</title>');
  const panel = createPanelServer({
    adminToken: 'private-admin-token',
    allowedClientIps: '203.0.113.8',
    apiPort: upstreamPort,
    publicOrigin: 'https://panel.example.com',
    webRoot: directory,
  });
  const panelPort = await listen(panel);

  try {
    const denied = await fetch(`http://127.0.0.1:${panelPort}/`, { headers: { 'x-real-ip': '192.0.2.9' } });
    assert.equal(denied.status, 403);

    const page = await fetch(`http://127.0.0.1:${panelPort}/settings`, { headers: { 'x-real-ip': '203.0.113.8' } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /YunPanel/);

    const api = await fetch(`http://127.0.0.1:${panelPort}/api/panel/servers?active=true`, {
      headers: { 'x-real-ip': '203.0.113.8' },
    });
    assert.equal(api.status, 200);
    assert.deepEqual(upstreamRequests[0], {
      method: 'GET',
      url: '/api/servers?active=true',
      authorization: 'Bearer private-admin-token',
    });
  } finally {
    await close(panel);
    await close(upstream);
    await rm(directory, { recursive: true, force: true });
  }
});

test('panel gateway rejects cross-origin mutations before they reach the API', async () => {
  let requests = 0;
  const upstream = http.createServer((request, response) => {
    requests += 1;
    response.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-web-'));
  await writeFile(path.join(directory, 'index.html'), '<title>YunPanel</title>');
  const panel = createPanelServer({
    adminToken: 'private-admin-token',
    allowedClientIps: '203.0.113.8',
    apiPort: upstreamPort,
    publicOrigin: 'https://panel.example.com',
    webRoot: directory,
  });
  const panelPort = await listen(panel);

  try {
    const response = await fetch(`http://127.0.0.1:${panelPort}/api/panel/domains/domain-id/stage`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://attacker.example',
        'x-real-ip': '203.0.113.8',
      },
      body: '{}',
    });
    assert.equal(response.status, 403);
    assert.equal(requests, 0);
  } finally {
    await close(panel);
    await close(upstream);
    await rm(directory, { recursive: true, force: true });
  }
});
