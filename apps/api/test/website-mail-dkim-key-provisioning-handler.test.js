import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebsiteMailDkimKeyProvisioningHandler,
  WebsiteMailDkimKeyProvisioningError,
} from '../src/website-mail-dkim-key-provisioning-handler.js';
import { deterministicWebsiteMailDkimSelector } from '../src/website-mail-dkim-selector.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const webDomainId = '3854e385-adfc-42bd-bccf-f655f24cd68f';
const mailDomainId = '2dd93f8e-23aa-4e2e-b65c-f53eb29558dd';
const selector = 'yp-9ae512c0a7174611943c6ce2';

function publicKey(selectorValue = selector) {
  return {
    mailDomainId,
    domainName: 'example.com',
    selector: selectorValue,
    algorithm: 'rsa-sha256',
    publicKey: 'public-key-material',
    dnsRecord: {
      type: 'TXT',
      name: `${selectorValue}._domainkey.example.com`,
      value: 'v=DKIM1; k=rsa; p=public-key-material',
    },
    revision: 1,
    createdAt: '2026-09-19T03:00:00.000Z',
    updatedAt: '2026-09-19T03:00:00.000Z',
  };
}

function intent(overrides = {}) {
  return {
    adapter: 'managed-mail-dkim-key',
    serverId,
    websiteId,
    webDomainId,
    mailDomainId,
    domainName: 'example.com',
    expectedMailDomainRevision: 2,
    expectedMailDomainStatus: 'enabled',
    expectedKeyRevision: 0,
    selector,
    ...overrides,
  };
}

function fixture({
  initialKey = null,
  mailDomainStatus = 'enabled',
  mailDomainRevision = 2,
} = {}) {
  let key = initialKey ? structuredClone(initialKey) : null;
  let creates = 0;
  const mailDkimRegistry = {
    async getKey(id) {
      assert.equal(id, mailDomainId);
      return key ? structuredClone(key) : null;
    },
    async createKey(id, input) {
      assert.equal(id, mailDomainId);
      assert.deepEqual(input, { expectedRevision: 0, selector });
      creates += 1;
      if (key) throw new Error('duplicate key creation');
      key = publicKey();
      return structuredClone(key);
    },
  };
  const handler = createWebsiteMailDkimKeyProvisioningHandler({
    mailDomainRegistry: {
      async getMailDomain(id) {
        assert.equal(id, mailDomainId);
        return {
          id: mailDomainId,
          webDomainId,
          domainName: 'example.com',
          managementMode: 'local',
          status: mailDomainStatus,
          revision: mailDomainRevision,
        };
      },
    },
    domainRegistry: {
      async getDomain(id) {
        assert.equal(id, webDomainId);
        return {
          id: webDomainId,
          serverId,
          websiteId,
          primaryDomain: 'example.com',
        };
      },
    },
    mailDkimRegistry,
  });
  return {
    handler,
    context: {
      operationId,
      websiteId,
      intent: intent(),
      evidence: null,
    },
    creates: () => creates,
    key: () => key ? structuredClone(key) : null,
  };
}

test('Website DKIM selector is deterministic and operation-bound', () => {
  assert.equal(deterministicWebsiteMailDkimSelector(operationId), selector);
  assert.throws(
    () => deterministicWebsiteMailDkimSelector('not-an-operation-id'),
    /valid provisioning operation identity/,
  );
});

test('Website DKIM key step creates one private-key record and exposes only public digest evidence', async () => {
  const f = fixture();
  const evidence = await f.handler.apply(f.context);

  assert.equal(evidence.satisfied, true);
  assert.equal(evidence.adapter, 'managed-mail-dkim-key');
  assert.equal(evidence.mailDomainId, mailDomainId);
  assert.equal(evidence.selector, selector);
  assert.equal(evidence.keyRevision, 1);
  assert.match(evidence.dnsRecordSha256, /^[a-f0-9]{64}$/);
  assert.equal(f.creates(), 1);
  assert.equal(f.key().selector, selector);
  assert.equal(JSON.stringify(evidence).includes('public-key-material'), false);
  assert.equal(JSON.stringify(evidence).includes('private'), false);

  const second = await f.handler.apply({ ...f.context, evidence });
  assert.deepEqual(second, evidence);
  assert.equal(f.creates(), 1);
});

test('Website DKIM inspect recovers an exact operation selector after lost acknowledgement', async () => {
  const f = fixture({ initialKey: publicKey() });
  const inspected = await f.handler.inspect(f.context);

  assert.equal(inspected.satisfied, true);
  assert.equal(inspected.selector, selector);
  assert.equal(f.creates(), 0);
});

test('Website DKIM step fails closed on foreign selector instead of adopting existing key state', async () => {
  const f = fixture({ initialKey: publicKey('manual-selector') });
  await assert.rejects(
    f.handler.inspect(f.context),
    (error) => error instanceof WebsiteMailDkimKeyProvisioningError
      && error.code === 'website_mail_dkim_key_drift',
  );
  assert.equal(f.creates(), 0);
});

test('Website DKIM key generation requires the exact enabled Mail Domain revision', async () => {
  for (const [status, revision] of [['disabled', 1], ['enabled', 3]]) {
    const f = fixture({ mailDomainStatus: status, mailDomainRevision: revision });
    await assert.rejects(
      f.handler.apply(f.context),
      (error) => error instanceof WebsiteMailDkimKeyProvisioningError
        && error.code === 'website_mail_dkim_mail_state_drift',
    );
    assert.equal(f.creates(), 0);
  }
});

test('Website DKIM intent refuses a selector not derived from the provisioning operation', async () => {
  const f = fixture();
  await assert.rejects(
    f.handler.apply({ ...f.context, intent: intent({ selector: 'manual-selector' }) }),
    (error) => error instanceof WebsiteMailDkimKeyProvisioningError
      && error.code === 'website_mail_dkim_intent_invalid',
  );
  assert.equal(f.creates(), 0);
});
