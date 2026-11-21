import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createCrowdsecManager } from '@yunpanel/host-runtime';
import { createAuthenticatedApi } from '../../api/src/auth-http.js';
import { createAuthStore } from '../../api/src/auth-store.js';
import { mountFirewallRoutes } from '../../api/src/firewall-http.js';
import { createFirewallService } from '../../api/src/firewall-service.js';
import { createPanelServer } from '../server.js';
import {
  fetchFirewallStatus,
  fetchFirewallPorts,
  addFirewallPortRule,
  removeFirewallPortRule,
  fetchServiceProfiles,
  updateServiceProfiles,
  scanFirewallPort,
  fetchCrowdsecBans,
  addCrowdsecBan,
  removeCrowdsecBan,
} from '../src/workspace/firewall-client.js';
import { setSession } from '../src/session-client.js';

async function pickFreePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('Firewall client sends every request through /api/panel/firewall/* gateway to real FirewallService with real auth and CSRF', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-fw-client-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const store = createAuthStore({ filePath: path.join(dir, 'auth.sqlite') });
  t.after(() => store.close());
  const password = randomBytes(24).toString('base64url');
  await store.completeSetup({
    setupToken: store.issueSetupToken().token,
    username: 'admin',
    password,
  });

  // Real local TCP listener for real port reachability scanning
  const tcpTarget = net.createServer((socket) => socket.end());
  tcpTarget.listen(0, '127.0.0.1');
  await once(tcpTarget, 'listening');
  t.after(() => new Promise((resolve) => tcpTarget.close(resolve)));
  const tcpTargetPort = tcpTarget.address().port;

  // Real FirewallService with real missing cscli path (zero mocks, zero host firewall mutations)
  const missingCscliPath = path.join(dir, 'missing-cscli-secret-path');
  const firewallService = createFirewallService({
    crowdsecManager: createCrowdsecManager({ cscliPath: missingCscliPath }),
    localServerId: 'srv-local-01',
  });

  const proxyToken = 'p'.repeat(43);
  const webPort = await pickFreePort();
  const origin = `http://127.0.0.1:${webPort}`;

  const apiServer = http.createServer(createAuthenticatedApi({
    store,
    publicOrigin: origin,
    development: true,
    ownerMfaRequired: false,
    proxyToken,
    createHandler: () => {
      const app = express();
      app.use(express.json());
      mountFirewallRoutes(app, { firewallService, localServerId: 'srv-local-01' });
      return app;
    },
  }));
  apiServer.listen(0, '127.0.0.1');
  await once(apiServer, 'listening');
  t.after(() => new Promise((resolve) => { apiServer.close(resolve); apiServer.closeAllConnections?.(); }));

  const panelServer = createPanelServer({
    allowedClientIps: '127.0.0.1',
    apiHost: '127.0.0.1',
    apiPort: apiServer.address().port,
    proxyToken,
    publicOrigin: origin,
    webRoot: dir,
  });
  panelServer.listen(webPort, '127.0.0.1');
  await once(panelServer, 'listening');
  t.after(() => new Promise((resolve) => { panelServer.close(resolve); panelServer.closeAllConnections?.(); }));

  const realFetch = globalThis.fetch;
  const loginRes = await realFetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ username: 'admin', password }),
  });
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const sessionRes = await realFetch(`${origin}/api/auth/session`, { headers: { cookie } });
  const { data: sessionData } = await sessionRes.json();

  setSession({ csrfToken: sessionData.csrfToken });
  t.after(() => setSession(null));

  // Verify legacy /api/firewall/* returns 404 through the real panel gateway.
  const legacyRes = await realFetch(`${origin}/api/firewall/status`, { headers: { cookie } });
  assert.equal(legacyRes.status, 404);

  // Forward relative browser URLs to the real local panel gateway over real loopback HTTP.
  const seen = [];
  globalThis.fetch = (url, options = {}) => {
    seen.push({ url, method: options.method ?? 'GET', headers: options.headers ?? {} });
    const headers = { ...options.headers, cookie };
    if ((options.method ?? 'GET') !== 'GET') headers.origin = origin;
    return realFetch(`${origin}${url}`, { ...options, headers });
  };
  t.after(() => { globalThis.fetch = realFetch; });

  // 1. GET status (global and server-scoped)
  const status = await fetchFirewallStatus();
  assert.equal(typeof status.status, 'string');
  assert.equal(seen.at(-1).url, '/api/panel/firewall/status');

  const scopedStatus = await fetchFirewallStatus({ serverId: 'srv-local-01' });
  assert.equal(scopedStatus.serverId, 'srv-local-01');
  assert.equal(seen.at(-1).url, '/api/panel/servers/srv-local-01/firewall/status');

  // 2. GET ports & service-profiles
  const ports = await fetchFirewallPorts();
  assert.ok(Array.isArray(ports.ports));
  assert.equal(seen.at(-1).url, '/api/panel/firewall/ports');

  const profiles = await fetchServiceProfiles();
  assert.equal(profiles.serviceProfiles.localMail, false);
  assert.equal(profiles.serviceProfiles.authoritativeDns, false);
  assert.equal(seen.at(-1).url, '/api/panel/firewall/service-profiles');

  // 3. POST real TCP port scan against real bound 127.0.0.1 listener
  const scan = await scanFirewallPort({ host: '127.0.0.1', port: tcpTargetPort });
  assert.equal(scan.reachable, true);
  assert.equal(seen.at(-1).url, '/api/panel/firewall/scan');
  assert.equal(seen.at(-1).headers['x-csrf-token'], sessionData.csrfToken);

  // 4. GET bans -> real CrowdsecManagerError('decisions_list_failed') sanitized cleanly without path leak
  await assert.rejects(
    () => fetchCrowdsecBans(),
    (err) => err.status === 400
      && err.code === 'decisions_list_failed'
      && err.message === 'CrowdSec engelleme listesi alınamadı.'
      && !err.message.includes(missingCscliPath),
  );
  assert.equal(seen.at(-1).url, '/api/panel/firewall/bans');

  // 5. Guarded POST/PUT/DELETE mutations hit exact /api/panel/firewall/* URLs with real CSRF and backend validation (zero host firewall mutation)
  await assert.rejects(
    () => addFirewallPortRule({ port: 25, protocol: 'tcp', source: '0.0.0.0/0' }),
    (err) => err.status === 400 && err.code === 'service_profile_inactive',
  );
  assert.equal(seen.at(-1).url, '/api/panel/firewall/ports');
  assert.equal(seen.at(-1).method, 'POST');
  assert.equal(seen.at(-1).headers['x-csrf-token'], sessionData.csrfToken);

  await assert.rejects(
    () => removeFirewallPortRule({ port: 22, protocol: 'tcp' }),
    (err) => err.status === 400 && err.code === 'lockout_risk_detected',
  );
  assert.equal(seen.at(-1).url, '/api/panel/firewall/ports/22?protocol=tcp');
  assert.equal(seen.at(-1).method, 'DELETE');
  assert.equal(seen.at(-1).headers['x-csrf-token'], sessionData.csrfToken);

  await assert.rejects(
    () => updateServiceProfiles({ profiles: 'invalid' }),
    (err) => err.status === 400 && err.code === 'invalid_profiles',
  );
  assert.equal(seen.at(-1).url, '/api/panel/firewall/service-profiles');
  assert.equal(seen.at(-1).method, 'PUT');
  assert.equal(seen.at(-1).headers['x-csrf-token'], sessionData.csrfToken);

  await assert.rejects(
    () => addCrowdsecBan({ ip: 'not-an-ip', duration: '4h', reason: 'Test' }),
    (err) => err.status === 400 && err.code === 'invalid_ip',
  );
  assert.equal(seen.at(-1).url, '/api/panel/firewall/bans');
  assert.equal(seen.at(-1).method, 'POST');
  assert.equal(seen.at(-1).headers['x-csrf-token'], sessionData.csrfToken);

  await assert.rejects(
    () => removeCrowdsecBan({ id: 'abc' }),
    (err) => err.status === 400 && err.code === 'invalid_id',
  );
  assert.equal(seen.at(-1).url, '/api/panel/firewall/bans/abc');
  assert.equal(seen.at(-1).method, 'DELETE');
  assert.equal(seen.at(-1).headers['x-csrf-token'], sessionData.csrfToken);

  await assert.rejects(
    () => removeCrowdsecBan({ ip: 'not-an-ip' }),
    (err) => err.status === 400 && err.code === 'invalid_ip',
  );
  assert.equal(seen.at(-1).url, '/api/panel/firewall/unban');
  assert.equal(seen.at(-1).method, 'POST');
  assert.equal(seen.at(-1).headers['x-csrf-token'], sessionData.csrfToken);

  // Confirm zero legacy /api/firewall/* URLs were ever emitted by firewall-client.js
  assert.equal(seen.some((entry) => entry.url.startsWith('/api/firewall')), false);
});
