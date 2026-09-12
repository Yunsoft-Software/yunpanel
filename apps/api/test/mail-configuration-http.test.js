import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { JobRegistryError } from '../src/job-registry.js';
import {
  MailConfigurationHttpError,
  mountMailConfigurationRoutes,
} from '../src/mail-configuration-http.js';

const localServerId = randomUUID();
const remoteServerId = randomUUID();
const localWebDomain = { id: randomUUID(), serverId: localServerId };
const remoteWebDomain = { id: randomUUID(), serverId: remoteServerId };
const localMailDomain = {
  id: randomUUID(), domainName: 'example.com', managementMode: 'local', webDomainId: localWebDomain.id,
};
const remoteMailDomain = {
  id: randomUUID(), domainName: 'remote.example', managementMode: 'local', webDomainId: remoteWebDomain.id,
};
const previewDigest = 'a'.repeat(64);
const configurationSha256 = 'b'.repeat(64);
const confirmation = `apply-mail-configuration:${localMailDomain.id}:${previewDigest}`;
const owner = Object.freeze({
  user: { role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});
const readOnly = Object.freeze({
  user: { role: 'read_only' },
  access: { mode: 'read_only', permissions: ['mailboxes.read'] },
  security: { managementAllowed: false },
});

function managedPreview() {
  return Object.freeze({
    version: 1,
    operation: 'mail_configuration_apply',
    mailDomainId: localMailDomain.id,
    expectedRevision: 1,
    currentStatus: 'disabled',
    desiredStatus: 'enabled',
    domains: ['example.com'],
    configurationSha256,
    blockers: [],
    previewDigest,
    confirmation,
    readyToApply: true,
    configuration: {
      version: 1,
      sha256: configurationSha256,
      counts: { domains: 1, mailboxes: 1, aliases: 0, accounts: 1 },
      artifactDigests: [],
      postfixParameters: [],
      validate: [],
      requirements: [],
      sideEffects: false,
    },
    sideEffects: false,
  });
}

async function listen(t, auth, { jobs = [], preview = managedPreview() } = {}) {
  const enqueued = [];
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = auth; next(); });
  mountMailConfigurationRoutes(app, {
    localServerId,
    mailConfigurationService: {
      async previewTransition(input) {
        assert.deepEqual(input, {
          mailDomainId: localMailDomain.id,
          expectedRevision: 1,
          status: 'enabled',
        });
        return preview;
      },
    },
    mailDomainRegistry: {
      async getMailDomain(id) {
        if (id === localMailDomain.id) return localMailDomain;
        if (id === remoteMailDomain.id) return remoteMailDomain;
        return null;
      },
    },
    domainRegistry: {
      async getDomain(id) {
        if (id === localWebDomain.id) return localWebDomain;
        if (id === remoteWebDomain.id) return remoteWebDomain;
        return null;
      },
    },
    jobRegistry: {
      async listJobs() { return jobs; },
      async enqueue(input) {
        enqueued.push(structuredClone(input));
        return { id: randomUUID(), status: 'queued', ...input };
      },
    },
  });
  app.use((error, _request, response, _next) => {
    const known = error instanceof MailConfigurationHttpError || error instanceof JobRegistryError;
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
  return { base: `http://127.0.0.1:${server.address().port}`, enqueued };
}

function request(base, pathname, body) {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('Owner previews and queues exact secret-free managed mail transition', async (t) => {
  const { base, enqueued } = await listen(t, owner);
  const previewResponse = await request(base, `/api/mail-domains/${localMailDomain.id}/config-preview`, {
    expectedRevision: 1,
    status: 'enabled',
  });
  assert.equal(previewResponse.status, 200);
  const previewBody = await previewResponse.json();
  assert.equal(previewBody.data.previewDigest, previewDigest);
  assert.equal(previewBody.data.configuration.sha256, configurationSha256);
  assert.doesNotMatch(JSON.stringify(previewBody), /password|argon2|ciphertext/i);

  const applyResponse = await request(base, `/api/mail-domains/${localMailDomain.id}/config-apply`, {
    expectedRevision: 1,
    status: 'enabled',
    previewDigest,
    configurationSha256,
    confirmation,
  });
  assert.equal(applyResponse.status, 202);
  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0], {
    serverId: localServerId,
    type: 'mail.config.apply',
    operation: 'mail.config.apply',
    payload: {
      mailDomainId: localMailDomain.id,
      expectedRevision: 1,
      desiredStatus: 'enabled',
      previewDigest,
      configurationSha256,
    },
    resourceType: 'mail_domain',
    resourceId: localMailDomain.id,
  });
  assert.doesNotMatch(JSON.stringify(enqueued), /confirmation|password|argon2|content/i);
});

test('managed mail apply rejects stale confirmation, concurrent apply and remote-server domain', async (t) => {
  const staleFixture = await listen(t, owner);
  const stale = await request(staleFixture.base, `/api/mail-domains/${localMailDomain.id}/config-apply`, {
    expectedRevision: 1,
    status: 'enabled',
    previewDigest,
    configurationSha256,
    confirmation: `apply-mail-configuration:${localMailDomain.id}:${'c'.repeat(64)}`,
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'mail_configuration_preview_stale');
  assert.equal(staleFixture.enqueued.length, 0);

  const conflictFixture = await listen(t, owner, {
    jobs: [{ operation: 'mail.config.apply', status: 'running' }],
  });
  const conflict = await request(conflictFixture.base, `/api/mail-domains/${localMailDomain.id}/config-apply`, {
    expectedRevision: 1,
    status: 'enabled',
    previewDigest,
    configurationSha256,
    confirmation,
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'mail_configuration_job_conflict');
  assert.equal(conflictFixture.enqueued.length, 0);

  const remoteFixture = await listen(t, owner);
  const remote = await request(remoteFixture.base, `/api/mail-domains/${remoteMailDomain.id}/config-preview`, {
    expectedRevision: 1,
    status: 'enabled',
  });
  assert.equal(remote.status, 404);
  assert.equal((await remote.json()).error.code, 'mail_domain_not_found');
});

test('Read Only cannot preview or apply managed mail mutations', async (t) => {
  const { base, enqueued } = await listen(t, readOnly);
  assert.equal((await request(base, `/api/mail-domains/${localMailDomain.id}/config-preview`, {
    expectedRevision: 1,
    status: 'enabled',
  })).status, 403);
  assert.equal((await request(base, `/api/mail-domains/${localMailDomain.id}/config-apply`, {
    expectedRevision: 1,
    status: 'enabled',
    previewDigest,
    configurationSha256,
    confirmation,
  })).status, 403);
  assert.equal(enqueued.length, 0);
});
