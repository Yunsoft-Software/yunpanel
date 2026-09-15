import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
    async compensate(value, options) { calls.push(['compensate', value, options]); return { satisfied: true }; },
    async inspectCompensation(value, options) { calls.push(['inspectCompensation', value, options]); return { satisfied: true }; },
  };
  const handler = createWebsiteSftpProvisioningHandler({ sftpManager: manager });

  await handler.apply({ intent, operationId });
  await handler.inspect({ intent, operationId });
  await handler.compensate({ intent, operationId });
  await handler.inspectCompensation({ intent, operationId });

  assert.deepEqual(calls.map(([name]) => name), ['apply', 'inspect', 'compensate', 'inspectCompensation']);
  for (const [, value, options] of calls) {
    assert.deepEqual(value, {
      websiteId: intent.websiteId,
      applicationId: intent.applicationId,
      unixUser: intent.unixUser,
    });
    assert.equal(options.operationId, operationId);
  }
});

test('SFTP handler rejects extra caller-controlled filesystem fields', async () => {
  const handler = createWebsiteSftpProvisioningHandler({
    sftpManager: {
      async apply() { return { satisfied: true }; },
      async inspect() { return { satisfied: true }; },
      async compensate() { return { satisfied: true }; },
      async inspectCompensation() { return { satisfied: true }; },
    },
  });

  await assert.rejects(
    handler.apply({ intent: { ...intent, root: '/tmp/escape' }, operationId }),
    (error) => error instanceof WebsiteSftpProvisioningError && error.code === 'website_sftp_intent_invalid',
  );
});
