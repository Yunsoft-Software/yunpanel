import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { mountMailboxRoutes } from '../src/mailbox-http.js';
import { createMailboxRegistry, MailboxRegistryError } from '../src/mailbox-registry.js';
import { MailboxPasswordError } from '../src/mailbox-password.js';

const localDomain = Object.freeze({ id: randomUUID(), domainName: 'example.com', managementMode: 'local' });
const externalDomain = Object.freeze({ id: randomUUID(), domainName: 'external.example', managementMode: 'external' });
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

async function listen(t, auth, registry = null, scope = {}) {
  const domains = new Map([[localDomain.id, localDomain], [externalDomain.id, externalDomain]]);
  const mailboxRegistry = registry ?? createMailboxRegistry({
    masterKey: randomBytes(32),
    getMailDomain: async (id) => domains.get(id) ?? null,
  });
  await mailboxRegistry.init();
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = auth; next(); });
  mountMailboxRoutes(app, { mailboxRegistry, ...scope });
  app.use((error, _request, response, _next) => {
    const known = error instanceof MailboxRegistryError || error instanceof MailboxPasswordError;
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
  return { base: `http://127.0.0.1:${server.address().port}`, mailboxRegistry };
}

function request(base, pathname, { method = 'GET', body } = {}) {
  return fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('Owner manages only encrypted mailbox metadata without host side effects', async (t) => {
  const { base } = await listen(t, owner);
  const password = 'private mailbox password';
  const createdResponse = await request(base, '/api/mailboxes', {
    method: 'POST',
    body: { mailDomainId: localDomain.id, address: 'Owner@EXAMPLE.COM.', password },
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.data.address, 'owner@example.com');
  assert.equal(created.data.revision, 1);
  assert.deepEqual(created.sideEffects, { mailConfigurationChanged: false, mailDataChanged: false });
  assert.doesNotMatch(JSON.stringify(created), /private mailbox password|argon2id|ciphertext|passwordHash/);

  const listResponse = await request(base, `/api/mailboxes?mailDomainId=${localDomain.id}`);
  assert.equal(listResponse.status, 200);
  assert.deepEqual((await listResponse.json()).data, [created.data]);
  assert.equal((await request(base, `/api/mailboxes/${created.data.id}`)).status, 200);

  const stale = await request(base, `/api/mailboxes/${created.data.id}/password`, {
    method: 'POST', body: { expectedRevision: 2, password: 'replacement mailbox password' },
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'stale_mailbox_revision');
  const rotated = await request(base, `/api/mailboxes/${created.data.id}/password`, {
    method: 'POST', body: { expectedRevision: 1, password: 'replacement mailbox password' },
  });
  assert.equal(rotated.status, 200);
  assert.equal((await rotated.json()).data.revision, 2);
  const disabled = await request(base, `/api/mailboxes/${created.data.id}`, {
    method: 'PATCH', body: { expectedRevision: 2, enabled: false },
  });
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).data.enabled, false);

  const wrongConfirmation = await request(base, `/api/mailboxes/${created.data.id}`, {
    method: 'DELETE', body: { expectedRevision: 3, confirmation: 'delete-mailbox:wrong@example.com' },
  });
  assert.equal(wrongConfirmation.status, 409);
  const deleted = await request(base, `/api/mailboxes/${created.data.id}`, {
    method: 'DELETE', body: { expectedRevision: 3, confirmation: 'delete-mailbox:owner@example.com' },
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), {
    data: { id: created.data.id, deleted: true },
    sideEffects: { mailConfigurationChanged: false, mailDataChanged: false },
  });
  assert.deepEqual((await (await request(base, '/api/mailboxes')).json()).data, []);
});

test('mailbox HTTP rejects external domains, weak passwords, hidden fields and invalid queries', async (t) => {
  const { base } = await listen(t, owner);
  const external = await request(base, '/api/mailboxes', {
    method: 'POST',
    body: { mailDomainId: externalDomain.id, address: 'owner@external.example', password: 'valid mailbox password' },
  });
  assert.equal(external.status, 409);
  assert.equal((await external.json()).error.code, 'mail_domain_not_locally_managed');
  const weak = await request(base, '/api/mailboxes', {
    method: 'POST', body: { mailDomainId: localDomain.id, address: 'owner@example.com', password: 'short' },
  });
  assert.equal(weak.status, 400);
  assert.equal((await weak.json()).error.code, 'invalid_mailbox_password');
  assert.equal((await request(base, '/api/mailboxes', {
    method: 'POST',
    body: { mailDomainId: localDomain.id, address: 'owner@example.com', password: 'valid mailbox password', passwordHash: 'no' },
  })).status, 400);
  assert.equal((await request(base, '/api/mailboxes?mailDomainId=a&mailDomainId=b')).status, 400);
  assert.equal((await request(base, '/api/mailboxes/not-a-uuid')).status, 400);
});

test('Read Only may inspect mailbox metadata but cannot mutate it', async (t) => {
  const registry = createMailboxRegistry({
    masterKey: randomBytes(32),
    getMailDomain: async (id) => id === localDomain.id ? localDomain : null,
  });
  const created = await registry.createMailbox({
    mailDomainId: localDomain.id,
    address: 'reader@example.com',
    password: 'valid mailbox password',
  });
  const { base } = await listen(t, readOnly, registry);
  assert.equal((await request(base, '/api/mailboxes')).status, 200);
  assert.equal((await request(base, `/api/mailboxes/${created.id}`)).status, 200);
  assert.equal((await request(base, '/api/mailboxes', {
    method: 'POST',
    body: { mailDomainId: localDomain.id, address: 'blocked@example.com', password: 'valid mailbox password' },
  })).status, 403);
  assert.equal((await request(base, `/api/mailboxes/${created.id}`, {
    method: 'PATCH', body: { expectedRevision: 1, enabled: false },
  })).status, 403);
  assert.equal((await request(base, `/api/mailboxes/${created.id}`, {
    method: 'DELETE', body: { expectedRevision: 1, confirmation: 'delete-mailbox:reader@example.com' },
  })).status, 403);
});

test('local panel hides mailboxes whose mail Domain belongs to another Server', async (t) => {
  const localServerId = randomUUID();
  const remoteServerId = randomUUID();
  const localWebDomain = { id: randomUUID(), serverId: localServerId };
  const remoteWebDomain = { id: randomUUID(), serverId: remoteServerId };
  const localMailDomain = { id: randomUUID(), domainName: 'local.example', managementMode: 'local', webDomainId: localWebDomain.id };
  const remoteMailDomain = { id: randomUUID(), domainName: 'remote.example', managementMode: 'local', webDomainId: remoteWebDomain.id };
  const mailDomains = new Map([[localMailDomain.id, localMailDomain], [remoteMailDomain.id, remoteMailDomain]]);
  const webDomains = new Map([[localWebDomain.id, localWebDomain], [remoteWebDomain.id, remoteWebDomain]]);
  const registry = createMailboxRegistry({
    masterKey: randomBytes(32),
    getMailDomain: async (id) => mailDomains.get(id) ?? null,
  });
  const localMailbox = await registry.createMailbox({
    mailDomainId: localMailDomain.id, address: 'owner@local.example', password: 'valid mailbox password',
  });
  const remoteMailbox = await registry.createMailbox({
    mailDomainId: remoteMailDomain.id, address: 'owner@remote.example', password: 'valid mailbox password',
  });
  const { base } = await listen(t, owner, registry, {
    localServerId,
    mailDomainRegistry: { getMailDomain: async (id) => mailDomains.get(id) ?? null },
    domainRegistry: { getDomain: async (id) => webDomains.get(id) ?? null },
  });
  assert.deepEqual((await (await request(base, '/api/mailboxes')).json()).data.map((mailbox) => mailbox.id), [localMailbox.id]);
  assert.equal((await request(base, `/api/mailboxes/${remoteMailbox.id}`)).status, 404);
  assert.equal((await request(base, '/api/mailboxes', {
    method: 'POST',
    body: { mailDomainId: remoteMailDomain.id, address: 'second@remote.example', password: 'valid mailbox password' },
  })).status, 404);
});
