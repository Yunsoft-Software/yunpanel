import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createLocalHostOperations } from '../src/local-host-operations.js';

const mailDomainId = randomUUID();
const configurationSha256 = 'a'.repeat(64);
const previewDigest = 'b'.repeat(64);
const payload = Object.freeze({
  mailDomainId,
  expectedKeyRevision: 1,
  previewDigest,
  configurationSha256,
});
const privateKey = '-----BEGIN PRIVATE KEY-----\nprivate fixture\n-----END PRIVATE KEY-----\n';
const bundle = Object.freeze({
  preview: Object.freeze({ sha256: configurationSha256 }),
  keys: Object.freeze([Object.freeze({
    domain: 'example.com',
    selector: 'mail-2026',
    publicKey: 'public-fixture',
    privateKey,
  })]),
});
const execution = Object.freeze({
  jobId: 'mail-dkim-job-0001',
  serverId: randomUUID(),
  resourceType: 'mail_domain',
  resourceId: mailDomainId,
});

test('managed DKIM stays unsupported until a private materializer is configured', async () => {
  const operations = createLocalHostOperations({
    mailDkimActivator: { activate: async () => ({ applied: true }) },
  });
  assert.equal(operations.supports(OPERATIONS.MAIL_DKIM_APPLY), false);
  await assert.rejects(
    operations.executeOperation(OPERATIONS.MAIL_DKIM_APPLY, payload, execution),
    { code: 'local_operation_not_migrated' },
  );
});

test('local DKIM operation materializes private PEM only for activator execution', async () => {
  const calls = [];
  const operations = createLocalHostOperations({
    loadManagedDkimConfiguration: async (input) => {
      calls.push(['load', structuredClone(input)]);
      return bundle;
    },
    mailDkimActivator: {
      async activate(input, options) {
        calls.push(['activate', input, structuredClone(options)]);
        return {
          version: 1,
          previewSha256: configurationSha256,
          applied: true,
          sideEffects: true,
        };
      },
    },
  });

  assert.equal(operations.supports(OPERATIONS.MAIL_DKIM_APPLY), true);
  const result = await operations.executeOperation(OPERATIONS.MAIL_DKIM_APPLY, payload, execution);
  assert.deepEqual(calls[0], ['load', payload]);
  assert.equal(calls[1][0], 'activate');
  assert.equal(calls[1][1].keys[0].privateKey, privateKey);
  assert.deepEqual(calls[1][2], { transactionId: execution.jobId });
  assert.deepEqual(result, {
    version: 1,
    mailDomainId,
    expectedKeyRevision: 1,
    previewDigest,
    configurationSha256,
    applied: true,
    sideEffects: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /BEGIN PRIVATE KEY|privateKey/i);
  assert.equal(Object.hasOwn(payload, 'privateKey'), false);
});

test('DKIM execution rejects stale bundle and mismatched resource context before host mutation', async () => {
  let activations = 0;
  let loads = 0;
  const operations = createLocalHostOperations({
    loadManagedDkimConfiguration: async () => {
      loads += 1;
      return { ...bundle, preview: { sha256: 'c'.repeat(64) } };
    },
    mailDkimActivator: {
      async activate() { activations += 1; return { applied: true, sideEffects: true }; },
    },
  });

  await assert.rejects(
    operations.executeOperation(OPERATIONS.MAIL_DKIM_APPLY, payload, execution),
    { code: 'mail_dkim_preview_stale' },
  );
  assert.equal(loads, 1);
  assert.equal(activations, 0);

  await assert.rejects(
    operations.executeOperation(OPERATIONS.MAIL_DKIM_APPLY, payload, {
      ...execution,
      resourceId: randomUUID(),
    }),
    { code: 'mail_execution_context_invalid' },
  );
  assert.equal(loads, 1);
  assert.equal(activations, 0);
});
