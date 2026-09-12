import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { MailboxQuotaHttpError, mountMailboxQuotaRoutes } from '../src/mailbox-quota-http.js';
import { MailboxQuotaRegistryError } from '../src/mailbox-quota-registry.js';

const localServerId = randomUUID();
const remoteServerId = randomUUID();
const localWebDomain = { id: randomUUID(), serverId: localServerId };
const remoteWebDomain = { id: randomUUID(), serverId: remoteServerId };
const localMailDomain = {
  id: randomUUID(), webDomainId: localWebDomain.id, managementMode: 'local', status: 'enabled',
};
const remoteMailDomain = {
  id: randomUUID(), webDomainId: remoteWebDomain.id, managementMode: 'local', status: 'enabled',
};
const localMailbox = {
  id: randomUUID(), mailDomainId: localMailDomain.id, address: 'owner@example.com', enabled: true,
};
const remoteMailbox = {
  id: randomUUID(), mailDomainId: remoteMailDomain.id, address: 'owner@remote.example', enabled: true,
};
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

async function listen(t, auth, { domainEnabled = true, mailboxEnabled = true } = {}) {
  const calls = [];
  let policy = null;
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = auth; next(); });
  mountMailboxQuotaRoutes(app, {
    localServerId,
    mailboxRegistry: {
      async getMailbox(id) {
        if (id === localMailbox.id) return { ...localMailbox, enabled: mailboxEnabled };
        if (id === remoteMailbox.id) return remoteMailbox;
        return null;
      },
    },
    mailDomainRegistry: {
      async getMailDomain(id) {
        if (id === localMailDomain.id) return { ...localMailDomain, status: domainEnabled ? 'enabled' : 'disabled' };
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
    mailboxQuotaRegistry: {
      async getQuota(id) { calls.push(['get', id]); return policy; },
      async setQuota(id, input) {
        calls.push(['set', id, structuredClone(input)]);
        policy = { mailboxId: id, quotaBytes: input.quotaBytes, revision: 1 };
        return policy;
      },
      async clearQuota(id, input) {
        calls.push(['clear', id, structuredClone(input)]);
        policy = null;
      },
    },
    mailboxQuotaInspector: {
      async inspect(address) {
        calls.push(['usage', address]);
        return {
          version: 1,
          address,
          storageBytes: 1024,
          limitBytes: 10 * 1024,
          usagePercent: 10,
          source: 'doveadm_quota',
          sideEffects: false,
        };
      },
    },
  });
  app.use((error, _request, response, _next) => {
    const known = error instanceof MailboxQuotaRegistryError || error instanceof MailboxQuotaHttpError;
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

function mutation(base, path, method, body) {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('Owner manages quota policy without claiming host configuration side effects', async (t) => {
  const { base, calls } = await listen(t, owner);
  const set = await mutation(base, `/api/mailboxes/${localMailbox.id}/quota`, 'PUT', {
    expectedRevision: 0,
    quotaBytes: 104857600,
  });
  assert.equal(set.status, 200);
  const setBody = await set.json();
  assert.equal(setBody.data.quotaBytes, 104857600);
  assert.deepEqual(setBody.sideEffects, {
    mailConfigurationChanged: false,
    mailDataChanged: false,
    requiresConfigurationApply: true,
  });

  const get = await fetch(`${base}/api/mailboxes/${localMailbox.id}/quota`);
  assert.equal(get.status, 200);
  assert.equal((await get.json()).data.quotaBytes, 104857600);

  const clear = await mutation(base, `/api/mailboxes/${localMailbox.id}/quota`, 'DELETE', {
    expectedRevision: 1,
    confirmation: `clear-mailbox-quota:${localMailbox.id}`,
  });
  assert.equal(clear.status, 200);
  assert.equal((await clear.json()).data.quotaConfigured, false);
  assert.deepEqual(calls.map((entry) => entry[0]), ['set', 'get', 'clear']);
});

test('enabled local mailbox usage is read from the quota inspector', async (t) => {
  const { base, calls } = await listen(t, owner);
  const response = await fetch(`${base}/api/mailboxes/${localMailbox.id}/usage`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.storageBytes, 1024);
  assert.equal(body.data.limitBytes, 10240);
  assert.deepEqual(calls, [['usage', 'owner@example.com']]);
});

test('usage is unavailable while mailbox or mail domain is disabled', async (t) => {
  for (const options of [{ domainEnabled: false }, { mailboxEnabled: false }]) {
    const { base, calls } = await listen(t, owner, options);
    const response = await fetch(`${base}/api/mailboxes/${localMailbox.id}/usage`);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'mailbox_quota_usage_unavailable');
    assert.equal(calls.some(([name]) => name === 'usage'), false);
  }
});

test('remote mailbox is hidden and Read Only can read quota but cannot mutate policy', async (t) => {
  const ownerFixture = await listen(t, owner);
  const remote = await fetch(`${ownerFixture.base}/api/mailboxes/${remoteMailbox.id}/quota`);
  assert.equal(remote.status, 404);
  assert.equal((await remote.json()).error.code, 'mailbox_not_found');

  const readOnlyFixture = await listen(t, readOnly);
  assert.equal((await fetch(`${readOnlyFixture.base}/api/mailboxes/${localMailbox.id}/quota`)).status, 200);
  assert.equal((await fetch(`${readOnlyFixture.base}/api/mailboxes/${localMailbox.id}/usage`)).status, 200);
  const denied = await mutation(readOnlyFixture.base, `/api/mailboxes/${localMailbox.id}/quota`, 'PUT', {
    expectedRevision: 0,
    quotaBytes: 104857600,
  });
  assert.equal(denied.status, 403);
  assert.equal(readOnlyFixture.calls.some(([name]) => name === 'set'), false);
});
