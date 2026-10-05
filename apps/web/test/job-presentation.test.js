import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
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
} from '../src/workspace/job-presentation.js';

test('job resource links prefer exact linked site routes when available', () => {
  const applicationId = '11111111-1111-4111-8111-111111111111';
  const websiteId = '22222222-2222-4222-8222-222222222222';
  const domainId = '33333333-3333-4333-8333-333333333333';
  const certificateId = '44444444-4444-4444-8444-444444444444';
  const resources = {
    websites: [{ id: websiteId, applicationId }],
    domains: [{ id: domainId, websiteId, certificateId }],
  };
  assert.deepEqual(jobResourceTarget({ resourceType: 'application', resourceId: applicationId }, resources), {
    label: 'Uygulama', href: `/websites/${domainId}/node`,
  });
  assert.deepEqual(jobResourceTarget({ resourceType: 'certificate', resourceId: certificateId }, resources), {
    label: 'Sertifika', href: `/websites/${domainId}/ssl`,
  });
  assert.deepEqual(jobResourceTarget({ resourceType: 'mail_domain', resourceId: domainId }), {
    label: 'Mail domain', href: `/mail/${domainId}`,
  });
  assert.deepEqual(jobResourceTarget({ resourceType: 'docker_project', resourceId: domainId }), {
    label: 'Docker projesi', href: `/docker/${domainId}`,
  });
  assert.deepEqual(jobResourceTarget({ resourceType: 'website', resourceId: websiteId }, resources), {
    label: 'Web sitesi', href: `/websites/${domainId}/overview`,
  });
  assert.deepEqual(jobResourceTarget({ resourceType: 'job', resourceId: '11111111-1111-4111-8111-111111111111' }), {
    label: 'İşlem', href: '/jobs',
  });
});

for (const [status, stage] of [
  ['saving', 'Kaydediliyor'], ['queued', 'Kuyrukta'], ['running', 'Sunucuda çalışıyor'],
  ['applying', 'Uygulanıyor'], ['verifying', 'Doğrulanıyor'], ['partial', 'Kısmi başarılı'],
  ['succeeded', 'Tamamlandı'], ['failed', 'Başarısız'], ['cancelled', 'İptal edildi'], ['unexpected', 'Bilinmiyor'],
]) {
  test(`${status} reports its actual state, never a fabricated fraction or attempt budget`, () => {
    const job = Object.freeze({ status, attempts: 3, progress: 100 });
    const value = jobLifecycle(job);
    assert.equal(value.stage, stage);
    assert.equal(value.progress, '—');
    assert.doesNotMatch(value.detail, /[0-9]\s*\/\s*[0-9]|%|claim|terminal/);
    assert.equal(Object.isFrozen(value), true);
  });
}

test('missing job remains unknown instead of completed or zero attempts', () => {
  assert.equal(jobLifecycle(null).stage, 'Bilinmiyor');
  assert.equal(jobLifecycle().progress, '—');
  assert.equal(jobAttemptCount(null), null);
  assert.equal(jobAttemptCount(), null);
});

test('attempt counts preserve a real zero and never infer a maximum or coerce missing values', () => {
  for (const attempts of [0, 1, 3, 12, Number.MAX_SAFE_INTEGER]) {
    assert.equal(jobAttemptCount({ attempts }), attempts);
  }
  for (const attempts of [undefined, null, false, '', '3', -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(jobAttemptCount({ attempts }), null);
  }
});

test('safe job metadata exposes only bounded allowlisted scalars', () => {
  const metadata = safeJobResultMetadata({ result: {
    commitSha: 'a'.repeat(40),
    healthy: true,
    port: 3000,
    privateKey: 'do-not-render',
    environment: { SECRET: 'do-not-render' },
    status: 'validated',
    serviceName: 'yunpanel-node-deadbeef.service',
    ignoredLongValue: 'x'.repeat(300),
  } });
  assert.deepEqual(metadata, [
    ['Sonuç', 'validated'],
    ['Servis', 'yunpanel-node-deadbeef.service'],
    ['Commit', 'a'.repeat(40)],
    ['Port', 3000],
    ['Sağlık', 'Evet'],
  ]);
  assert.equal(JSON.stringify(metadata).includes('do-not-render'), false);
});

test('only deployment jobs expose deploy log surface', () => {
  assert.equal(jobSupportsDeployLogs({ operation: 'app.static.deploy' }), true);
  assert.equal(jobSupportsDeployLogs({ operation: 'app.node.deploy' }), true);
  assert.equal(jobSupportsDeployLogs({ operation: 'mail.config.apply' }), false);
});

test('job health indicator separates health status from execution attempts and rejects false 0/3 counters', () => {
  // A 0/3 health check pass count must never be displayed as 0/3 attempts
  const unhealthyJob = {
    status: 'running',
    attempts: 1,
    healthCheck: { satisfied: false, passed: 0, total: 3, statusCode: 503 },
  };
  const health = jobHealthIndicator(unhealthyJob);
  assert.equal(health.satisfied, false);
  assert.equal(health.status, 'unhealthy');
  assert.equal(health.label, 'Sağlıksız');
  assert.equal(health.passed, 0);
  assert.equal(health.total, 3);
  assert.equal(health.statusCode, 503);
  // Real attempt count remains 1, completely separate from the 0/3 health ratio
  assert.equal(jobAttemptCount(unhealthyJob), 1);

  const healthyJob = {
    status: 'succeeded',
    attempts: 0,
    health: { satisfied: true, passed: 3, total: 3, statusCode: 200 },
  };
  const healthy = jobHealthIndicator(healthyJob);
  assert.equal(healthy.satisfied, true);
  assert.equal(healthy.status, 'healthy');
  assert.equal(healthy.label, 'Sağlıklı');
  assert.equal(healthy.passed, 3);
  assert.equal(healthy.total, 3);
  assert.equal(jobAttemptCount(healthyJob), 0);

  // Shorthand boolean health
  assert.deepEqual(jobHealthIndicator({ health: { healthy: true } }), {
    satisfied: true,
    status: 'healthy',
    label: 'Sağlıklı',
    statusCode: null,
    passed: 1,
    total: 1,
  });
  assert.deepEqual(jobHealthIndicator({ health: { healthy: false } }), {
    satisfied: false,
    status: 'unhealthy',
    label: 'Sağlıksız',
    statusCode: null,
    passed: 0,
    total: 1,
  });

  // Missing or non-object health returns null
  assert.equal(jobHealthIndicator(null), null);
  assert.equal(jobHealthIndicator({}), null);
  assert.equal(jobHealthIndicator({ health: null }), null);
  assert.equal(jobHealthIndicator({ health: 'healthy' }), null);
});

test('job stage progress strictly distinguishes phases from execution attempts and rejects false percentages', () => {
  // Stage progress from stages object (0/3 stages is NOT 0/3 attempts)
  const stageJob = {
    status: 'running',
    attempts: 1,
    stages: { current: 0, total: 3 },
  };
  const stageProgress = jobStageProgress(stageJob);
  assert.equal(stageProgress.current, 0);
  assert.equal(stageProgress.total, 3);
  assert.equal(stageProgress.label, '0/3 aşama');
  assert.equal(stageProgress.completed, false);
  assert.equal(stageProgress.isPercentage, false);
  assert.equal(jobAttemptCount(stageJob), 1);

  // Stage progress from progress object (e.g. provisioning recovery)
  const provJob = {
    status: 'running',
    attempts: 0,
    progress: { required: 3, completed: 1, remaining: 2 },
  };
  const provProgress = jobStageProgress(provJob);
  assert.equal(provProgress.current, 1);
  assert.equal(provProgress.total, 3);
  assert.equal(provProgress.label, '1/3 adım');
  assert.equal(provProgress.completed, false);
  assert.equal(provProgress.isPercentage, false);
  assert.equal(jobAttemptCount(provJob), 0);

  // Stage progress from steps array
  const stepsJob = {
    status: 'running',
    attempts: 2,
    steps: [
      { id: 's1', state: 'succeeded', required: true },
      { id: 's2', state: 'pending', required: true },
      { id: 's3', state: 'pending', required: true },
    ],
  };
  const stepsProgress = jobStageProgress(stepsJob);
  assert.equal(stepsProgress.current, 1);
  assert.equal(stepsProgress.total, 3);
  assert.equal(stepsProgress.label, '1/3 adım');
  assert.equal(stepsProgress.completed, false);
  assert.equal(stepsProgress.isPercentage, false);
  assert.equal(jobAttemptCount(stepsJob), 2);

  // CRITICAL: Failed and cancelled jobs must NEVER appear completed, 3/3, or 100% even if all stages are reached
  const failedAllStages = {
    status: 'failed',
    attempts: 3,
    stages: { current: 3, total: 3 },
  };
  const failedProg = jobStageProgress(failedAllStages);
  assert.equal(failedProg.completed, false);
  assert.notEqual(failedProg.current, failedProg.total);
  assert.doesNotMatch(failedProg.label, /3\s*\/\s*3/);

  const cancelledAllStages = {
    status: 'cancelled',
    attempts: 1,
    stages: { current: 3, total: 3 },
  };
  const cancelledProg = jobStageProgress(cancelledAllStages);
  assert.equal(cancelledProg.completed, false);
  assert.notEqual(cancelledProg.current, cancelledProg.total);
  assert.doesNotMatch(cancelledProg.label, /3\s*\/\s*3/);

  // Succeeded job with all stages reached is completed
  const succeededAllStages = {
    status: 'succeeded',
    attempts: 1,
    stages: { current: 3, total: 3 },
  };
  const succeededProg = jobStageProgress(succeededAllStages);
  assert.equal(succeededProg.completed, true);

  // Missing or invalid stage data returns null
  assert.equal(jobStageProgress(null), null);
  assert.equal(jobStageProgress({}), null);
  assert.equal(jobStageProgress({ stages: { current: '0', total: '3' } }), null);
});

test('job lifecycle never treats fixed 1/3, 2/3, 3/3 states as completion percentages or presents failure as success', () => {
  const allStatuses = ['saving', 'queued', 'running', 'applying', 'verifying', 'partial', 'succeeded', 'failed', 'cancelled', 'unexpected'];
  for (const status of allStatuses) {
    const lifecycle = jobLifecycle({ status, attempts: 2 });
    assert.equal(lifecycle.progress, '—', `status ${status} must have progress '—'`);
    assert.doesNotMatch(lifecycle.progress, /[0-9]\s*\/\s*[0-9]|%/, `status ${status} must not return fraction or %`);
    assert.doesNotMatch(lifecycle.detail, /[0-9]\s*\/\s*[0-9]|%/, `status ${status} detail must not return fraction or %`);
  }

  // Failed jobs must explicitly indicate failure, never success
  const failedLifecycle = jobLifecycle({ status: 'failed', attempts: 3 });
  assert.equal(failedLifecycle.stage, 'Başarısız');
  assert.ok(failedLifecycle.detail.includes('başarısız'));
  assert.ok(!failedLifecycle.detail.includes('başarıyla'));
  assert.equal(failedLifecycle.isSuccessful, false);

  // Cancelled jobs must explicitly indicate cancellation, never success
  const cancelledLifecycle = jobLifecycle({ status: 'cancelled', attempts: 1 });
  assert.equal(cancelledLifecycle.stage, 'İptal edildi');
  assert.ok(cancelledLifecycle.detail.includes('kapatıldı'));
  assert.ok(!cancelledLifecycle.detail.includes('başarıyla'));
  assert.equal(cancelledLifecycle.isSuccessful, false);

  // Succeeded jobs indicate completion
  const succeededLifecycle = jobLifecycle({ status: 'succeeded', attempts: 1 });
  assert.equal(succeededLifecycle.stage, 'Tamamlandı');
  assert.equal(succeededLifecycle.isSuccessful, true);
});

test('manual retry via Yeniden dene allows authorized users to retry exhausted jobs within max limit', () => {
  const exhaustedFailedJob = {
    id: 'job-exhausted-1',
    status: 'failed',
    attempts: 3,
    retryExhausted: true,
    maxAttempts: 10,
    canRetry: true,
  };

  // Authorized user (canManage: true) can trigger manual retry
  assert.equal(jobSupportsManualRetry(exhaustedFailedJob, { canManage: true }), true);
  assert.equal(canTriggerManualRetry(exhaustedFailedJob, { canManage: true }), true);

  // Unauthorized user (canManage: false) is strictly forbidden
  assert.equal(jobSupportsManualRetry(exhaustedFailedJob, { canManage: false }), false);
  assert.equal(canTriggerManualRetry(exhaustedFailedJob, { canManage: false }), false);

  // Max attempts reached prevents further manual retry
  assert.equal(jobSupportsManualRetry({ ...exhaustedFailedJob, attempts: 10 }, { canManage: true }), false);

  // Permanent failure without manual override is not retryable
  assert.equal(jobSupportsManualRetry({ ...exhaustedFailedJob, permanentError: true, manualRetryAllowed: false }, { canManage: true }), false);

  // Permanent failure with manual override is retryable
  assert.equal(jobSupportsManualRetry({ ...exhaustedFailedJob, permanentError: true, manualRetryAllowed: true }, { canManage: true }), true);

  // Non-failed job without canRetry is not retryable
  assert.equal(jobSupportsManualRetry({ id: 'job-2', status: 'running', attempts: 1 }, { canManage: true }), false);
  assert.equal(jobSupportsManualRetry({ id: 'job-3', status: 'queued', attempts: 0 }, { canManage: true }), false);
  assert.equal(jobSupportsManualRetry({ id: 'job-4', status: 'succeeded', attempts: 1 }, { canManage: true }), false);

  // Invalid job arguments fail safely
  assert.equal(jobSupportsManualRetry(null, { canManage: true }), false);
  assert.equal(jobSupportsManualRetry(undefined, { canManage: true }), false);
  assert.equal(jobSupportsManualRetry('job', { canManage: true }), false);
});

test('UI components JobDrawer, JobsTable and JobList decouple stage, health and attempt indicators', async () => {
  const [drawerSource, tableSource, listSource] = await Promise.all([
    readFile(new URL('../src/workspace/JobDrawer.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/JobsTable.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/JobList.jsx', import.meta.url), 'utf8'),
  ]);

  // Both components must import attempt count, health indicator and stage progress
  assert.match(drawerSource, /jobAttemptCount/);
  assert.match(drawerSource, /jobHealthIndicator/);
  assert.match(drawerSource, /jobStageProgress/);
  assert.match(tableSource, /jobAttemptCount/);
  assert.match(tableSource, /jobHealthIndicator/);
  assert.match(tableSource, /jobStageProgress/);

  // Neither component should render misleading fixed fractions
  assert.doesNotMatch(drawerSource, /lifecycle\.progress|[123]\s*\/\s*3/);
  assert.doesNotMatch(tableSource, /lifecycle\.progress|[123]\s*\/\s*3/);

  // Both components must support manual retry for authorized users
  assert.match(drawerSource, /jobSupportsManualRetry/);
  assert.match(drawerSource, /Yeniden dene/);
  assert.match(tableSource, /jobSupportsManualRetry/);
  assert.match(tableSource, /Yeniden dene/);

  // JobDrawer must support cancellation for queued jobs
  assert.match(drawerSource, /job\?\.status === 'queued'/);
  assert.match(drawerSource, /handleCancel/);
  assert.match(drawerSource, /İşi iptal et/);

  // JobList must preserve real 0 attempts and not silently coerce missing/corrupt values
  assert.match(listSource, /jobAttemptCount/);
  assert.doesNotMatch(listSource, /job\.attempts \?\? 0/);
});
