import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeWebsitePhpToolJobResult } from '../src/website-php-tool-job-result.js';

const job = Object.freeze({
  operation: 'website.php.action',
  resourceType: 'application',
  resourceId: '22222222-2222-4222-8222-222222222222',
  payload: Object.freeze({
    websiteId: '11111111-1111-4111-8111-111111111111',
    applicationId: '22222222-2222-4222-8222-222222222222',
    actionId: 'wp.cache.flush',
    expectedWebsiteRevision: 4,
    previewDigest: 'a'.repeat(64),
  }),
});
const result = Object.freeze({
  version: 1,
  websiteId: job.payload.websiteId,
  applicationId: job.payload.applicationId,
  actionId: job.payload.actionId,
  websiteRevision: 4,
  previewDigest: job.payload.previewDigest,
  completed: true,
  sideEffects: true,
});

test('sanitizer accepts only exact safe PHP action evidence', () => {
  assert.deepEqual(sanitizeWebsitePhpToolJobResult(job, result), result);
});

for (const [name, patch] of Object.entries({
  websiteId: { websiteId: '33333333-3333-4333-8333-333333333333' },
  applicationId: { applicationId: '33333333-3333-4333-8333-333333333333' },
  actionId: { actionId: 'plugin.update-all' },
  websiteRevision: { websiteRevision: 5 },
  previewDigest: { previewDigest: 'b'.repeat(64) },
  completed: { completed: false },
  sideEffects: { sideEffects: false },
  extra: { stdout: 'must not persist' },
})) {
  test(`sanitizer rejects ${name} mismatch or extra output`, () => {
    assert.throws(() => sanitizeWebsitePhpToolJobResult(job, { ...result, ...patch }));
  });
}
