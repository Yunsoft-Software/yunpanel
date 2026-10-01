import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createWebsitePhpToolOperationReceiptStore,
  websitePhpToolOperationReceiptInternals,
} from '../src/website-php-tool-operation-receipt.js';

const base = {
  version: 1, recordedAt: '2026-09-25T00:00:00.000Z',
  serverId: '33333333-3333-4333-8333-333333333333', jobId: 'php-action-job-01',
  payload: {
    websiteId: '11111111-1111-4111-8111-111111111111',
    applicationId: '22222222-2222-4222-8222-222222222222',
    unixUser: 'yunapp-123456789abc', expectedWebsiteRevision: 4,
    actorSessionId: '44444444-4444-4444-8444-444444444444', actorUserId: '55555555-5555-4555-8555-555555555555', actorRole: 'site_manager',
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

test('receipt preserves reseller and customer actor evidence for crash recovery', () => {
  for (const actorRole of ['reseller', 'customer']) {
    const value = websitePhpToolOperationReceiptInternals.normalized({
      ...base,
      payload: { ...base.payload, actorRole },
    });
    assert.equal(value.payload.actorRole, actorRole);
  }
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

test('receipt store writes 0600 receipts into 0700 directory and reads them deterministically', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-receipts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createWebsitePhpToolOperationReceiptStore({ root });

  // Missing receipt returns null
  assert.equal(await store.read(base.serverId, base.jobId), null);

  // Write receipt
  const written = await store.write({
    serverId: base.serverId,
    jobId: base.jobId,
    payload: base.payload,
    result: base.result,
  });
  assert.equal(written.jobId, base.jobId);
  assert.equal(written.result.completed, true);

  // Read receipt matches written
  const read = await store.read(base.serverId, base.jobId);
  assert.deepEqual(read, written);

  // Verify 0600 file permissions and 0700 directory permissions
  const targetFile = path.join(root, base.serverId.toLowerCase(), `${base.jobId}.json`);
  const fileStat = await stat(targetFile);
  assert.equal(fileStat.mode & 0o777, 0o600);
  const dirStat = await stat(path.dirname(targetFile));
  assert.equal(dirStat.mode & 0o777, 0o700);

  // Corrupt receipt fails closed
  await writeFile(targetFile, '{"broken":true}');
  await assert.rejects(
    () => store.read(base.serverId, base.jobId),
    (error) => error.code === 'website_php_tool_receipt_invalid',
  );
});
