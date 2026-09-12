import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { JobRegistryError } from '../src/job-registry.js';
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
const publicKey = Buffer.alloc(256, 9).toString('base64');

async function listen(t, auth, { activeJobs = [] } = {}) {
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
      async rotateKey(id, input) {
        calls.push(['rotate', id, structuredClone(input)]);
        return {
          mailDomainId: id,
          domainName: mailDomain.domainName,
          selector: input.selector,
          algorithm: 'rsa-sha256',
          publicKey,
          dnsRecord: {
            type: 'TXT',
            name: `${input.selector}._domainkey.${mailDomain.domainName}`,
            value: `v=DKIM1; k=rsa; p=${publicKey}`,
          },
          revision: input.expectedRevision + 1,
          createdAt: '2026-09-12T19:00:00.000Z',
          updatedAt: '2026-09-12T20:00:00.000Z',
        };
      },
    },
    mailDkimConfigurationService: {
      async previewApply() { throw new Error('not used'); },
    },
    jobRegistry: {
      async listJobs(filter) {
        calls.push(['listJobs', structuredClone(filter)]);
        return activeJobs.map((job) => ({ ...job }));
      },
      async enqueue() { throw new Error('not used'); },
    },
  });
  app.use((error, _request, response, _next) => {
    const known = error instanceof MailDkimRegistryError
      || error instanceof MailDkimHttpError
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

function rotate(base, body) {
  return fetch(`${base}/api/mail-domains/${mailDomain.id}/dkim/rotate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('Owner rotates DKIM desired state only while managed mail jobs are idle', async (t) => {
  const { base, calls } = await listen(t, owner);
  const response = await rotate(base, { expectedRevision: 1, selector: 'mail-2026b' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.revision, 2);
  assert.equal(body.data.selector, 'mail-2026b');
  assert.deepEqual(body.sideEffects, {
    mailConfigurationChanged: false,
    mailDataChanged: false,
    requiresDnsPublish: true,
    requiresConfigurationApply: true,
  });
  assert.deepEqual(calls, [
    ['listJobs', { serverId }],
    ['rotate', mailDomain.id, { expectedRevision: 1, selector: 'mail-2026b' }],
  ]);
});

test('queued or running managed mail jobs block rotation before key generation', async (t) => {
  for (const status of ['queued', 'running']) {
    const { base, calls } = await listen(t, owner, {
      activeJobs: [{ operation: OPERATIONS.MAIL_DKIM_APPLY, status }],
    });
    const response = await rotate(base, { expectedRevision: 1, selector: 'mail-2026b' });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'mail_configuration_job_conflict');
    assert.deepEqual(calls.map(([name]) => name), ['listJobs']);
  }
});

test('Read Only cannot rotate DKIM keys', async (t) => {
  const { base, calls } = await listen(t, readOnly);
  const response = await rotate(base, { expectedRevision: 1, selector: 'mail-2026b' });
  assert.equal(response.status, 403);
  assert.deepEqual(calls, []);
});
