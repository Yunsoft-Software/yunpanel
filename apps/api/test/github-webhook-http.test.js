import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createApplicationDeployQueue } from '../src/application-deploy-queue.js';
import { createApplicationEnvironmentRegistry } from '../src/application-environment-registry.js';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createGithubWebhookHandler } from '../src/github-webhook-http.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createServerRegistry } from '../src/server-registry.js';

const APPLICATION_ID = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const DELIVERY_ID = '12345678-1234-4234-9234-123456789012';
const SECRET = 'github-webhook-test-secret-with-entropy-123';
const COMMIT = 'a'.repeat(40);

function authStore() {
  return {
    configured: () => true,
    mfa: { enabled: () => true },
    getSession: () => null,
  };
}

function signedHeaders(body, overrides = {}) {
  return {
    'content-type': 'application/json',
    'x-github-delivery': DELIVERY_ID,
    'x-github-event': 'push',
    'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
    ...overrides,
  };
}

async function fixture(t) {
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'webhook-host' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'webhook-host' });
  const applicationRegistry = createApplicationRegistry({
    serverExists: async (serverId) => serverId === enrolled.server.id,
  });
  await applicationRegistry.createApplication({
    applicationId: APPLICATION_ID,
    serverId: enrolled.server.id,
    name: 'Webhook Static App',
    repositoryUrl: 'https://github.com/Yunsoft-Software/webhook-app',
    branch: 'main',
    build: { mode: 'none', outputDir: '.', healthFile: 'index.html' },
  });
  const applicationEnvironmentRegistry = createApplicationEnvironmentRegistry({
    masterKey: Buffer.alloc(32, 9),
    applicationExists: async (applicationId) => Boolean(await applicationRegistry.getApplication(applicationId)),
  });
  await applicationEnvironmentRegistry.setWebhookSecret({ applicationId: APPLICATION_ID, secret: SECRET });
  const jobRegistry = createJobRegistry();
  const queueApplicationDeploy = createApplicationDeployQueue({
    applicationRegistry, applicationEnvironmentRegistry, jobRegistry,
  });
  const listener = createAuthenticatedApi({
    store: authStore(),
    publicOrigin: 'https://panel.example.test',
    createHandler: () => (_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":{"code":"not_found"}}');
    },
    publicWebhookHandler: createGithubWebhookHandler({
      applicationRegistry, applicationEnvironmentRegistry, queueApplicationDeploy,
    }),
  });
  const server = http.createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return {
    applicationRegistry,
    jobRegistry,
    url: `http://127.0.0.1:${server.address().port}/api/webhooks/github/${APPLICATION_ID}`,
  };
}

async function send(url, payload, { headers = {}, method = 'POST' } = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const response = await fetch(url, { method, headers: signedHeaders(body, headers), body: method === 'POST' ? body : undefined });
  return { response, payload: await response.json() };
}

test('signed configured-branch push queues one immutable durable deployment and replays by delivery ID', async (t) => {
  const state = await fixture(t);
  const payload = {
    ref: 'refs/heads/main',
    after: COMMIT.toUpperCase(),
    deleted: false,
    repository: { full_name: 'yunsoft-software/WEBHOOK-app' },
  };
  const first = await send(state.url, payload);
  assert.equal(first.response.status, 202);
  assert.equal(first.payload.data.status, 'queued');
  assert.equal(first.payload.data.deliveryId, DELIVERY_ID);

  const duplicate = await send(state.url, payload);
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.payload.data.status, 'duplicate');
  assert.equal(duplicate.payload.data.job.id, first.payload.data.job.id);
  assert.equal((await state.jobRegistry.listJobs()).length, 1);

  const claimed = await state.jobRegistry.claimNext((await state.applicationRegistry.getApplication(APPLICATION_ID)).serverId);
  assert.deepEqual(claimed.envelope.payload.gitTarget, { kind: 'commit', value: COMMIT });
  assert.equal(JSON.stringify(await state.jobRegistry.listJobs()).includes(DELIVERY_ID), false);
});

test('different deliveries racing for one Application are serialized by the resource lock', async (t) => {
  const state = await fixture(t);
  const payload = JSON.stringify({
    ref: 'refs/heads/main', after: COMMIT, repository: { full_name: 'Yunsoft-Software/webhook-app' },
  });
  const secondDelivery = '23456789-2345-4345-a345-234567890123';
  const [first, second] = await Promise.all([
    fetch(state.url, { method: 'POST', headers: signedHeaders(payload), body: payload }),
    fetch(state.url, {
      method: 'POST', headers: signedHeaders(payload, { 'x-github-delivery': secondDelivery }), body: payload,
    }),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [202, 409]);
  assert.equal((await state.jobRegistry.listJobs()).length, 1);
});

test('signature, channel, repository and payload validation fail before deploy mutation', async (t) => {
  const state = await fixture(t);
  const payload = {
    ref: 'refs/heads/main', after: COMMIT, repository: { full_name: 'Yunsoft-Software/webhook-app' },
  };
  const wrongSignature = await send(state.url, payload, {
    headers: { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
  });
  assert.equal(wrongSignature.response.status, 401);
  assert.equal(wrongSignature.payload.error.code, 'github_webhook_signature_invalid');

  const cookie = await send(state.url, payload, { headers: { cookie: 'session=forbidden' } });
  assert.equal(cookie.response.status, 403);
  assert.equal(cookie.payload.error.code, 'webhook_channel_only');

  const wrongRepository = await send(state.url, { ...payload, repository: { full_name: 'other/repository' } });
  assert.equal(wrongRepository.response.status, 403);
  assert.equal(wrongRepository.payload.error.code, 'github_webhook_repository_mismatch');

  const invalidCommit = await send(state.url, { ...payload, after: 'short' });
  assert.equal(invalidCommit.response.status, 400);
  assert.equal(invalidCommit.payload.error.code, 'github_webhook_commit_invalid');
  assert.deepEqual(await state.jobRegistry.listJobs(), []);
});

test('signed non-push, unconfigured branch and deletion deliveries are explicit no-op responses', async (t) => {
  const state = await fixture(t);
  const base = { ref: 'refs/heads/main', after: COMMIT, repository: { full_name: 'Yunsoft-Software/webhook-app' } };
  const pingBody = JSON.stringify({ zen: 'keep it logically awesome' });
  const ping = await fetch(state.url, { method: 'POST', headers: signedHeaders(pingBody, { 'x-github-event': 'ping' }), body: pingBody });
  assert.equal(ping.status, 202);
  assert.equal((await ping.json()).data.reason, 'event_not_supported');

  const branch = await send(state.url, { ...base, ref: 'refs/heads/develop' });
  assert.equal(branch.response.status, 202);
  assert.equal(branch.payload.data.reason, 'branch_not_configured');

  const deleted = await send(state.url, { ...base, after: '0'.repeat(40), deleted: true });
  assert.equal(deleted.response.status, 202);
  assert.equal(deleted.payload.data.reason, 'branch_deleted');
  assert.deepEqual(await state.jobRegistry.listJobs(), []);
});

test('webhook route is exact and does not make ordinary management API anonymous', async (t) => {
  const state = await fixture(t);
  const base = state.url.replace(`/api/webhooks/github/${APPLICATION_ID}`, '');
  assert.equal((await fetch(`${base}/api/applications`)).status, 401);
  assert.equal((await fetch(`${state.url}/extra`, { method: 'POST' })).status, 401);
  const wrongMethod = await fetch(state.url);
  assert.equal(wrongMethod.status, 405);
  assert.equal((await wrongMethod.json()).error.code, 'method_not_allowed');
});
