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
const mailDomainId = randomUUID();
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
const key = Object.freeze({
  mailDomainId,
  domainName: 'example.com',
  selector: 'mail-2026',
  algorithm: 'rsa-sha256',
  publicKey: Buffer.alloc(256, 7).toString('base64'),
  revision: 3,
  createdAt: '2026-09-12T19:00:00.000Z',
  updatedAt: '2026-09-12T20:00:00.000Z',
});

async function listen(t, auth, {
  status = 'disabled',
  activeJobs = [],
  retirementSatisfied = true,
  retirementThrows = false,
} = {}) {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = auth; next(); });
  mountMailDkimRoutes(app, {
    localServerId: serverId,
    mailDomainRegistry: {
      async getMailDomain(id) {
        return id === mailDomainId ? {
          id: mailDomainId,
          webDomainId: webDomain.id,
          domainName: 'example.com',
          managementMode: 'local',
          status,
        } : null;
      },
    },
    domainRegistry: {
      async getDomain(id) { return id === webDomain.id ? webDomain : null; },
    },
    mailDkimRegistry: {
      async getKey(id) { calls.push(['get', id]); return id === mailDomainId ? key : null; },
      async createKey() { throw new Error('not used'); },
      async rotateKey() { throw new Error('not used'); },
      async deleteKey(id, input) {
        calls.push(['delete', id, structuredClone(input)]);
        return { mailDomainId: id, selector: key.selector, revision: key.revision, deleted: true };
      },
    },
    mailDkimConfigurationService: {
      async previewApply() { throw new Error('not used'); },
    },
    mailDkimRetirementInspector: {
      async inspect(input) {
        calls.push(['retirement', structuredClone(input)]);
        if (retirementThrows) throw new Error('fixture retirement failure');
        return { satisfied: retirementSatisfied, result: retirementSatisfied ? { retired: true } : null };
      },
    },
    jobRegistry: {
      async listJobs(filter) {
        calls.push(['listJobs', structuredClone(filter)]);
        return activeJobs.map((entry) => ({ ...entry }));
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

function remove(base) {
  return fetch(`${base}/api/mail-domains/${mailDomainId}/dkim`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: key.revision,
      confirmation: `delete-mail-dkim:${mailDomainId}:${key.selector}:${key.revision}`,
    }),
  });
}

test('Owner deletes private DKIM state only after disabled-domain live retirement is verified', async (t) => {
  const { base, calls } = await listen(t, owner);
  const response = await remove(base);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    data: { mailDomainId, selector: key.selector, revision: key.revision, deleted: true },
    sideEffects: {
      mailConfigurationChanged: false,
      mailDataChanged: false,
      requiresDnsDelete: true,
    },
  });
  assert.deepEqual(calls, [
    ['listJobs', { serverId }],
    ['get', mailDomainId],
    ['retirement', { domain: 'example.com', selector: 'mail-2026' }],
    ['delete', mailDomainId, {
      expectedRevision: 3,
      confirmation: `delete-mail-dkim:${mailDomainId}:mail-2026:3`,
    }],
  ]);
});

test('enabled domain and active managed mail jobs block DKIM delete before live evidence or state mutation', async (t) => {
  const enabled = await listen(t, owner, { status: 'enabled' });
  const enabledResponse = await remove(enabled.base);
  assert.equal(enabledResponse.status, 409);
  assert.equal((await enabledResponse.json()).error.code, 'mail_dkim_delete_domain_enabled');
  assert.deepEqual(enabled.calls, []);

  const busy = await listen(t, owner, {
    activeJobs: [{ operation: OPERATIONS.MAIL_DKIM_APPLY, status: 'running' }],
  });
  const busyResponse = await remove(busy.base);
  assert.equal(busyResponse.status, 409);
  assert.equal((await busyResponse.json()).error.code, 'mail_configuration_job_conflict');
  assert.deepEqual(busy.calls.map(([name]) => name), ['listJobs']);
});

test('missing or unavailable retirement evidence fails closed without deleting control-plane key state', async (t) => {
  const stale = await listen(t, owner, { retirementSatisfied: false });
  const staleResponse = await remove(stale.base);
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).error.code, 'mail_dkim_retirement_not_ready');
  assert.deepEqual(stale.calls.map(([name]) => name), ['listJobs', 'get', 'retirement']);

  const unavailable = await listen(t, owner, { retirementThrows: true });
  const unavailableResponse = await remove(unavailable.base);
  assert.equal(unavailableResponse.status, 503);
  assert.equal((await unavailableResponse.json()).error.code, 'mail_dkim_retirement_unavailable');
  assert.deepEqual(unavailable.calls.map(([name]) => name), ['listJobs', 'get', 'retirement']);
});

test('Read Only cannot delete DKIM key state', async (t) => {
  const { base, calls } = await listen(t, readOnly);
  const response = await remove(base);
  assert.equal(response.status, 403);
  assert.deepEqual(calls, []);
});
