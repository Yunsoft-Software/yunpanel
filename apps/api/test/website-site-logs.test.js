import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNginxLogReader } from '@yunpanel/host-runtime';
import { createApp } from '../src/app.js';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createWebsiteRegistry } from '../src/website-registry.js';
import { withPanelContext } from './helpers/panel-auth-fixture.js';

const customer = (websiteIds) => Object.freeze({
  user: Object.freeze({ id: 'customer-1', username: 'cust-user', role: 'customer', hosting: { kind: 'customer' }, websiteIds }),
  security: Object.freeze({ ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: true }),
  access: Object.freeze({ mode: 'site_management', permissions: Object.freeze(['sites.manage']) }),
});
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatNginxAccessDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const d = pad(date.getUTCDate());
  const m = MONTH_NAMES[date.getUTCMonth()];
  const y = date.getUTCFullYear();
  const h = pad(date.getUTCHours());
  const min = pad(date.getUTCMinutes());
  const s = pad(date.getUTCSeconds());
  return `${d}/${m}/${y}:${h}:${min}:${s} +0000`;
}

const line = (host, n, date = new Date(Date.now() - (60_000 * n))) =>
  `203.0.113.${n} - - [${formatNginxAccessDate(date)}] "GET /${host}-${n} HTTP/1.1" 200 10 "-" "curl"\n`;

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yp-site-logs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logs = path.join(directory, 'nginx');
  await import('node:fs/promises').then(fs => fs.mkdir(logs));
  const registry = createServerRegistry();
  const token = await registry.issueEnrollmentToken({ label: 'logs' });
  const serverId = (await registry.enrollServer({ token: token.token, hostname: 'logs-host' })).server.id;
  const applicationRegistry = createApplicationRegistry({ serverExists: async id => id === serverId });
  const websiteRegistry = createWebsiteRegistry({ serverExists: async id => id === serverId,
    getApplication: async id => applicationRegistry.getApplication(id), getDockerWorkload: async () => null });
  await websiteRegistry.init();
  const domainRegistry = createDomainRegistry({ filePath: path.join(directory, 'domains.json'), serverExists: async id => id === serverId,
    getWebsite: id => websiteRegistry.getWebsite(id) });
  const site = async (name, nginxSettings = {}) => {
    const applicationId = randomUUID();
    await applicationRegistry.createPhpApplication({ applicationId, serverId, name: `PHP ${name}` });
    const website = await websiteRegistry.createWebsite({ serverId, name, applicationId, runtimeType: 'php' });
    const domain = await domainRegistry.createDomain({ serverId, websiteId: website.id, primaryDomain: name, aliases: [`www.${name}`],
      targetType: 'php', target: { applicationId }, nginxSettings });
    return { website, domain };
  };
  const own = await site('own.example.test');
  const preferred = await site('pref.example.test', { preferredDomain: 'www.pref.example.test' });
  const other = await site('other.example.test');
  let context = customer([own.website.id, preferred.website.id]);
  const app = createApp({ environment: 'production', registry, websiteRegistry, applicationRegistry, domainRegistry,
    jobRegistry: createJobRegistry({ serverExists: async id => id === serverId }),
    nginxLogReader: createNginxLogReader({ logDirectory: logs }) });
  const server = http.createServer(withPanelContext(app, () => context)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (pathname) => { const response = await fetch(base + pathname); return { status: response.status, body: await response.json() }; };
  return { logs, own, preferred, other, get, setContext: value => { context = value; } };
}

test('a customer reads only the access log of their own site, never the server-wide nginx log', async (t) => {
  const f = await fixture(t);
  const recentDate = new Date(Date.now() - 60_000);
  const oldDate = new Date(Date.now() - (48 * 60 * 60 * 1_000));
  await writeFile(path.join(f.logs, 'access.log'), line('sunucu-geneli', 1, recentDate));
  await writeFile(path.join(f.logs, 'other.example.test.access.log'), line('baska-site', 2, recentDate));
  await writeFile(path.join(f.logs, 'own.example.test.access.log'),
    line('kendi-sitem-eski', 9, oldDate) + line('kendi-sitem', 3, recentDate)
  );
  const result = await f.get(`/api/websites/${f.own.website.id}/application/logs?kind=access&level=info`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.entries.map(entry => entry.message.match(/GET \/(\S+)/)[1]), ['kendi-sitem-3']);
  // The default request (no kind) is what the site page sends.
  const byDefault = await f.get(`/api/websites/${f.own.website.id}/application/logs?level=info`);
  assert.equal(JSON.stringify(byDefault.body).includes('sunucu-geneli'), false, 'server-wide log leaked to a customer');
  assert.deepEqual(byDefault.body.data.entries.map(entry => entry.message.match(/GET \/(\S+)/)[1]), ['kendi-sitem-3']);

  // Explicit since/until range queries can still retrieve historical logs outside the default 24h window
  const sinceIso = new Date(oldDate.getTime() - 60_000).toISOString();
  const untilIso = new Date(oldDate.getTime() + 60_000).toISOString();
  const explicitRange = await f.get(`/api/websites/${f.own.website.id}/application/logs?kind=access&level=info&since=${encodeURIComponent(sinceIso)}&until=${encodeURIComponent(untilIso)}`);
  assert.equal(explicitRange.status, 200);
  assert.deepEqual(explicitRange.body.data.entries.map(entry => entry.message.match(/GET \/(\S+)/)[1]), ['kendi-sitem-eski-9']);
});

test('the served hostname decides the file: a preferred www name reads www.<domain>.access.log', async (t) => {
  const f = await fixture(t);
  const now = Date.now();
  const since = new Date(now - 300_000).toISOString();
  const until = new Date(now + 60_000).toISOString();
  await writeFile(path.join(f.logs, 'pref.example.test.access.log'), line('eski-ad', 1));
  await writeFile(path.join(f.logs, 'www.pref.example.test.access.log'), line('tercih', 2));
  const result = await f.get(`/api/websites/${f.preferred.website.id}/application/logs?kind=access&level=info&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`);
  assert.deepEqual(result.body.data.entries.map(entry => entry.message.match(/GET \/(\S+)/)[1]), ['tercih-2']);
});

test('a Domain of another Website cannot be used to read its log', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.logs, 'other.example.test.access.log'), line('baska-site', 2));
  const result = await f.get(`/api/websites/${f.own.website.id}/application/logs?kind=access&level=info&domainId=${f.other.domain.id}`);
  assert.equal(result.status, 404);
  assert.equal(JSON.stringify(result.body).includes('baska-site'), false);
});

test('live follow starts at the end of the site log and then returns only new lines', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.logs, 'own.example.test.access.log');
  await writeFile(file, line('once', 1));
  const start = await f.get(`/api/websites/${f.own.website.id}/application/logs/follow?kind=access&level=info`);
  assert.equal(start.status, 200);
  assert.deepEqual(start.body.data.entries, []);
  await appendFile(file, line('sonra', 2));
  await appendFile(path.join(f.logs, 'access.log'), line('sunucu-geneli', 3));
  const next = await f.get(`/api/websites/${f.own.website.id}/application/logs/follow?kind=access&level=info&cursor=${encodeURIComponent(start.body.data.cursor)}`);
  assert.deepEqual(next.body.data.entries.map(entry => entry.message.match(/GET \/(\S+)/)[1]), ['sonra-2']);
});

test('an unknown Website returns 404 and never falls back to the server log', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.logs, 'access.log'), line('sunucu-geneli', 1));
  const result = await f.get(`/api/websites/${randomUUID()}/application/logs?kind=access&level=info`);
  assert.equal(JSON.stringify(result.body).includes('sunucu-geneli'), false);
  assert.notEqual(result.status, 200);
});
