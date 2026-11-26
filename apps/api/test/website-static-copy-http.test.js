import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createWebsiteHttpHealthInspector } from '@yunpanel/host-runtime/website-http-health-inspector';
import { createAuthenticatedApi } from '../src/auth/auth-http.js';
import { createAuthStore } from '../src/auth/auth-store.js';
import { createDomainRegistry } from '../src/domains/domain-registry.js';
import { createDurableJobRegistry } from '../src/jobs/durable-job-registry.js';
import { createJobRegistry } from '../src/jobs/job-registry.js';
import { createSiteFileManager } from '../src/files/site-file-manager.js';
import { executeSiteFileOperation } from '../src/files/site-file-worker.js';
import { createSiteMutationLock } from '../src/websites/site-mutation-lock.js';
import { createStaticSiteCopyTransfer } from '../src/websites/static-site-copy-transfer.js';
import { mountWebsiteStaticCopyRoutes } from '../src/websites/website-static-copy-http.js';
import { createWebsiteStaticCopyService } from '../src/websites/website-static-copy-service.js';
import { staticSiteCopyFixture } from './fixtures/static-site-copy.js';

const origin = 'https://panel.static-copy.example.test';

async function listen(t, listener) {
  const server = http.createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t) {
  const data = await staticSiteCopyFixture(t);
  const { directory, source, target, server, servers, websiteRegistry, filesystem, planner, request } = data;
  const domainRegistry = createDomainRegistry({ filePath: path.join(directory, 'domains.json'),
    serverExists: async (serverId) => Boolean(await servers.getServer(serverId)),
    getWebsite: (websiteId) => websiteRegistry.getWebsite(websiteId) });
  const accountsFile = path.join(directory, 'accounts');
  await fs.writeFile(accountsFile, [source, target].map(({ site, evidence }) =>
    `${site.unixUser}:x:${evidence.unixUid}:${evidence.unixGid}::${directory}:/usr/sbin/nologin`).join('\n'));
  const files = createSiteFileManager({ websiteRegistry, localServerId: server.id, getuid: () => 0,
    readPasswd: () => fs.readFile(accountsFile, 'utf8'), statFn: filesystem.stat, realpathFn: filesystem.realpath,
    runWorker: ({ request: operation }) => executeSiteFileOperation(operation, filesystem) });
  const siteMutationLock = createSiteMutationLock({ root: path.join(directory, 'copy-locks') });
  const transfer = createStaticSiteCopyTransfer({ planner, siteFileManager: files, siteMutationLock });
  const auth = createAuthStore({ filePath: path.join(directory, 'auth.sqlite') });
  t.after(() => auth.close());
  const password = randomBytes(32).toString('base64url');
  await auth.completeSetup({ setupToken: auth.issueSetupToken().token, username: 'admin', password });

  const siteOrigin = await listen(t, async (request, response) => {
    if (request.url !== '/' || request.headers.host !== target.domain.primaryDomain) return response.writeHead(404).end();
    try { response.end(await fs.readFile(path.join(target.release, 'index.html'))); }
    catch (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500).end(); }
  });
  const healthInspector = createWebsiteHttpHealthInspector({ request: async ({ primaryDomain, healthPath, timeoutMs }) => {
    const statusCode = await new Promise((resolve, reject) => {
      const connection = http.get(new URL(healthPath, siteOrigin), { headers: { host: primaryDomain }, timeout: timeoutMs }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      connection.on('error', reject);
      connection.on('timeout', () => connection.destroy(new Error('Site request timed out')));
    });
    return { reachable: true, healthy: statusCode === 200, statusCode };
  } });
  function authorizeActor(actor, websiteId) {
    const current = auth.getSessionById(actor.sessionId);
    return current?.user.id === actor.userId && current.user.role === 'owner'
      && [source.site.id, target.site.id].includes(websiteId);
  }

  const jobFile = path.join(directory, 'jobs.json');
  const newRegistry = () => createDurableJobRegistry({ filePath: jobFile, registryFactory: createJobRegistry });
  const jobs = newRegistry();
  const createService = (registry) => createWebsiteStaticCopyService({ localServerId: server.id, planner, transfer, jobRegistry: registry,
    durableJobRegistry: registry, authorizeActor, domainRegistry, healthInspector });
  const service = createService(jobs);
  const app = express();
  app.use(express.json());
  mountWebsiteStaticCopyRoutes(app, { service });
  app.use((error, _request, response, _next) => response.status(error.status ?? 500).json({ error: { code: error.code } }));
  const panel = await listen(t, createAuthenticatedApi({ store: auth, publicOrigin: origin, ownerMfaRequired: false, createHandler: () => app }));
  async function send(url, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(`${panel}${url}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Origin: origin, 'Content-Type': 'application/json', ...headers } });
    return { status: response.status, headers: response.headers, ...(await response.json()) };
  }
  const login = await send('/api/auth/login', { method: 'POST', body: { username: 'admin', password } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const session = await send('/api/auth/session', { headers: { cookie } });
  assert.equal(session.status, 200);
  function call(url, body, { csrf = true } = {}) {
    return send(url, { method: body === undefined ? 'GET' : 'POST', body,
      headers: { cookie, ...(csrf ? { 'x-csrf-token': session.data.csrfToken } : {}) } });
  }
  const route = `/api/panel/websites/${source.site.id}/static-copy`;
  const targetInput = { targetWebsiteId: request.targetWebsiteId };
  async function applyTarget() {
    const current = await domainRegistry.getDomain(target.domain.id);
    const checksum = current.desiredRevision.toString(16).padStart(64, '0');
    await domainRegistry.markStaged(current.id, { expectedRevision: current.desiredRevision, checksum, configName: `${current.primaryDomain}.conf` });
    return domainRegistry.markApplied(current.id, { checksum });
  }
  async function intent() {
    const preview = await call(`${route}/preview`, targetInput);
    assert.equal(preview.status, 200);
    assert.equal(preview.data.files, 2);
    const { previewDigest, confirmation } = preview.data;
    return { ...targetInput, requestId: randomUUID(), previewDigest, confirmation };
  }
  return { ...data, call, send, service, jobs, route, targetInput, intent, newRegistry, createService, siteOrigin, domainRegistry, applyTarget };
}

test('authenticated static copy validates preview and submits exactly one durable job', async (t) => {
  const { source, target, server, call, send, jobs, service, route, targetInput, intent, siteOrigin, domainRegistry, applyTarget } = await fixture(t);
  assert.equal((await send(`${route}/preview`, { method: 'POST', body: targetInput })).status, 401);
  assert.equal((await call(`${route}/preview`, targetInput, { csrf: false })).status, 403);
  assert.equal((await call(`${route}/preview`, { targetWebsiteId: randomUUID() })).status, 403);
  assert.equal((await call(`${route}/preview`, targetInput)).error.code, 'static_copy_target_domain_unverified');
  await applyTarget();
  const request = await intent();
  const stale = await call(`${route}/requests`, { ...request, previewDigest: 'a'.repeat(64) });
  assert.equal(stale.status, 409);
  assert.equal(stale.error.code, 'static_copy_preview_stale');
  const queued = await call(`${route}/requests`, request);
  assert.equal(queued.status, 202);
  const job = queued.data.job;
  assert.equal((await call(`${route}/requests`, request)).data.job.id, job.id);
  assert.equal((await call(`${route}/requests`, { ...request, previewDigest: 'a'.repeat(64) })).error.code, 'static_copy_request_conflict');
  const claimed = await jobs.claimNext(server.id);
  assert.equal(claimed.job.id, job.id);
  const update = { domainId: target.domain.id, changes: { canonicalRedirect: true } };
  const { previewDigest } = await domainRegistry.previewDomainUpdate(update);
  const { domain: draft } = await domainRegistry.updateDomain({ ...update, previewDigest });
  assert.notEqual(draft.appliedRevision, draft.desiredRevision);
  const execution = { resourceType: 'application', resourceId: source.site.applicationId, serverId: server.id };
  await assert.rejects(service.execute(claimed.envelope.payload, execution), { code: 'static_copy_target_domain_unverified' });
  assert.deepEqual(await fs.readdir(target.release), []);
  await applyTarget();
  const result = await service.execute(claimed.envelope.payload, execution);
  await jobs.complete({ serverId: server.id, jobId: job.id, status: 'succeeded', result });
  const observed = (await call(`${route}/requests/${request.requestId}`)).data.job;
  assert.deepEqual(observed.result, { filesCopied: 2, bytesCopied: result.bytesCopied });
  assert.ok(!Object.hasOwn(observed, 'payload'));
  assert.equal((await call(`/api/panel/websites/${target.site.id}/static-copy/requests/${request.requestId}`)).status, 404);
  const fetched = await new Promise((resolve, reject) => http.get(siteOrigin, { headers: { host: target.domain.primaryDomain } }, (reply) => {
    const chunks = [];
    reply.on('data', (chunk) => chunks.push(chunk));
    reply.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    reply.on('error', reject);
  }).on('error', reject));
  assert.equal(fetched, '<h1>Kaynak</h1>');
});

test('startup resolves an interrupted copy without writing again or touching the target', async (t) => {
  const { target, server, call, jobs, route, intent, newRegistry, createService, applyTarget } = await fixture(t);
  await applyTarget();
  const request = await intent();
  const job = (await call(`${route}/requests`, request)).data.job;
  assert.equal((await jobs.claimNext(server.id)).job.id, job.id);
  const partial = path.join(target.release, 'partial.html');
  await fs.writeFile(partial, '<h1>Mevcut hedef</h1>');
  const reopened = newRegistry();
  await reopened.init();
  assert.equal(reopened.recovery().jobs[0].jobId, job.id);
  await createService(reopened).recoverStartup();
  assert.equal(reopened.recovery(), null);
  const stopped = await reopened.getJob(job.id);
  assert.equal(stopped.status, 'failed');
  assert.equal(stopped.error.code, 'static_copy_interrupted');
  assert.equal(await fs.readFile(partial, 'utf8'), '<h1>Mevcut hedef</h1>');
  assert.equal(await reopened.claimNext(server.id), null);
});
