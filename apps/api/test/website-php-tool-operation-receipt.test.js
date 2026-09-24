import assert from 'node:assert/strict';
import test from 'node:test';
import { websitePhpToolOperationReceiptInternals } from '../src/website-php-tool-operation-receipt.js';

const base = {
  version: 1, recordedAt: '2026-09-25T00:00:00.000Z',
  serverId: '33333333-3333-4333-8333-333333333333', jobId: 'php-action-job-01',
  payload: {
    websiteId: '11111111-1111-4111-8111-111111111111',
    applicationId: '22222222-2222-4222-8222-222222222222',
    unixUser: 'yunapp-123456789abc', expectedWebsiteRevision: 4,
    actionId: 'wp.cache.flush', previewDigest: 'a'.repeat(64),
    confirmation: `php-tool:11111111-1111-4111-8111-111111111111:wp.cache.flush:${'a'.repeat(64)}`,
  },
};
base.result = {
  version: 1, websiteId: base.payload.websiteId, applicationId: base.payload.applicationId,
  unixUser: base.payload.unixUser, actionId: base.payload.actionId,
  websiteRevision: 4, previewDigest: base.payload.previewDigest, completed: true, sideEffects: true,
};

test('receipt normalizes exact reviewed execution evidence', () => {
  const value = websitePhpToolOperationReceiptInternals.normalized(base);
  assert.equal(value.result.actionId, 'wp.cache.flush');
  assert.equal(value.payload.unixUser, 'yunapp-123456789abc');
});

for (const patch of [
  { result: { ...base.result, actionId: 'composer.dump-autoload' } },
  { result: { ...base.result, unixUser: 'root' } },
  { payload: { ...base.payload, previewDigest: 'b'.repeat(64) } },
]) {
  test('receipt rejects mismatched evidence', () => {
    assert.throws(() => websitePhpToolOperationReceiptInternals.normalized({ ...base, ...patch }));
  });
}
