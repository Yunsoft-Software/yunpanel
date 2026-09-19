import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createWebsiteCronOperationReceiptStore,
  WebsiteCronOperationReceiptError,
} from '../src/website-cron-operation-receipt.js';

const serverId = '12345678-1234-4234-8234-123456789012';
const taskId = '22345678-1234-4234-8234-123456789012';
const websiteId = '32345678-1234-4234-8234-123456789012';
const applicationId = '42345678-1234-4234-8234-123456789012';
const unixUser = 'yunapp-0123456789ab';
const desiredStateSha256 = 'a'.repeat(64);
const contentSha256 = 'b'.repeat(64);

test('WebsiteCronOperationReceiptStore writes and reads apply receipt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cron-receipt-test-'));
  try {
    const store = createWebsiteCronOperationReceiptStore({ root });
    const jobId = 'job-cron-apply-001';

    const written = await store.write({
      serverId,
      jobId,
      operation: OPERATIONS.CRON_APPLY,
      result: {
        version: 1,
        taskId,
        websiteId,
        applicationId,
        unixUser,
        revision: 1,
        desiredStateSha256,
        contentSha256,
        applied: true,
        sideEffects: true,
      },
    });

    assert.equal(written.version, 1);
    assert.equal(written.serverId, serverId);
    assert.equal(written.jobId, jobId);
    assert.equal(written.operation, OPERATIONS.CRON_APPLY);
    assert.equal(written.result.applied, true);
    assert.equal(written.result.sideEffects, true);

    const read = await store.read(serverId, jobId);
    assert.deepEqual(read, written);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('WebsiteCronOperationReceiptStore writes and reads remove receipt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cron-receipt-test-'));
  try {
    const store = createWebsiteCronOperationReceiptStore({ root });
    const jobId = 'job-cron-remove-001';

    const written = await store.write({
      serverId,
      jobId,
      operation: OPERATIONS.CRON_REMOVE,
      result: {
        version: 1,
        taskId,
        websiteId,
        applicationId,
        unixUser,
        revision: 2,
        desiredStateSha256,
        contentSha256: null,
        removed: true,
        sideEffects: true,
      },
    });

    assert.equal(written.result.removed, true);
    assert.equal(written.result.contentSha256, null);

    const read = await store.read(serverId, jobId);
    assert.deepEqual(read, written);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('WebsiteCronOperationReceiptStore returns null for missing receipt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cron-receipt-test-'));
  try {
    const store = createWebsiteCronOperationReceiptStore({ root });
    const read = await store.read(serverId, 'nonexistent-job');
    assert.equal(read, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('WebsiteCronOperationReceiptStore rejects invalid identity or result', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cron-receipt-test-'));
  try {
    const store = createWebsiteCronOperationReceiptStore({ root });

    await assert.rejects(
      () => store.write({ serverId: 'bad', jobId: 'job-1', operation: OPERATIONS.CRON_APPLY, result: {} }),
      (err) => err instanceof WebsiteCronOperationReceiptError && err.code === 'website_cron_receipt_identity_invalid',
    );

    await assert.rejects(
      () => store.write({
        serverId,
        jobId: 'job-12345678',
        operation: OPERATIONS.CRON_APPLY,
        result: { version: 2 },
      }),
      (err) => err instanceof WebsiteCronOperationReceiptError && err.code === 'website_cron_receipt_result_invalid',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
