import assert from 'node:assert/strict';
import test from 'node:test';

// Run web job-presentation test suite as baseline
import '../../web/test/job-presentation.test.js';

import {
  jobPublicView,
  classifyJobError,
  isTransientJobError,
  isPermanentJobError,
} from '../src/job-registry.js';
import {
  jobAttemptCount,
  jobHealthIndicator,
  jobLifecycle,
  jobResourceTarget,
  jobStageProgress,
  jobSupportsDeployLogs,
  jobSupportsManualRetry,
  canTriggerManualRetry,
  safeJobResultMetadata,
} from '../../web/src/workspace/job-presentation.js';

test('Backend job presentation: jobPublicView strips private payloads and sensitive material', () => {
  const job = {
    id: '11111111-1111-4111-8111-111111111111',
    serverId: '22222222-2222-4222-8222-222222222222',
    type: 'ssl.renew',
    operation: 'ssl.renew',
    resourceType: 'certificate',
    resourceId: '33333333-3333-4333-8333-333333333333',
    status: 'succeeded',
    attempts: 0,
    payload: { privateKey: 'secret-key-material', token: 'super-secret' },
    result: {
      certName: 'example.com',
      validFrom: '2026-09-01T00:00:00.000Z',
      validTo: '2026-12-01T00:00:00.000Z',
      fingerprint256: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
      privateKeyPath: '/etc/letsencrypt/live/example.com/privkey.pem',
    },
    error: null,
  };

  const view = jobPublicView(job);
  assert.equal(view.id, job.id);
  assert.equal(view.status, 'succeeded');
  assert.equal(view.attempts, 0);
  assert.equal('payload' in view, false);
  assert.equal(JSON.stringify(view).includes('secret-key-material'), false);
  assert.equal(JSON.stringify(view).includes('super-secret'), false);
  assert.equal(JSON.stringify(view).includes('privkey.pem'), false);
});

test('Backend job presentation: jobPublicView preserves exact attempts and provides diagnosis on failure', () => {
  const failedJob = {
    id: '44444444-4444-4444-8444-444444444444',
    serverId: '22222222-2222-4222-8222-222222222222',
    type: 'domain.activate',
    operation: 'domain.activate',
    resourceType: 'domain',
    resourceId: '55555555-5555-4555-8555-555555555555',
    status: 'failed',
    attempts: 2,
    error: { code: 'nginx_config_invalid', message: 'Syntax error in nginx config' },
  };

  const view = jobPublicView(failedJob);
  assert.equal(view.attempts, 2);
  assert.equal(jobAttemptCount(view), 2);
  assert.equal(view.status, 'failed');
  assert.ok(view.diagnosis);
  assert.equal(typeof view.diagnosis.message, 'string');
  assert.equal(typeof view.diagnosis.action, 'string');
});

test('Backend job presentation: jobLifecycle correctly processes jobPublicView projections without fabricated progress', () => {
  const statuses = [
    ['queued', 'Kuyrukta'],
    ['running', 'Sunucuda çalışıyor'],
    ['succeeded', 'Tamamlandı'],
    ['failed', 'Başarısız'],
    ['cancelled', 'İptal edildi'],
  ];

  for (const [status, stage] of statuses) {
    const rawJob = {
      id: '66666666-6666-4666-8666-666666666666',
      serverId: '22222222-2222-4222-8222-222222222222',
      type: 'app.static.deploy',
      operation: 'app.static.deploy',
      resourceType: 'application',
      resourceId: '77777777-7777-4777-8777-777777777777',
      status,
      attempts: 1,
    };
    const view = jobPublicView(rawJob);
    const lifecycle = jobLifecycle(view);
    assert.equal(lifecycle.stage, stage);
    assert.equal(lifecycle.progress, '—');
    assert.doesNotMatch(lifecycle.progress, /[0-9]\s*\/\s*[0-9]|%/);
    assert.doesNotMatch(lifecycle.detail, /[0-9]\s*\/\s*[0-9]|%/);
  }
});

test('Backend job presentation: error classification maps correctly to presentation retry policies', () => {
  // Transient error
  assert.equal(classifyJobError({ code: 'dns_provider_rate_limited' }), 'transient');
  assert.equal(isTransientJobError({ code: 'dns_provider_rate_limited' }), true);
  assert.equal(isPermanentJobError({ code: 'dns_provider_rate_limited' }), false);

  // Permanent error
  assert.equal(classifyJobError({ code: 'invalid_configuration' }), 'permanent');
  assert.equal(isTransientJobError({ code: 'invalid_configuration' }), false);
  assert.equal(isPermanentJobError({ code: 'invalid_configuration' }), true);

  // Unknown error
  assert.equal(classifyJobError(null), 'unknown');
});

test('Backend job presentation: safeJobResultMetadata with jobPublicView output sanitizes deployment results', () => {
  const deployJob = {
    id: '88888888-8888-4888-8888-888888888888',
    serverId: '22222222-2222-4222-8222-222222222222',
    type: 'app.node.deploy',
    operation: 'app.node.deploy',
    resourceType: 'application',
    resourceId: '99999999-9999-4999-8999-999999999999',
    status: 'succeeded',
    attempts: 1,
    result: {
      status: 'validated',
      serviceName: 'yunpanel-node-abcdef0123456789.service',
      commitSha: 'c'.repeat(40),
      port: 8080,
      healthy: true,
      env: { DATABASE_PASSWORD: 'do-not-reveal-this' },
    },
  };

  const view = jobPublicView(deployJob);
  const metadata = safeJobResultMetadata(view);
  assert.deepEqual(metadata, [
    ['Sonuç', 'validated'],
    ['Servis', 'yunpanel-node-abcdef0123456789.service'],
    ['Commit', 'c'.repeat(40)],
    ['Port', 8080],
    ['Sağlık', 'Evet'],
  ]);
  assert.equal(JSON.stringify(metadata).includes('do-not-reveal-this'), false);
  assert.equal(jobSupportsDeployLogs(view), true);
});

test('Backend job presentation: jobSupportsManualRetry with API job state obeys permission and max attempts', () => {
  const view = jobPublicView({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    serverId: '22222222-2222-4222-8222-222222222222',
    type: 'mail.config.apply',
    operation: 'mail.config.apply',
    status: 'failed',
    attempts: 3,
    retryExhausted: true,
    maxAttempts: 5,
    canRetry: true,
  });

  assert.equal(jobSupportsManualRetry(view, { canManage: true }), true);
  assert.equal(canTriggerManualRetry(view, { canManage: true }), true);
  assert.equal(jobSupportsManualRetry(view, { canManage: false }), false);
  assert.equal(canTriggerManualRetry(view, { canManage: false }), false);
});
