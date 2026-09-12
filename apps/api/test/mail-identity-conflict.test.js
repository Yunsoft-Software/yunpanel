import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';
import { createMailConfigurationService, MailConfigurationError } from '../src/mail-configuration.js';
import { MailboxRegistryError } from '../src/mailbox-registry.js';
import { mountMailboxRoutes } from '../src/mailbox-http.js';

const owner = Object.freeze({
  user: { role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});

async function listen(t, { aliases }) {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = owner; next(); });
  mountMailboxRoutes(app, {
    mailboxRegistry: {
      async createMailbox(input) { calls.push(input); return { id: 'mailbox-1', ...input, enabled: true, revision: 1 }; },
      async listMailboxes() { return []; },
      async getMailbox() { return null; },
      async rotatePassword() {},
      async setEnabled() {},
      async deleteMailbox() {},
    },
    mailAliasRegistry: {
      async listAliases() { return aliases; },
    },
  });
  app.use((error, _request, response, _next) => response.status(error.status ?? 500).json({
    error: { code: error.code ?? 'internal_error', message: error.message },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, calls };
}

test('mailbox create rejects a canonical address already reserved by a mail alias', async (t) => {
  const fixture = await listen(t, {
    aliases: [{ source: 'info@example.com', destinations: ['owner@example.com'], enabled: false }],
  });
  const response = await fetch(`${fixture.base}/api/mailboxes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mailDomainId: '87654321-1234-4234-8234-123456789012',
      address: 'INFO@EXAMPLE.COM.',
      password: 'not-used-by-fake-registry',
    }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'mailbox_alias_conflict');
  assert.deepEqual(fixture.calls, []);
});

function phc() {
  const salt = Buffer.alloc(16, 13).toString('base64').replace(/=+$/, '');
  const hash = Buffer.alloc(32, 14).toString('base64').replace(/=+$/, '');
  return ['$argon2id', 'v=19', 'm=65536,t=3,p=1', salt, hash].join('$');
}

test('managed mail preview reports inconsistent mailbox and alias identities as a bounded 409', async () => {
  const domain = {
    id: 'mail-domain-0001',
    domainName: 'example.com',
    managementMode: 'local',
    status: 'disabled',
    revision: 1,
  };
  const service = createMailConfigurationService({
    mailDomainRegistry: {
      async getMailDomain() { return domain; },
      async listMailDomains() { return [domain]; },
    },
    mailboxRegistry: {
      async listMailboxes() { return [{ address: 'owner@example.com', enabled: true }]; },
      async materializeEnabledAccounts() { return [{ address: 'owner@example.com', passwordHash: phc() }]; },
    },
    mailAliasRegistry: {
      async materializeEnabledAliases() {
        return [{ source: 'owner@example.com', destinations: ['external@elsewhere.test'] }];
      },
    },
  });

  await assert.rejects(
    service.previewTransition({ mailDomainId: domain.id, expectedRevision: 1, status: 'enabled' }),
    (error) => error instanceof MailConfigurationError
      && error.code === 'mail_configuration_state_invalid'
      && error.status === 409
      && !/owner@example\.com|external@/i.test(error.message),
  );
});
