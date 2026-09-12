import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { mountMailboxRoutes } from '../src/mailbox-http.js';
import { MailboxRegistryError } from '../src/mailbox-registry.js';

const mailboxId = randomUUID();
const mailDomainId = randomUUID();
const owner = Object.freeze({
  user: { role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});

async function listen(t, { quota = null, forwarding = null } = {}) {
  const calls = [];
  const mailbox = { id: mailboxId, mailDomainId, address: 'owner@example.com', revision: 4 };
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = owner; next(); });
  mountMailboxRoutes(app, {
    mailboxRegistry: {
      async createMailbox() {},
      async listMailboxes() { return [mailbox]; },
      async getMailbox(id) { return id === mailboxId ? mailbox : null; },
      async rotatePassword() {},
      async setEnabled() {},
      async deleteMailbox(id, input) { calls.push(['delete', id, structuredClone(input)]); },
    },
    mailboxQuotaRegistry: {
      async getQuota(id) { calls.push(['quota', id]); return quota; },
    },
    mailboxForwardingRegistry: {
      async getForwarding(id) { calls.push(['forwarding', id]); return forwarding; },
    },
  });
  app.use((error, _request, response, _next) => {
    const known = error instanceof MailboxRegistryError;
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
  return fetch(`${base}/api/mailboxes/${mailboxId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 4, confirmation: 'delete-mailbox:owner@example.com' }),
  });
}

test('mailbox delete is blocked until quota policy is explicitly cleared', async (t) => {
  const fixture = await listen(t, { quota: { mailboxId, quotaBytes: 104857600, revision: 1 } });
  const response = await remove(fixture.base);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'mailbox_delete_quota_configured');
  assert.deepEqual(fixture.calls.map(([name]) => name), ['quota']);
  assert.equal(fixture.calls.some(([name]) => name === 'delete'), false);
});

test('mailbox delete is blocked until forwarding policy is explicitly cleared', async (t) => {
  const fixture = await listen(t, {
    forwarding: { mailboxId, mode: 'copy', destinations: ['backup@elsewhere.test'], enabled: true, revision: 1 },
  });
  const response = await remove(fixture.base);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'mailbox_delete_forwarding_configured');
  assert.deepEqual(fixture.calls.map(([name]) => name), ['quota', 'forwarding']);
  assert.equal(fixture.calls.some(([name]) => name === 'delete'), false);
});

test('mailbox delete proceeds only after dependent quota and forwarding policies are absent', async (t) => {
  const fixture = await listen(t);
  const response = await remove(fixture.base);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.deleted, true);
  assert.deepEqual(fixture.calls.map(([name]) => name), ['quota', 'forwarding', 'delete']);
});
