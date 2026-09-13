import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { mountMailDomainDeleteRoute } from '../src/mail-domain-delete-http.js';
import { mountMailboxRoutes } from '../src/mailbox-http.js';

const mailboxId = randomUUID();
const mailDomainId = randomUUID();
const deleteJobId = randomUUID();
const owner = Object.freeze({
  user: { role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});

async function serverFor(t, mount) {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = owner; next(); });
  mount(app);
  app.use((error, _request, response, _next) => response.status(error.status ?? 500).json({
    error: { code: error.code ?? 'internal_error', message: error.message },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('local mailbox DELETE delegates exact terminal job identity to guarded finalizer', async (t) => {
  const calls = [];
  const base = await serverFor(t, (app) => mountMailboxRoutes(app, {
    localServerId: 'server-1',
    mailboxRegistry: {
      async getMailbox(id) {
        return id === mailboxId ? { id, mailDomainId, address: 'owner@example.com', revision: 3 } : null;
      },
      async createMailbox() {},
      async listMailboxes() { return []; },
      async rotatePassword() {},
      async setEnabled() {},
      async deleteMailbox() { throw new Error('registry delete must be owned by finalizer'); },
    },
    mailDomainRegistry: {
      async getMailDomain(id) { return id === mailDomainId ? { id, webDomainId: 'web-1' } : null; },
    },
    domainRegistry: {
      async getDomain(id) { return id === 'web-1' ? { id, serverId: 'server-1' } : null; },
    },
    mailDeleteFinalizeService: {
      async finalizeMailbox(input) {
        calls.push(structuredClone(input));
        return { id: input.mailboxId, deleted: true, deleteJobId: input.deleteJobId, backupId: 'backup-1' };
      },
    },
  }));

  const response = await fetch(`${base}/api/mailboxes/${mailboxId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: 3,
      deleteJobId,
      confirmation: 'delete-mailbox:owner@example.com',
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{
    mailboxId,
    expectedRevision: 3,
    deleteJobId,
    confirmation: 'delete-mailbox:owner@example.com',
  }]);
});

test('local mailbox routes fail startup without guarded deletion finalizer', () => {
  const app = express();
  assert.throws(() => mountMailboxRoutes(app, {
    localServerId: 'server-1',
    mailboxRegistry: {
      createMailbox() {}, listMailboxes() {}, getMailbox() {}, rotatePassword() {}, setEnabled() {}, deleteMailbox() {},
    },
    mailDomainRegistry: {},
    domainRegistry: {},
  }), /guarded mail data finalizer/);
});

test('mail-domain DELETE delegates to finalizer and rejects extra fields', async (t) => {
  const calls = [];
  const base = await serverFor(t, (app) => mountMailDomainDeleteRoute(app, {
    mailDeleteFinalizeService: {
      async finalizeMailDomain(input) {
        calls.push(structuredClone(input));
        return { id: input.mailDomainId, deleted: true, deleteJobId: input.deleteJobId, backupId: 'backup-1' };
      },
    },
  }));

  const ok = await fetch(`${base}/api/mail-domains/${mailDomainId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: 5,
      deleteJobId,
      confirmation: `delete-mail-domain:${mailDomainId}:5`,
    }),
  });
  assert.equal(ok.status, 200);
  assert.equal(calls.length, 1);

  const invalid = await fetch(`${base}/api/mail-domains/${mailDomainId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: 5,
      deleteJobId,
      confirmation: `delete-mail-domain:${mailDomainId}:5`,
      force: true,
    }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'mail_domain_delete_input_invalid');
  assert.equal(calls.length, 1);
});
