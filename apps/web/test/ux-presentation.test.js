import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_PREFERENCES, PREFERENCE_KEY, normalizePreferences, readPreferences, writePreferences, resolveTheme, navigationGroups, websiteCount, commandEntries, groupSiteTabs } from '../src/workspace/ui/ux-model.js';
import {
  jobAttemptCount,
  jobLifecycle,
  jobHealthIndicator,
  jobStageProgress,
  jobSupportsManualRetry,
  canTriggerManualRetry,
} from '../src/workspace/job-presentation.js';
import {
  createProvisioningRecovery,
  recoveryAllowed,
  recoveryBusy,
  recoveryOperation,
} from '../src/workspace/provisioning-recovery.js';
import { advanceProvisioning } from '../src/workspace/provisioning-advance.js';

test('preferences accept only the documented themes and density', () => {
  assert.deepEqual(normalizePreferences({ theme: 'dark', density: 'compact', token: 'secret' }), { theme: 'dark', density: 'compact' });
  assert.deepEqual(normalizePreferences({ theme: 'invalid', density: 'dense' }), DEFAULT_PREFERENCES);
  assert.deepEqual(normalizePreferences(null), DEFAULT_PREFERENCES);
});
test('malformed and unavailable storage do not break the workspace', () => {
  assert.deepEqual(readPreferences({ getItem: () => '{invalid' }), DEFAULT_PREFERENCES);
  assert.deepEqual(readPreferences({ getItem: () => { throw new Error('blocked'); } }), DEFAULT_PREFERENCES);
  assert.equal(writePreferences({ setItem: () => { throw new Error('quota'); } }, {}), false);
});
test('storage payload is restricted to two non-sensitive preferences', () => {
  let result;
  assert.equal(writePreferences({ setItem: (key, value) => { result = [key, JSON.parse(value)]; } }, { theme: 'light', density: 'compact', password: 'NEVER_STORE', domains: ['private'] }), true);
  assert.deepEqual(result, [PREFERENCE_KEY, { theme: 'light', density: 'compact' }]);
});
test('system theme follows OS and explicit theme wins', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});
test('read-only navigation retains only the existing authorized route set', () => {
  assert.deepEqual(navigationGroups(false).flatMap((group) => group.items.map(([to]) => to)), ['/websites', '/dashboard']);
  assert.deepEqual(navigationGroups(false, false).flatMap((group) => group.items.map(([to]) => to)), ['/websites']);
});
test('owner navigation keeps jobs and audit accessible through categorized settings', () => {
  const paths = navigationGroups(true).flatMap((group) => group.items.map(([to]) => to));
  assert.equal(paths.length, 7); assert.equal(new Set(paths).size, 7);
  assert.ok(paths.includes('/tools-settings')); assert.ok(!paths.includes('/jobs')); assert.ok(!paths.includes('/audit'));
  assert.ok(!paths.includes('/applications')); assert.ok(!paths.includes('/backups'));
});
test('website counter uses unique Website records, not hostnames or aliases', () => {
  assert.equal(websiteCount({ status: 'ready', items: [{ id: 'w1', aliases: ['a', 'b'] }, { id: 'w1' }, { id: 'w2' }] }), 2);
  assert.equal(websiteCount({ status: 'ready', items: [] }), 0);
});
test('unavailable inventories are never represented as zero', () => {
  for (const status of ['loading', 'idle', 'forbidden', 'unauthorized', 'error']) assert.equal(websiteCount({ status, items: [{ id: 'hidden' }] }), null);
});
test('command palette cannot expose unavailable or forbidden domain data', () => {
  for (const status of ['idle', 'loading', 'forbidden', 'unauthorized', 'error']) {
    const entries = commandEntries({ domains: { status, items: [{ id: 'private', primaryDomain: 'private.example' }] } });
    assert.ok(!entries.some((entry) => entry.id === 'domain:private'));
  }
});
test('read-only command palette does not expose mutation or management destinations', () => {
  const entries = commandEntries({ query: '', canManage: false });
  assert.deepEqual(entries.map((entry) => entry.to), ['/websites']);
});
test('domain search preserves Domain route identity and safely encodes it', () => {
  const result = commandEntries({ query: 'alias', domains: { status: 'ready', items: [{ id: 'd/one', websiteId: 'w1', primaryDomain: 'example.test', aliases: ['alias.test'] }] } });
  assert.equal(result[0].to, '/websites/d%2Fone/overview');
  assert.ok(result.some((entry) => entry.to === '/websites?q=alias'));
});
test('search has bounded domain suggestions and encodes query strings', () => {
  const domains = { status: 'ready', items: Array.from({ length: 100 }, (_, i) => ({ id: String(i), primaryDomain: `site${i}.test` })) };
  assert.equal(commandEntries({ query: 'site', domains }).filter((entry) => entry.id.startsWith('domain:')).length, 8);
  assert.equal(commandEntries({ query: 'a&b?#' }).at(-1).to, '/websites?q=a%26b%3F%23');
  assert.equal(new URL(commandEntries({ query: 'x'.repeat(500) }).at(-1).to, 'https://panel.test').searchParams.get('q').length, 253);
});
test('site grouping keeps every existing tab exactly once in at most six groups', () => {
  const tabs = ['overview', 'databases', 'node', 'deploy', 'domains', 'dns', 'ssl', 'files', 'logs', 'terminal', 'settings'].map((key) => [key, key]);
  const grouped = groupSiteTabs(tabs);
  assert.ok(grouped.length <= 6);
  assert.deepEqual(grouped.flatMap((group) => group.tabs.map(([key]) => key)).sort(), tabs.map(([key]) => key).sort());
});
test('runtime-filtered and future backend tabs remain reachable without placeholders', () => {
  assert.deepEqual(groupSiteTabs([['overview', 'Overview']]).map((group) => group.id), ['dashboard']);
  const grouped = groupSiteTabs([['overview', 'Overview'], ['future-runtime', 'New runtime']]);
  assert.ok(grouped.find((group) => group.id === 'extensions').tabs.some(([key]) => key === 'future-runtime'));
});

// BUG-20260923-01: Acceptance Criteria Tests

// AC1: Verify reported 0/3 progress indicator source and distinguish stage/health counters from actual execution attempt counts
test('BUG-20260923-01 AC1: verify reported 0/3 source and distinguish stage/health counters from execution attempts', () => {
  // Source 1: Provisioning step progress (0 completed out of 3 required steps is stage progress, NOT attempts)
  const websiteId = '11111111-1111-4111-8111-111111111111';
  const op = recoveryOperation({
    operationId: '22222222-2222-4222-8222-222222222222',
    websiteId,
    ready: false,
    status: 'pending',
    steps: [
      { id: 's1', kind: 'unix_identity', state: 'pending', required: true, canRetry: false, canCompensate: false, compensation: { state: 'not_required' } },
      { id: 's2', kind: 'runtime', state: 'pending', required: true, canRetry: false, canCompensate: false, compensation: { state: 'not_required' } },
      { id: 's3', kind: 'nginx', state: 'pending', required: true, canRetry: false, canCompensate: false, compensation: { state: 'not_required' } },
    ],
  }, websiteId);
  assert.deepEqual(op.progress, { required: 3, completed: 0, remaining: 3 });
  // The 0/3 in provisioning indicates 0 of 3 required steps completed, not an attempt budget.

  // Source 2: Health check indicators (0/3 health checks satisfied is health state, NOT execution attempts)
  const healthJob = {
    status: 'running',
    attempts: 1,
    healthCheck: { satisfied: false, passed: 0, total: 3, statusCode: 503 },
  };
  const healthInd = jobHealthIndicator(healthJob);
  assert.equal(healthInd.satisfied, false);
  assert.equal(healthInd.status, 'unhealthy');
  assert.equal(healthInd.label, 'Sağlıksız');
  assert.equal(healthInd.passed, 0);
  assert.equal(healthInd.total, 3);
  // Attempt count is 1, completely separate from the 0/3 health check counter:
  assert.equal(jobAttemptCount(healthJob), 1);

  // Source 3: Stage progress
  const stageJob = {
    status: 'running',
    attempts: 0,
    stages: { current: 0, total: 3 },
  };
  const stageProgress = jobStageProgress(stageJob);
  assert.equal(stageProgress.label, '0/3 aşama');
  assert.equal(stageProgress.isPercentage, false);
  assert.equal(stageProgress.completed, false);
  // Real zero attempts is strictly preserved and not confounded with stage counts
  assert.equal(jobAttemptCount(stageJob), 0);

  // Verify attempt count rules: 0 is preserved, missing/invalid is null, never coerced to 0/3 or max 3
  assert.equal(jobAttemptCount({ attempts: 0 }), 0);
  assert.equal(jobAttemptCount({ attempts: 3 }), 3);
  assert.equal(jobAttemptCount({ attempts: null }), null);
  assert.equal(jobAttemptCount({ attempts: undefined }), null);
  assert.equal(jobAttemptCount({ attempts: '0/3' }), null);
  assert.equal(jobAttemptCount({ attempts: -1 }), null);
});

// AC2: Ensure job-presentation.js does not treat fixed 1/3, 2/3, 3/3 lifecycle states as true completion percentages or present failed/cancelled jobs as successful
test('BUG-20260923-01 AC2: job-presentation does not treat fixed 1/3, 2/3, 3/3 states as completion percentages or disguise failed/cancelled as successful', async () => {
  // All lifecycle states must never return fixed fraction or percentage
  const states = ['saving', 'queued', 'running', 'applying', 'verifying', 'partial', 'succeeded', 'failed', 'cancelled', 'unexpected'];
  for (const status of states) {
    const lifecycle = jobLifecycle({ status, attempts: 2 });
    assert.equal(lifecycle.progress, '—');
    assert.doesNotMatch(lifecycle.progress, /[0-9]\s*\/\s*[0-9]|%/);
    assert.doesNotMatch(lifecycle.detail, /[0-9]\s*\/\s*[0-9]|%/);
  }

  // Failed and cancelled jobs must never be presented as successful
  const failedLifecycle = jobLifecycle({ status: 'failed', attempts: 3 });
  assert.equal(failedLifecycle.stage, 'Başarısız');
  assert.ok(failedLifecycle.detail.includes('başarısız'));
  assert.ok(!failedLifecycle.detail.includes('başarıyla'));

  const cancelledLifecycle = jobLifecycle({ status: 'cancelled', attempts: 1 });
  assert.equal(cancelledLifecycle.stage, 'İptal edildi');
  assert.ok(cancelledLifecycle.detail.includes('kapatıldı'));
  assert.ok(!cancelledLifecycle.detail.includes('başarıyla'));

  // Stage progress for failed/cancelled job with all stages reached is never marked completed
  assert.equal(jobStageProgress({ status: 'failed', stages: { current: 3, total: 3 } }).completed, false);
  assert.equal(jobStageProgress({ status: 'cancelled', stages: { current: 3, total: 3 } }).completed, false);
  assert.equal(jobStageProgress({ status: 'succeeded', stages: { current: 3, total: 3 } }).completed, true);

  // Verify UI templates do not contain fixed 1/3, 2/3, 3/3 or lifecycle.progress
  const [drawerSource, tableSource] = await Promise.all([
    readFile(new URL('../src/workspace/JobDrawer.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/JobsTable.jsx', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(drawerSource, /lifecycle\.progress|[123]\s*\/\s*3/);
  assert.doesNotMatch(tableSource, /lifecycle\.progress|[123]\s*\/\s*3/);
});

// AC3: Prevent redundant execution of successful operations and restrict automatic retry attempts to classified transient failures with bounded backoff and provider cooldown
test('BUG-20260923-01 AC3: prevent redundant execution of successful operations and restrict automatic retries', async () => {
  const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const websiteId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  // 1. Ready/succeeded operation: no redundant POST is executed
  let advanceCalls = 0;
  const readyOp = {
    operationId, websiteId, ready: true,
    steps: [{ id: 's1', kind: 'nginx', state: 'succeeded', required: true }],
  };
  const resultOp = await advanceProvisioning({
    operationId,
    read: async () => readyOp,
    advance: async () => { advanceCalls += 1; return { operationId, outcome: 'ready', stepId: null, operation: readyOp }; },
  });
  assert.equal(advanceCalls, 0); // ZERO advance calls for already ready operation
  assert.equal(resultOp.ready, true);

  // 2. Failed or blocked operation: halts automatic advancement immediately (no blind retry)
  const failedOp = {
    operationId, websiteId, ready: false,
    steps: [
      { id: 's1', kind: 'nginx', state: 'failed', required: true },
      { id: 's2', kind: 'runtime', state: 'pending', required: true },
    ],
  };
  advanceCalls = 0;
  const stoppedResult = await advanceProvisioning({
    operationId,
    read: async () => failedOp,
    advance: async () => { advanceCalls += 1; throw new Error('Must not be called'); },
  });
  assert.equal(advanceCalls, 0); // Stops immediately without blind automatic retry
  assert.equal(stoppedResult.steps[0].state, 'failed');

  // 3. Transient error during advance stops and propagates rather than blindly looping
  const pendingOp = {
    operationId, websiteId, ready: false,
    steps: [{ id: 's1', kind: 'nginx', state: 'pending', required: true }],
  };
  let attempts = 0;
  await assert.rejects(async () => {
    await advanceProvisioning({
      operationId,
      read: async () => pendingOp,
      advance: async () => {
        attempts += 1;
        const err = new Error('503 Service Unavailable');
        err.status = 503;
        throw err;
      },
    });
  }, (err) => {
    assert.equal(err.status, 503);
    assert.equal(attempts, 1); // Exactly 1 attempt, no infinite uncoordinated retry
    return true;
  });
});

// AC4: Ensure authorized users can trigger safe manual retry via 'Yeniden dene' even after automatic retry threshold is exhausted once underlying errors are corrected
test('BUG-20260923-01 AC4: authorized users can trigger safe manual retry via Yeniden dene after exhaustion', async () => {
  const websiteId = '11111111-1111-4111-8111-111111111111';
  const operationId = '22222222-2222-4222-8222-222222222222';

  // 1. jobSupportsManualRetry tests
  const exhaustedJob = {
    id: 'job-1',
    status: 'failed',
    attempts: 3, // automatic budget exhausted
    retryExhausted: true,
    maxAttempts: 10,
    canRetry: true,
  };
  // Authorized user (canManage: true) can trigger manual retry
  assert.equal(jobSupportsManualRetry(exhaustedJob, { canManage: true }), true);
  assert.equal(canTriggerManualRetry(exhaustedJob, { canManage: true }), true);
  // Unauthorized user (canManage: false) is rejected
  assert.equal(jobSupportsManualRetry(exhaustedJob, { canManage: false }), false);
  // System maximum limit reached cannot be retried
  assert.equal(jobSupportsManualRetry({ ...exhaustedJob, attempts: 10 }, { canManage: true }), false);
  // Permanent error without manual override cannot be retried
  assert.equal(jobSupportsManualRetry({ ...exhaustedJob, permanentError: true, manualRetryAllowed: false }, { canManage: true }), false);

  // 2. Provisioning recovery manual retry flow
  const failedStepOp = {
    operationId, websiteId, ready: false, status: 'failed',
    steps: [
      { id: 'nginx', kind: 'nginx', state: 'failed', required: true, canRetry: true, canCompensate: false, compensation: { state: 'not_required' } },
    ],
  };
  let retriedWith = null;
  const flow = createProvisioningRecovery({
    websiteId,
    read: async () => failedStepOp,
    execute: async (approval) => {
      retriedWith = approval;
      return {
        operationId,
        outcome: 'progressed',
        stepId: 'nginx',
        operation: {
          operationId, websiteId, ready: true, status: 'succeeded',
          steps: [{ id: 'nginx', kind: 'nginx', state: 'succeeded', required: true, canRetry: false, canCompensate: false, compensation: { state: 'not_required' } }],
        },
      };
    },
    canManage: () => true,
  });

  await flow.load();
  const approval = flow.prepare('retry', 'nginx');
  assert.equal(approval.action, 'retry');
  assert.equal(approval.stepId, 'nginx');
  assert.equal(approval.confirmation, `retry-site-provisioning:${operationId}:nginx`);

  const finalState = await flow.perform(approval, approval.confirmation);
  assert.equal(retriedWith.action, 'retry');
  assert.equal(finalState.status, 'ready');
  assert.equal(finalState.operation.ready, true);

  // 3. Verify 'Yeniden dene' label in UI panel
  const panelSource = await readFile(new URL('../src/workspace/ProvisioningRecoveryPanel.jsx', import.meta.url), 'utf8');
  assert.match(panelSource, /Yeniden dene/);
  assert.match(panelSource, /adımını yeniden dene/);
});

// AC5: Preserve existing provisioning recovery, resource locks, idempotency, partial success handling, and destructive confirmation protections while verifying double-click, restart, limit, and interrupted job scenarios
test('BUG-20260923-01 AC5: preserve recovery, locks, idempotency, partial success, and confirmation protections', async () => {
  const websiteId = '11111111-1111-4111-8111-111111111111';
  const operationId = '22222222-2222-4222-8222-222222222222';
  const initialOp = {
    operationId, websiteId, ready: false, status: 'failed',
    steps: [
      { id: 'nginx', kind: 'nginx', state: 'failed', required: true, canRetry: true, canCompensate: false, compensation: { state: 'not_required' } },
    ],
  };

  // 1. Double-click protection: while mutating, subsequent perform calls do not dispatch duplicate requests
  let executeCount = 0;
  let executeResolve;
  const executeCalled = new Promise((r) => { executeResolve = r; });
  const flow = createProvisioningRecovery({
    websiteId,
    read: async () => initialOp,
    execute: async () => {
      executeCount += 1;
      executeResolve();
      return {
        operationId, outcome: 'progressed', stepId: 'nginx',
        operation: {
          operationId, websiteId, ready: true,
          steps: [{ id: 'nginx', kind: 'nginx', state: 'succeeded', required: true, canRetry: false, canCompensate: false, compensation: { state: 'not_required' } }],
        },
      };
    },
    canManage: () => true,
  });
  await flow.load();
  const approval = flow.prepare('retry', 'nginx');
  assert.ok(approval);

  const firstCall = flow.perform(approval, approval.confirmation);
  assert.equal(recoveryBusy(flow.getState()), true);

  // Second rapid click (double-click) while first is in-flight:
  const secondCall = flow.perform(approval, approval.confirmation);

  await executeCalled;
  await Promise.all([firstCall, secondCall]);
  assert.equal(executeCount, 1); // Exactly 1 execution sent despite 2 perform invocations

  // 2. Idempotency & Stamped snapshot drift protection
  let serverOp = { ...initialOp, steps: [{ ...initialOp.steps[0] }] };
  const driftFlow = createProvisioningRecovery({
    websiteId,
    read: async () => serverOp,
    execute: async () => { throw new Error('Must not execute when drifted'); },
    canManage: () => true,
  });
  await driftFlow.load();
  const driftApproval = driftFlow.prepare('retry', 'nginx');

  // Server state changes before user performs
  serverOp = { ...initialOp, ready: true, steps: [{ ...initialOp.steps[0], state: 'succeeded', canRetry: false }] };
  const driftState = await driftFlow.perform(driftApproval, driftApproval.confirmation);
  assert.equal(driftState.approval, null); // Approval cleared due to drift
  assert.ok(driftState.error.includes('Kurulum kaydı değişti'));

  // 3. Destructive confirmation protection: mismatched confirmation rejected
  const confFlow = createProvisioningRecovery({
    websiteId,
    read: async () => initialOp,
    execute: async () => { throw new Error('Must not execute'); },
    canManage: () => true,
  });
  await confFlow.load();
  const confApproval = confFlow.prepare('retry', 'nginx');
  const rejectedState = await confFlow.perform(confApproval, 'invalid-confirmation-token');
  assert.equal(rejectedState.status, 'ready'); // Rejected without mutation

  // 4. Partial success handling in jobLifecycle
  const partialLifecycle = jobLifecycle({ status: 'partial' });
  assert.equal(partialLifecycle.stage, 'Kısmi başarılı');
  assert.ok(partialLifecycle.detail.includes('müdahale veya doğrulama gerektiriyor'));

  // 5. Interrupted job scenario in verifiedResult
  const interruptedOp = {
    operationId, websiteId, ready: false,
    steps: [{ id: 'nginx', kind: 'nginx', state: 'failed', required: true, canRetry: true, canCompensate: false, compensation: { state: 'not_required' } }],
  };
  const intFlow = createProvisioningRecovery({
    websiteId,
    read: async () => interruptedOp,
    execute: async () => ({
      operationId, outcome: 'interrupted', stepId: null, operation: interruptedOp,
    }),
    canManage: () => true,
  });
  await intFlow.load();
  const intApproval = intFlow.prepare('retry', 'nginx');
  const intState = await intFlow.perform(intApproval, intApproval.confirmation);
  assert.ok(intState.error.includes('Kurulum tamamlanmadı'));

  // 6. MaxSteps bounds check
  await assert.rejects(
    () => advanceProvisioning({ operationId, maxSteps: 0, read: async () => {}, advance: async () => {} }),
    /TypeError/
  );
  await assert.rejects(
    () => advanceProvisioning({ operationId, maxSteps: 101, read: async () => {}, advance: async () => {} }),
    /TypeError/
  );
});
