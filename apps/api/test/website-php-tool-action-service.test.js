import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsitePhpToolActionService } from '../src/website-php-tool-action-service.js';

const preview = Object.freeze({
  version: 1,
  websiteId: '11111111-1111-4111-8111-111111111111',
  serverId: '33333333-3333-4333-8333-333333333333',
  applicationId: '22222222-2222-4222-8222-222222222222',
  unixUser: 'yunapp-123456789abc',
  websiteRevision: 4,
  actionId: 'composer.dump-autoload',
  tool: 'composer',
  command: 'dump-autoload',
  args: Object.freeze(['--optimize']),
  timeout: 120000,
  label: 'Composer autoload dosyalarını yeniden oluştur',
  impact: 'vendor içindeki autoload metadata dosyaları yeniden oluşturulur; paket sürümleri değiştirilmez.',
  previewDigest: 'b'.repeat(64),
  confirmation: `php-tool:11111111-1111-4111-8111-111111111111:composer.dump-autoload:${'b'.repeat(64)}`,
});
const input = Object.freeze({
  actionId: preview.actionId,
  expectedWebsiteRevision: preview.websiteRevision,
  previewDigest: preview.previewDigest,
  confirmation: preview.confirmation,
});

test('action service enqueues exactly one application-scoped durable operation', async () => {
  const enqueued = [];
  const service = createWebsitePhpToolActionService({
    websitePhpToolsService: { getActionPreview: async () => preview },
    jobRegistry: {
      listJobs: async () => [],
      enqueue: async (value) => { enqueued.push(value); return { id: 'php-action-job-01', status: 'queued', ...value }; },
    },
  });
  const result = await service.queue(preview.websiteId, input);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].operation, 'website.php.action');
  assert.equal(enqueued[0].resourceType, 'application');
  assert.equal(enqueued[0].resourceId, preview.applicationId);
  assert.equal(enqueued[0].payload.actionId, preview.actionId);
  assert.equal(Object.hasOwn(enqueued[0].payload, 'command'), false);
  assert.equal(result.job.status, 'queued');
});

test('action service blocks when another Application job is active', async () => {
  let enqueued = false;
  const service = createWebsitePhpToolActionService({
    websitePhpToolsService: { getActionPreview: async () => preview },
    jobRegistry: {
      listJobs: async () => [{ id: 'existing-job', status: 'running' }],
      enqueue: async () => { enqueued = true; },
    },
  });
  await assert.rejects(() => service.queue(preview.websiteId, input), (error) => error.code === 'website_php_action_job_conflict');
  assert.equal(enqueued, false);
});
