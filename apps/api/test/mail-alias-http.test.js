import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { MailAliasRegistryError } from '../src/mail-alias-registry.js';
import { mountMailAliasRoutes } from '../src/mail-alias-http.js';

const localServerId = randomUUID();
const remoteServerId = randomUUID();
const localWebDomain = { id: randomUUID(), serverId: localServerId };
const remoteWebDomain = { id: randomUUID(), serverId: remoteServerId };
const localMailDomain = { id: randomUUID(), webDomainId: localWebDomain.id };
const remoteMailDomain = { id: randomUUID(), webDomainId: remoteWebDomain.id };
const localAliasId = randomUUID();
const remoteAliasId = randomUUID();
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

function alias(id, mailDomainId, source = 'info@example.com') {
  return {
    id,
    mailDomainId,
    source,
    destinations: ['owner@example.com'],
    enabled: true,
    revision: 1,
    createdAt: '2026-09-12T16:00:00.000Z',
    updatedAt: '2026-09-12T16:00:00.000Z',
  };
}

async function listen(t, auth) {
  const calls = [];
  const localAlias = alias(localAliasId, localMailDomain.id);
  const remoteAlias = alias(remoteAliasId, remoteMailDomain.id, 'remote@remote.example');
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = auth; next(); });
  mountMailAliasRoutes(app, {
    localServerId,
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
    mailAliasRegistry: {
      async listAliases({ mailDomainId = null } = {}) {
        return [localAlias, remoteAlias].filter((entry) => mailDomainId === null || entry.mailDomainId === mailDomainId);
      },
      async getAlias(id) {
        if (id === localAliasId) return localAlias;
        if (id === remoteAliasId) return remoteAlias;
        return null;
      },
      async createAlias(input) {
        calls.push(['create', structuredClone(input)]);
        return alias(randomUUID(), input.mailDomainId, input.source);
      },
      async updateAlias(id, input) {
        calls.push(['update', id, structuredClone(input)]);
        return { ...localAlias, ...input, id, revision: 2 };
      },
      async deleteAlias(id, input) {
        calls.push(['delete', id, structuredClone(input)]);
      },
    },
  });
  app.use((error, _request, response, _next) => {
    const known = error instanceof MailAliasRegistryError;
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

function mutation(base, pathname, method, body) {
  return fetch(`${base}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('Owner can list local aliases and create forwarding to an external address without host side effects', async (t) => {
  const { base, calls } = await listen(t, owner);
  const list = await fetch(`${base}/api/mail-aliases`);
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).data.map((entry) => entry.id), [localAliasId]);

  const created = await mutation(base, '/api/mail-aliases', 'POST', {
    mailDomainId: localMailDomain.id,
    source: 'sales@example.com',
    destinations: ['owner@example.com', 'external@elsewhere.test'],
  });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.deepEqual(body.sideEffects, { mailConfigurationChanged: false, mailDataChanged: false });
  assert.deepEqual(calls, [[
    'create',
    {
      mailDomainId: localMailDomain.id,
      source: 'sales@example.com',
      destinations: ['owner@example.com', 'external@elsewhere.test'],
    },
  ]]);
});

test('mail alias routes preserve optimistic revision update/delete contracts', async (t) => {
  const { base, calls } = await listen(t, owner);
  const updated = await mutation(base, `/api/mail-aliases/${localAliasId}`, 'PATCH', {
    expectedRevision: 1,
    destinations: ['external@elsewhere.test'],
    enabled: false,
  });
  assert.equal(updated.status, 200);
  const removed = await mutation(base, `/api/mail-aliases/${localAliasId}`, 'DELETE', {
    expectedRevision: 1,
    confirmation: 'delete-mail-alias:info@example.com',
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(calls, [
    ['update', localAliasId, { expectedRevision: 1, destinations: ['external@elsewhere.test'], enabled: false }],
    ['delete', localAliasId, { expectedRevision: 1, confirmation: 'delete-mail-alias:info@example.com' }],
  ]);
});

test('remote mail alias is hidden and Read Only can read but not mutate', async (t) => {
  const ownerFixture = await listen(t, owner);
  const remote = await fetch(`${ownerFixture.base}/api/mail-aliases/${remoteAliasId}`);
  assert.equal(remote.status, 404);
  assert.equal((await remote.json()).error.code, 'mail_domain_not_found');

  const readOnlyFixture = await listen(t, readOnly);
  const list = await fetch(`${readOnlyFixture.base}/api/mail-aliases`);
  assert.equal(list.status, 200);
  assert.equal((await list.json()).data.length, 1);
  const denied = await mutation(readOnlyFixture.base, '/api/mail-aliases', 'POST', {
    mailDomainId: localMailDomain.id,
    source: 'sales@example.com',
    destinations: ['owner@example.com'],
  });
  assert.equal(denied.status, 403);
  assert.equal(readOnlyFixture.calls.length, 0);
});
