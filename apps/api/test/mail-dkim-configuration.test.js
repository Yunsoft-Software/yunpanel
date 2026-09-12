import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  createMailDkimConfigurationService,
  MailDkimConfigurationError,
} from '../src/mail-dkim-configuration.js';

function pair(byte) {
  const generated = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    publicKey: Buffer.from(generated.publicKey).toString('base64'),
    privateKey: generated.privateKey,
    marker: byte,
  };
}

const firstPair = pair(1);
const secondPair = pair(2);
const firstDomain = {
  id: randomUUID(), domainName: 'example.com', managementMode: 'local', status: 'enabled',
};
const secondDomain = {
  id: randomUUID(), domainName: 'second.example', managementMode: 'local', status: 'enabled',
};

function key(mailDomain, selector, keyPair) {
  return {
    mailDomainId: mailDomain.id,
    domainName: mailDomain.domainName,
    selector,
    algorithm: 'rsa-sha256',
    publicKey: keyPair.publicKey,
    dnsRecord: {
      type: 'TXT',
      name: `${selector}._domainkey.${mailDomain.domainName}`,
      value: `v=DKIM1; k=rsa; p=${keyPair.publicKey}`,
    },
    revision: 1,
    createdAt: '2026-09-12T19:00:00.000Z',
    updatedAt: '2026-09-12T19:00:00.000Z',
  };
}

function fixture({ secondDnsState = 'ready' } = {}) {
  const domains = [structuredClone(firstDomain), structuredClone(secondDomain)];
  let keys = [
    key(firstDomain, 'mail-a', firstPair),
    key(secondDomain, 'mail-b', secondPair),
  ];
  let materializeHook = null;
  const diagnosticsCalls = [];
  const service = createMailDkimConfigurationService({
    mailDomainRegistry: {
      async getMailDomain(id) { return domains.find((item) => item.id === id) ?? null; },
      async listMailDomains() { return domains.map((item) => structuredClone(item)); },
    },
    mailDkimRegistry: {
      async getKey(id) { return structuredClone(keys.find((item) => item.mailDomainId === id) ?? null); },
      async listKeys() { return keys.map((item) => structuredClone(item)); },
      async materializePrivateKey(id) {
        if (materializeHook) await materializeHook(id);
        const metadata = keys.find((item) => item.mailDomainId === id);
        if (!metadata) throw new Error('missing fixture key');
        return {
          metadata: structuredClone(metadata),
          privateKey: id === firstDomain.id ? firstPair.privateKey : secondPair.privateKey,
        };
      },
    },
    mailDiagnosticsInspector: {
      async inspect(domainName, { dkim }) {
        diagnosticsCalls.push([domainName, dkim.selector]);
        const state = domainName === secondDomain.domainName ? secondDnsState : 'ready';
        return {
          diagnostics: {
            dkim: {
              state,
              expected: dkim.dnsRecord,
              current: state === 'ready' ? [dkim.dnsRecord.value] : [],
              reasonCode: state === 'ready' ? null : 'mail_dkim_missing',
              action: state === 'ready' ? null : 'publish_dkim_record',
            },
          },
        };
      },
    },
  });
  return {
    service,
    diagnosticsCalls,
    domains,
    setKeys(value) { keys = value; },
    onMaterialize(fn) { materializeHook = fn; },
  };
}

const input = Object.freeze({
  mailDomainId: firstDomain.id,
  expectedKeyRevision: 1,
});

test('aggregate DKIM preview binds every enabled managed key and all DNS states', async () => {
  const state = fixture();
  const preview = await state.service.previewApply(input);

  assert.equal(preview.readyToApply, true);
  assert.deepEqual(preview.blockers, []);
  assert.equal(preview.configuration.domains, 2);
  assert.equal(preview.dns.length, 2);
  assert.equal(preview.dnsStates.every((entry) => entry.state === 'ready'), true);
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);
  assert.match(preview.configuration.sha256, /^[a-f0-9]{64}$/);
  assert.equal(preview.confirmation, `apply-mail-dkim:${firstDomain.id}:${preview.previewDigest}`);
  assert.deepEqual(state.diagnosticsCalls.map(([domain]) => domain), ['example.com', 'second.example']);
});

test('an unrelated enabled DKIM domain with missing DNS blocks global signing activation', async () => {
  const state = fixture({ secondDnsState: 'missing' });
  const preview = await state.service.previewApply(input);

  assert.equal(preview.readyToApply, false);
  assert.deepEqual(preview.blockers, ['mail_dkim_dns_not_ready']);
  assert.deepEqual(preview.dnsStates, [
    { mailDomainId: firstDomain.id, domainName: 'example.com', state: 'ready' },
    { mailDomainId: secondDomain.id, domainName: 'second.example', state: 'missing' },
  ]);
  await assert.rejects(
    state.service.materializeApply(input, {
      expectedPreviewDigest: preview.previewDigest,
      expectedConfigurationSha256: preview.configuration.sha256,
    }),
    (error) => error instanceof MailDkimConfigurationError && error.code === 'mail_dkim_dns_not_ready',
  );
});

test('aggregate key-set change stales an older DKIM apply preview', async () => {
  const state = fixture();
  const preview = await state.service.previewApply(input);
  state.domains[1].status = 'disabled';

  await assert.rejects(
    state.service.materializeApply(input, {
      expectedPreviewDigest: preview.previewDigest,
      expectedConfigurationSha256: preview.configuration.sha256,
    }),
    (error) => error instanceof MailDkimConfigurationError && error.code === 'mail_dkim_preview_stale',
  );
});

test('private materialization returns every enabled key but never exposes PEM in public preview', async () => {
  const state = fixture();
  const preview = await state.service.previewApply(input);
  const materialized = await state.service.materializeApply(input, {
    expectedPreviewDigest: preview.previewDigest,
    expectedConfigurationSha256: preview.configuration.sha256,
  });

  assert.equal(materialized.keys.length, 2);
  assert.equal(materialized.keys[0].domain, 'example.com');
  assert.equal(materialized.keys[1].domain, 'second.example');
  assert.match(materialized.keys[0].privateKey, /^-----BEGIN PRIVATE KEY-----/);
  assert.doesNotMatch(JSON.stringify(preview), /BEGIN PRIVATE KEY|privateKey/i);
  assert.equal(materialized.preview.sha256, preview.configuration.sha256);
});

test('state change during private materialization is rejected before host activation', async () => {
  const state = fixture();
  const preview = await state.service.previewApply(input);
  let changed = false;
  state.onMaterialize(async () => {
    if (changed) return;
    changed = true;
    state.domains[1].status = 'disabled';
  });

  await assert.rejects(
    state.service.materializeApply(input, {
      expectedPreviewDigest: preview.previewDigest,
      expectedConfigurationSha256: preview.configuration.sha256,
    }),
    (error) => error instanceof MailDkimConfigurationError && error.code === 'mail_dkim_preview_stale',
  );
});

test('disabled target is removed from aggregate signing while remaining enabled domains stay configured', async () => {
  const state = fixture();
  state.domains[0].status = 'disabled';
  const preview = await state.service.previewApply(input);
  assert.equal(preview.readyToApply, true);
  assert.equal(preview.configuration.domains, 1);
  assert.deepEqual(preview.dnsStates, [
    { mailDomainId: secondDomain.id, domainName: secondDomain.domainName, state: 'ready' },
  ]);
  assert.deepEqual(state.diagnosticsCalls, [[secondDomain.domainName, 'mail-b']]);

  const materialized = await state.service.materializeApply(input, {
    expectedPreviewDigest: preview.previewDigest,
    expectedConfigurationSha256: preview.configuration.sha256,
  });
  assert.equal(materialized.keys.length, 1);
  assert.equal(materialized.keys[0].domain, secondDomain.domainName);
});

test('last disabled DKIM domain produces a deterministic zero-key teardown without DNS blockers', async () => {
  const state = fixture();
  state.domains[0].status = 'disabled';
  state.domains[1].status = 'disabled';
  const preview = await state.service.previewApply(input);
  assert.equal(preview.readyToApply, true);
  assert.deepEqual(preview.blockers, []);
  assert.equal(preview.configuration.domains, 0);
  assert.deepEqual(preview.dns, []);
  assert.deepEqual(preview.dnsStates, []);
  assert.deepEqual(state.diagnosticsCalls, []);

  const materialized = await state.service.materializeApply(input, {
    expectedPreviewDigest: preview.previewDigest,
    expectedConfigurationSha256: preview.configuration.sha256,
  });
  assert.deepEqual(materialized.keys, []);
  assert.equal(materialized.preview.sha256, preview.configuration.sha256);
});

test('stale target key revision still fails closed for enabled or disabled targets', async () => {
  for (const disabled of [false, true]) {
    const state = fixture();
    if (disabled) state.domains[0].status = 'disabled';
    await assert.rejects(
      state.service.previewApply({ ...input, expectedKeyRevision: 2 }),
      (error) => error instanceof MailDkimConfigurationError && error.code === 'stale_mail_dkim_revision',
    );
  }
});
