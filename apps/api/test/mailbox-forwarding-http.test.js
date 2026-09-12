import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { mountMailboxForwardingRoutes } from '../src/mailbox-forwarding-http.js';
import { MailboxForwardingRegistryError } from '../src/mailbox-forwarding-registry.js';

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

async function listen(t, auth) {
  const calls = [];
  let policy = null;
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = auth; next(); });
  mountMailboxForwardingRoutes(app, {
    localServerId,
    mailboxRegistry: {
      async getMailbox(id) {
        if (id === localMailbox.id) return localMailbox;
        if (id === remoteMailbox.id) return remoteMailbox;
        return null;
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
    mailboxForwardingRegistry: {
      async getForwarding(id) { calls.push(['get', id]); return policy; },
      async setForwarding(id, input) {
        calls.push(['set', id, structuredClone(input)]);
        policy = {
          mailboxId: id,
          mode: input.mode,
          destinations: [...input.destinations],
          enabled: input.enabled,
          revision: 1,
        };
        return policy;
      },
      async clearForwarding(id, input) {
        calls.push(['clear', id, structuredClone(input)]);
        policy = null;
      },
    },
  });
  app.use((error, _request, response, _next) => {
    const known = error instanceof MailboxForwardingRegistryError;
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

test('Owner manages forwarding policy without claiming host configuration side effects', async (t) => {
  const { base, calls } = await listen(t, owner);
  const set = await mutation(base, `/api/mailboxes/${localMailbox.id}/forwarding`, 'PUT', {
    expectedRevision: 0,
    mode: 'copy',
    destinations: ['backup@elsewhere.test'],
    enabled: true,
  });
  assert.equal(set.status, 200);
  const setBody = await set.json();
  assert.equal(setBody.data.mode, 'copy');
  assert.deepEqual(setBody.data.destinations, ['backup@elsewhere.test']);
  assert.deepEqual(setBody.sideEffects, {
    mailConfigurationChanged: false,
    mailDataChanged: false,
    requiresConfigurationApply: true,
  });

  const get = await fetch(`${base}/api/mailboxes/${localMailbox.id}/forwarding`);
  assert.equal(get.status, 200);
  assert.equal((await get.json()).data.enabled, true);

  const clear = await mutation(base, `/api/mailboxes/${localMailbox.id}/forwarding`, 'DELETE', {
    expectedRevision: 1,
    confirmation: `clear-mailbox-forwarding:${localMailbox.id}`,
  });
  assert.equal(clear.status, 200);
  assert.equal((await clear.json()).data.forwardingConfigured, false);
  assert.deepEqual(calls.map((entry) => entry[0]), ['set', 'get', 'clear']);
});

test('forwarding request bodies are exact and do not reach registry on extra fields', async (t) => {
  const { base, calls } = await listen(t, owner);
  const response = await mutation(base, `/api/mailboxes/${localMailbox.id}/forwarding`, 'PUT', {
    expectedRevision: 0,
    mode: 'copy',
    destinations: ['backup@elsewhere.test'],
    enabled: true,
    arbitrary: true,
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'mailbox_forwarding_set_input_invalid');
  assert.equal(calls.some(([name]) => name === 'set'), false);
});

test('remote mailbox is hidden and Read Only can GET but cannot mutate forwarding policy', async (t) => {
  const ownerFixture = await listen(t, owner);
  const remote = await fetch(`${ownerFixture.base}/api/mailboxes/${remoteMailbox.id}/forwarding`);
  assert.equal(remote.status, 404);
  assert.equal((await remote.json()).error.code, 'mailbox_not_found');

  const readOnlyFixture = await listen(t, readOnly);
  assert.equal((await fetch(`${readOnlyFixture.base}/api/mailboxes/${localMailbox.id}/forwarding`)).status, 200);
  const denied = await mutation(readOnlyFixture.base, `/api/mailboxes/${localMailbox.id}/forwarding`, 'PUT', {
    expectedRevision: 0,
    mode: 'redirect',
    destinations: ['archive@elsewhere.test'],
    enabled: true,
  });
  assert.equal(denied.status, 403);
  assert.equal(readOnlyFixture.calls.some(([name]) => name === 'set'), false);
});
