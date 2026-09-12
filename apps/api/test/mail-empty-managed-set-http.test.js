import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { mailSubmissionTemplatePolicy } from '@yunpanel/config-templates';
import { createMailConfigurationService } from '../src/mail-configuration.js';
import { mountMailConfigurationRoutes } from '../src/mail-configuration-http.js';

const owner = Object.freeze({
  user: { role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});

function passwordHash() {
  return [
    '$argon2id',
    'v=19',
    'm=65536,t=3,p=1',
    Buffer.alloc(16, 11).toString('base64').replace(/=+$/, ''),
    Buffer.alloc(32, 12).toString('base64').replace(/=+$/, ''),
  ].join('$');
}

async function startFixture(t) {
  const serverId = randomUUID();
  const webDomain = { id: randomUUID(), serverId };
  const mailDomain = {
    id: randomUUID(),
    domainName: 'example.com',
    managementMode: 'local',
    webDomainId: webDomain.id,
    status: 'enabled',
    revision: 1,
  };
  const account = { address: 'owner@example.com', passwordHash: passwordHash() };
  const mailDomainRegistry = {
    getMailDomain: async (id) => id === mailDomain.id ? mailDomain : null,
    listMailDomains: async () => [mailDomain],
  };
  const mailConfigurationService = createMailConfigurationService({
    mailDomainRegistry,
    mailboxRegistry: {
      listMailboxes: async () => [{
        id: randomUUID(),
        mailDomainId: mailDomain.id,
        address: account.address,
        enabled: true,
      }],
      materializeEnabledAccounts: async () => [account],
    },
    mailAliasRegistry: { materializeEnabledAliases: async () => [] },
  });
  const enqueued = [];
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = owner; next(); });
  mountMailConfigurationRoutes(app, {
    mailConfigurationService,
    mailDomainRegistry,
    domainRegistry: { getDomain: async (id) => id === webDomain.id ? webDomain : null },
    jobRegistry: {
      listJobs: async () => [],
      enqueue: async (input) => {
        enqueued.push(structuredClone(input));
        return { id: randomUUID(), status: 'queued', ...input };
      },
    },
    localServerId: serverId,
  });
  app.use((error, _request, response, _next) => response.status(error.status ?? 500).json({
    error: { code: error.code ?? 'internal_error', message: error.message },
  }));
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    listener.once('listening', resolve);
    listener.once('error', reject);
  });
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  return {
    base: `http://127.0.0.1:${listener.address().port}`,
    mailDomain,
    enqueued,
  };
}

async function post(base, pathname, body) {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('Owner can preview and queue disabling the final enabled local mail domain with submission teardown state', async (t) => {
  const fixture = await startFixture(t);
  const previewResponse = await post(
    fixture.base,
    `/api/mail-domains/${fixture.mailDomain.id}/config-preview`,
    { expectedRevision: 1, status: 'disabled' },
  );
  assert.equal(previewResponse.status, 200);
  const preview = (await previewResponse.json()).data;
  assert.equal(preview.readyToApply, true);
  assert.deepEqual(preview.domains, []);
  assert.deepEqual(preview.configuration.counts, { domains: 0, mailboxes: 0, aliases: 0, forwardings: 0 });
  assert.deepEqual(preview.configuration.postfixMasterServices, [mailSubmissionTemplatePolicy.service]);
  assert.equal(preview.configuration.artifactDigests.some(
    (artifact) => artifact.path === mailSubmissionTemplatePolicy.senderLoginPath,
  ), true);
  assert.doesNotMatch(JSON.stringify(preview), /argon2|passwordHash/i);

  const applyResponse = await post(
    fixture.base,
    `/api/mail-domains/${fixture.mailDomain.id}/config-apply`,
    {
      expectedRevision: 1,
      status: 'disabled',
      previewDigest: preview.previewDigest,
      configurationSha256: preview.configurationSha256,
      confirmation: preview.confirmation,
    },
  );
  assert.equal(applyResponse.status, 202);
  assert.equal(fixture.enqueued.length, 1);
  assert.equal(fixture.enqueued[0].operation, 'mail.config.apply');
  assert.equal(fixture.enqueued[0].resourceType, 'mail_domain');
  assert.equal(fixture.enqueued[0].resourceId, fixture.mailDomain.id);
  assert.deepEqual(fixture.enqueued[0].payload, {
    mailDomainId: fixture.mailDomain.id,
    expectedRevision: 1,
    desiredStatus: 'disabled',
    previewDigest: preview.previewDigest,
    configurationSha256: preview.configurationSha256,
  });
  assert.doesNotMatch(JSON.stringify(fixture.enqueued), /argon2|passwordHash|content/i);
});
