import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { JobRegistryError } from '../src/job-registry.js';
import { MailDkimConfigurationError } from '../src/mail-dkim-configuration.js';
import { MailDkimHttpError, mountMailDkimRoutes } from '../src/mail-dkim-http.js';
import { MailDkimRegistryError } from '../src/mail-dkim-registry.js';

const serverId = randomUUID();
const webDomain = { id: randomUUID(), serverId, primaryDomain: 'example.com' };
const mailDomain = {
  id: randomUUID(),
  webDomainId: webDomain.id,
  domainName: 'example.com',
  managementMode: 'local',
  status: 'enabled',
};
const previewDigest = 'a'.repeat(64);
const configurationSha256 = 'b'.repeat(64);
const confirmation = `apply-mail-dkim:${mailDomain.id}:${previewDigest}`;
const owner = Object.freeze({
  user: { role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});
const readOnly = Object.freeze({
  user: { role: 'read_only' },
  access: { mode: 'read_only', permissions: ['mail.read'] },
  security: { managementAllowed: false },
});

async function listen(t, auth, { ready = true, activeJobs = [] } = {}) {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = auth; next(); });
  mountMailDkimRoutes(app, {
    localServerId: serverId,
    mailDomainRegistry: {
      async getMailDomain(id) { return id === mailDomain.id ? mailDomain : null; },
    },
    domainRegistry: {
      async getDomain(id) { return id === webDomain.id ? webDomain : null; },
    },
    mailDkimRegistry: {
      async getKey() { return null; },
      async createKey() { throw new Error('not used'); },
    },
    mailDkimConfigurationService: {
      async previewApply(input) {
        calls.push(['preview', structuredClone(input)]);
        return {
          version: 1,
          mailDomainId: mailDomain.id,
          expectedKeyRevision: 1,
          previewDigest,
          confirmation,
          readyToApply: ready,
          blockers: ready ? [] : ['mail_dkim_dns_not_ready'],
          configuration: {
            version: 1,
            sha256: configurationSha256,
            artifactDigest: { path: '/etc/rspamd/local.d/dkim_signing.conf', sha256: 'c'.repeat(64) },
            domains: 1,
            sideEffects: false,
          },
          sideEffects: false,
        };
      },
    },
    jobRegistry: {
      async listJobs(filter) {
        calls.push(['listJobs', structuredClone(filter)]);
        return activeJobs.map((job) => ({ ...job }));
      },
      async enqueue(input) {
        calls.push(['enqueue', structuredClone(input)]);
        return { id: 'mail-dkim-job-001', status: 'queued', ...input };
      },
    },
  });
  app.use((error, _request, response, _next) => {
    const known = error instanceof MailDkimRegistryError
      || error instanceof MailDkimHttpError
      || error instanceof MailDkimConfigurationError
      || error instanceof JobRegistryError;
    return response.status(known ? error.status : 500).json({
      error: { code: known ? error.code : 'internal_error', message: known ? error.message : 'Unexpected error' },
    });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, calls };
}

function post(base, suffix, body) {
  return fetch(`${base}/api/mail-domains/${mailDomain.id}/dkim/${suffix}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('Owner previews and queues exact secret-free durable DKIM apply', async (t) => {
  const { base, calls } = await listen(t, owner);
  const previewResponse = await post(base, 'config-preview', { expectedKeyRevision: 1 });
  assert.equal(previewResponse.status, 200);
  const preview = (await previewResponse.json()).data;
  assert.equal(preview.readyToApply, true);
  assert.equal(preview.confirmation, confirmation);

  const apply = await post(base, 'config-apply', {
    expectedKeyRevision: 1,
    previewDigest,
    configurationSha256,
    confirmation,
  });
  assert.equal(apply.status, 202);
  const body = await apply.json();
  assert.equal(body.data.operation, OPERATIONS.MAIL_DKIM_APPLY);
  const enqueue = calls.find(([name]) => name === 'enqueue')[1];
  assert.deepEqual(enqueue.payload, {
    mailDomainId: mailDomain.id,
    expectedKeyRevision: 1,
    previewDigest,
    configurationSha256,
  });
  assert.equal(enqueue.resourceType, 'mail_domain');
  assert.equal(enqueue.resourceId, mailDomain.id);
  assert.doesNotMatch(JSON.stringify(enqueue), /PRIVATE KEY|privateKey|publicKey|selector/i);
});

test('stale confirmation, DNS blocker and concurrent mail mutation do not enqueue DKIM apply', async (t) => {
  const stale = await listen(t, owner);
  const staleResponse = await post(stale.base, 'config-apply', {
    expectedKeyRevision: 1,
    previewDigest,
    configurationSha256,
    confirmation: 'apply-mail-dkim:wrong',
  });
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).error.code, 'mail_dkim_preview_stale');
  assert.equal(stale.calls.some(([name]) => name === 'enqueue'), false);

  const blocked = await listen(t, owner, { ready: false });
  const blockedResponse = await post(blocked.base, 'config-apply', {
    expectedKeyRevision: 1,
    previewDigest,
    configurationSha256,
    confirmation,
  });
  assert.equal(blockedResponse.status, 409);
  assert.equal((await blockedResponse.json()).error.code, 'mail_dkim_not_ready');
  assert.equal(blocked.calls.some(([name]) => name === 'enqueue'), false);

  const conflict = await listen(t, owner, {
    activeJobs: [{ operation: OPERATIONS.MAIL_CONFIG_APPLY, status: 'running' }],
  });
  const conflictResponse = await post(conflict.base, 'config-apply', {
    expectedKeyRevision: 1,
    previewDigest,
    configurationSha256,
    confirmation,
  });
  assert.equal(conflictResponse.status, 409);
  assert.equal((await conflictResponse.json()).error.code, 'mail_configuration_job_conflict');
  assert.equal(conflict.calls.some(([name]) => name === 'enqueue'), false);
});

test('Read Only can inspect DKIM metadata but cannot preview or apply signing mutations', async (t) => {
  const { base, calls } = await listen(t, readOnly);
  const preview = await post(base, 'config-preview', { expectedKeyRevision: 1 });
  assert.equal(preview.status, 403);
  const apply = await post(base, 'config-apply', {
    expectedKeyRevision: 1,
    previewDigest,
    configurationSha256,
    confirmation,
  });
  assert.equal(apply.status, 403);
  assert.equal(calls.length, 0);
});
