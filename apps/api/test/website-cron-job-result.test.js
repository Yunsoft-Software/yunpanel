import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  sanitizeWebsiteCronJobResult,
  WebsiteCronJobResultError,
} from '../src/website-cron-job-result.js';

const taskId = '12345678-1234-4234-8234-123456789012';
const websiteId = '22345678-1234-4234-8234-123456789012';
const applicationId = '32345678-1234-4234-8234-123456789012';
const unixUser = 'yunapp-0123456789ab';
const desiredStateSha256 = 'a'.repeat(64);
const contentSha256 = 'b'.repeat(64);

test('sanitizeWebsiteCronJobResult accepts matching CRON_APPLY result', () => {
  const job = {
    operation: OPERATIONS.CRON_APPLY,
    payload: {
      taskId,
      websiteId,
      applicationId,
      unixUser,
      expectedRevision: 1,
      desiredStateSha256,
    },
  };
  const result = {
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
  };

  const sanitized = sanitizeWebsiteCronJobResult(job, result);
  assert.equal(sanitized.version, 1);
  assert.equal(sanitized.taskId, taskId);
  assert.equal(sanitized.applied, true);
  assert.equal(sanitized.sideEffects, true);
});

test('sanitizeWebsiteCronJobResult accepts matching CRON_REMOVE result', () => {
  const job = {
    operation: OPERATIONS.CRON_REMOVE,
    payload: {
      taskId,
      websiteId,
      applicationId,
      unixUser,
      expectedRevision: 2,
      desiredStateSha256,
    },
  };
  const result = {
    version: 1,
    taskId,
    websiteId,
    applicationId,
    unixUser,
    revision: 2,
    desiredStateSha256,
    contentSha256: null,
    removed: true,
    sideEffects: false,
  };

  const sanitized = sanitizeWebsiteCronJobResult(job, result);
  assert.equal(sanitized.removed, true);
  assert.equal(sanitized.contentSha256, null);
});

test('sanitizeWebsiteCronJobResult rejects mismatched or invalid result', () => {
  const job = {
    operation: OPERATIONS.CRON_APPLY,
    payload: {
      taskId,
      websiteId,
      applicationId,
      unixUser,
      expectedRevision: 1,
      desiredStateSha256,
    },
  };

  for (const badResult of [
    null,
    {},
    { version: 2 },
    { version: 1, taskId: 'wrong', websiteId, applicationId, unixUser, revision: 1, desiredStateSha256, contentSha256, applied: true, sideEffects: true },
    { version: 1, taskId, websiteId, applicationId, unixUser, revision: 99, desiredStateSha256, contentSha256, applied: true, sideEffects: true },
    { version: 1, taskId, websiteId, applicationId, unixUser, revision: 1, desiredStateSha256: 'wrong', contentSha256, applied: true, sideEffects: true },
    { version: 1, taskId, websiteId, applicationId, unixUser, revision: 1, desiredStateSha256, contentSha256, applied: false, sideEffects: true },
  ]) {
    assert.throws(
      () => sanitizeWebsiteCronJobResult(job, badResult),
      (err) => err instanceof WebsiteCronJobResultError && err.code === 'invalid_job_result',
    );
  }
});
