import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebsiteSftpKeyAwareProvisioningHandler,
  createWebsiteSftpProvisioningHandler,
  WebsiteSftpProvisioningError,
} from '../src/website-sftp-provisioning-handler.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const intent = Object.freeze({
  adapter: 'openssh-internal-sftp',
  websiteId: 'f73cc6ac-07e8-4d22-b29a-741154687d20',
  applicationId: '6dcb8908-3f3e-43da-9452-15fd6b51ac76',
  unixUser: 'yunapp-4dc352e64a14',
});

test('SFTP handler forwards only canonical Website identity to host manager', async () => {
  const calls = [];
  const manager = {
    async apply(value, options) { calls.push(['apply', value, options]); return { satisfied: true, adapter: 'openssh-internal-sftp' }; },
    async inspect(value, options) { calls.push(['inspect', value, options]); return { satisfied: true, adapter: 'openssh-internal-sftp' }; },
    async previewMigration(value, options) {
      calls.push(['previewMigration', value, options]);
      return { version: 1, satisfied: true, current: {}, desired: {}, differences: [] };
    },
    async compensate(value, options) { calls.push(['compensate', value, options]); return { satisfied: true }; },
    async inspectCompensation(value, options) { calls.push(['inspectCompensation', value, options]); return { satisfied: true }; },
  };
  const handler = createWebsiteSftpProvisioningHandler({ sftpManager: manager });

  await handler.apply({ intent, operationId });
  await handler.inspect({ intent, operationId });
  await handler.previewMigration({ intent, operationId });
  await handler.compensate({ intent, operationId });
  await handler.inspectCompensation({ intent, operationId });

  assert.deepEqual(calls.map(([name]) => name), ['apply', 'inspect', 'previewMigration', 'compensate', 'inspectCompensation']);
  for (const [, value, options] of calls) {
    assert.deepEqual(value, {
      websiteId: intent.websiteId,
      applicationId: intent.applicationId,
      unixUser: intent.unixUser,
    });
    assert.equal(options.operationId, operationId);
  }
});

test('SFTP handler rejects extra caller-controlled filesystem fields', () => {
  const handler = createWebsiteSftpProvisioningHandler({
    sftpManager: {
      async apply() { return { satisfied: true }; },
      async inspect() { return { satisfied: true }; },
      async compensate() { return { satisfied: true }; },
      async inspectCompensation() { return { satisfied: true }; },
    },
  });

  assert.throws(
    () => handler.apply({ intent: { ...intent, root: '/tmp/escape' }, operationId }),
    (error) => error instanceof WebsiteSftpProvisioningError && error.code === 'website_sftp_intent_invalid',
  );
});

function baseHandler(calls, { satisfied = true } = {}) {
  return {
    async apply(context) { calls.push(['base-apply', context]); return { satisfied, adapter: 'openssh-internal-sftp' }; },
    async inspect(context) { calls.push(['base-inspect', context]); return { satisfied, adapter: 'openssh-internal-sftp' }; },
    async previewMigration(context) {
      calls.push(['base-preview-migration', context]);
      return { version: 1, satisfied, current: {}, desired: {}, differences: satisfied ? [] : ['sftp_drift'] };
    },
    async compensate(context) { calls.push(['base-compensate', context]); return { satisfied: true }; },
    async inspectCompensation(context) { calls.push(['base-inspect-compensation', context]); return { satisfied: true }; },
  };
}

test('SFTP provisioning succeeds only after desired authorized keys are reconciled and evidenced', async () => {
  const calls = [];
  const keyService = {
    async reconcile(websiteId) {
      calls.push(['keys-reconcile', websiteId]);
      return { satisfied: true, adapter: 'openssh-authorized-keys', keyCount: 2, sha256: 'a'.repeat(64) };
    },
    async inspectMaterialization(websiteId) {
      calls.push(['keys-inspect', websiteId]);
      return { satisfied: true, adapter: 'openssh-authorized-keys', keyCount: 2, sha256: 'a'.repeat(64) };
    },
  };
  const handler = createWebsiteSftpKeyAwareProvisioningHandler({
    baseHandler: baseHandler(calls),
    sftpKeyService: keyService,
  });
  const context = { websiteId: intent.websiteId, intent, operationId };

  const applied = await handler.apply(context);
  const inspected = await handler.inspect(context);

  assert.deepEqual(calls.map(([name]) => name), ['base-apply', 'keys-reconcile', 'base-inspect', 'keys-inspect']);
  for (const result of [applied, inspected]) {
    assert.equal(result.satisfied, true);
    assert.equal(result.authorizedKeysAdapter, 'openssh-authorized-keys');
    assert.equal(result.authorizedKeyCount, 2);
    assert.equal(result.authorizedKeysSha256, 'a'.repeat(64));
  }
});

test('SFTP provisioning exposes desired-state drift as reconcile-required without replaying base mutation', async () => {
  const calls = [];
  const handler = createWebsiteSftpKeyAwareProvisioningHandler({
    baseHandler: baseHandler(calls),
    sftpKeyService: {
      async reconcile() { throw Object.assign(new Error('private host failure'), { code: 'raw_host_error' }); },
      async inspectMaterialization(websiteId) {
        calls.push(['keys-inspect', websiteId]);
        return { satisfied: false, reason: 'sftp_authorized_keys_outdated' };
      },
    },
  });
  const context = { websiteId: intent.websiteId, intent, operationId };

  const inspected = await handler.inspect(context);
  assert.deepEqual(inspected, {
    satisfied: false,
    adapter: 'openssh-internal-sftp',
    reason: 'sftp_key_reconcile_required',
    keyReason: 'sftp_authorized_keys_outdated',
  });
  assert.deepEqual(calls.map(([name]) => name), ['base-inspect', 'keys-inspect']);

  await assert.rejects(
    handler.apply(context),
    (error) => error instanceof WebsiteSftpProvisioningError
      && error.code === 'sftp_key_reconcile_required'
      && !error.message.includes('private host failure'),
  );
});

test('SFTP key lifecycle is skipped until base isolation is satisfied and preserves compensation ownership', async () => {
  const calls = [];
  const handler = createWebsiteSftpKeyAwareProvisioningHandler({
    baseHandler: baseHandler(calls, { satisfied: false }),
    sftpKeyService: {
      async reconcile() { calls.push(['unexpected-reconcile']); return {}; },
      async inspectMaterialization() { calls.push(['unexpected-inspect']); return {}; },
    },
  });
  const context = { websiteId: intent.websiteId, intent, operationId };

  assert.equal((await handler.apply(context)).satisfied, false);
  assert.equal((await handler.inspect(context)).satisfied, false);
  await handler.compensate(context);
  await handler.inspectCompensation(context);
  assert.deepEqual(calls.map(([name]) => name), [
    'base-apply', 'base-inspect', 'base-compensate', 'base-inspect-compensation',
  ]);
});

test('SFTP key lifecycle rejects provisioning operation identity drift', async () => {
  const handler = createWebsiteSftpKeyAwareProvisioningHandler({
    baseHandler: baseHandler([]),
    sftpKeyService: {
      async reconcile() { return {}; },
      async inspectMaterialization() { return {}; },
    },
  });
  await assert.rejects(
    handler.inspect({ websiteId: 'other-website', intent, operationId }),
    (error) => error instanceof WebsiteSftpProvisioningError
      && error.code === 'website_sftp_operation_identity_drift',
  );
});


test('SFTP key-aware migration preview combines base artifact drift with secret-safe key materialization evidence', async () => {
  const calls = [];
  const handler = createWebsiteSftpKeyAwareProvisioningHandler({
    baseHandler: baseHandler(calls),
    sftpKeyService: {
      async reconcile() { throw new Error('not used'); },
      async inspectMaterialization(websiteId) {
        calls.push(['keys-inspect', websiteId]);
        return { satisfied: true, adapter: 'openssh-authorized-keys', keyCount: 2, sha256: 'b'.repeat(64) };
      },
    },
  });
  const context = { websiteId: intent.websiteId, intent, operationId };

  const preview = await handler.previewMigration(context);

  assert.equal(preview.version, 1);
  assert.equal(preview.satisfied, true);
  assert.deepEqual(preview.authorizedKeys, {
    satisfied: true,
    adapter: 'openssh-authorized-keys',
    keyCount: 2,
    sha256: 'b'.repeat(64),
  });
  assert.deepEqual(calls.map(([name]) => name), ['base-preview-migration', 'keys-inspect']);
  assert.equal(JSON.stringify(preview).includes('ssh-rsa'), false);
});
