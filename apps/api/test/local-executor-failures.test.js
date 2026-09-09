import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJobExecutor } from '../src/local-job-executor.js';

const serverId = 'local-server';
const id = '12345678-1234-4234-8234-123456789012';
const job = { id, serverId, status: 'running', operation: 'system.packages.inspect' };
const claim = () => ({ job: { ...job }, envelope: { id, operation: job.operation, payload: {} } });
const result = { packageName: 'yunpanel', installed: false, installedVersion: null, candidateVersion: null, updateAvailable: false };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, overrides = {}) {
  const calls = { claims: 0, executions: 0, completions: [], reconciliations: 0 };
  const executor = createLocalJobExecutor({
    serverId, pollMs: 50,
    jobRegistry: {
      claimNext: async () => { calls.claims++; return overrides.claim ? overrides.claim() : claim(); },
      complete: async (input) => {
        calls.completions.push(input);
        return overrides.complete ? overrides.complete(input) : { ...job, status: input.status, result: input.result ?? null, error: input.error ?? null };
      },
    },
    executeOperation: async (operation, payload) => {
      calls.executions++;
      assert.equal(operation, job.operation);
      assert.deepEqual(payload, {});
      return overrides.execute ? overrides.execute() : result;
    },
    reconcileCompletedJob: async (terminal) => {
      calls.reconciliations++;
      return overrides.reconcile ? overrides.reconcile(terminal) : { reconciled: true };
    },
    onError: overrides.onError,
  });
  t.after(() => executor.stop());
  return { executor, calls };
}

test('successful host execution is never rewritten as failure when completion storage rejects', async t => {
  const { executor, calls } = fixture(t, { complete: () => { throw new Error('disk error with sensitive path'); } });
  await assert.rejects(executor.runOnce(), { code: 'local_completion_unconfirmed', phase: 'complete', jobId: id });
  assert.equal(calls.executions, 1);
  assert.deepEqual(calls.completions.map(x => x.status), ['succeeded']);
  assert.equal(calls.reconciliations, 0);
  await assert.rejects(executor.runOnce(), { code: 'local_completion_unconfirmed' });
  assert.throws(() => executor.start(), { code: 'local_completion_unconfirmed' });
  assert.equal(calls.claims, 1);
  assert.equal(executor.running(), false);
  assert.ok(!JSON.stringify(executor.failure()).includes('sensitive'));
});

test('failure saving a failed host outcome is attempted once, not recursively completed', async t => {
  const { executor, calls } = fixture(t, {
    execute: () => { throw Object.assign(new Error('host error'), { code: 'apt_failed' }); },
    complete: () => { throw new Error('read-only filesystem'); },
  });
  await assert.rejects(executor.runOnce(), { code: 'local_completion_unconfirmed' });
  assert.deepEqual(calls.completions.map(x => x.status), ['failed']);
  assert.equal(calls.reconciliations, 0);
});

test('result-write acknowledgement lost after persistence still halts without executing again', async t => {
  let stored;
  const { executor, calls } = fixture(t, { complete: input => { stored = input; throw new Error('acknowledgement lost'); } });
  await assert.rejects(executor.runOnce());
  await assert.rejects(executor.runOnce());
  assert.equal(stored.status, 'succeeded');
  assert.equal(calls.executions, 1);
  assert.equal(calls.completions.length, 1);
});

test('reconciliation failure retains the terminal outcome and prevents another claim', async t => {
  const { executor, calls } = fixture(t, { reconcile: () => { throw new Error('private registry details'); } });
  await assert.rejects(executor.runOnce(), { code: 'local_reconciliation_failed', phase: 'reconcile', jobId: id });
  await executor.stop();
  await assert.rejects(executor.runOnce(), { code: 'local_reconciliation_failed' });
  assert.equal(calls.claims, 1);
  assert.equal(calls.completions[0].status, 'succeeded');
  assert.equal(calls.reconciliations, 1);
});

test('uncertain claim never reaches the host or claims another job', async t => {
  const { executor, calls } = fixture(t, { claim: () => { throw new Error('claim write failed'); } });
  await assert.rejects(executor.runOnce(), { code: 'local_claim_unconfirmed', jobId: null });
  await assert.rejects(executor.runOnce());
  assert.equal(calls.executions, 0); assert.equal(calls.claims, 1);
});

for (const [label, changed] of [
  ['another server', () => ({ ...claim(), job: { ...job, serverId: 'other' } })],
  ['envelope mismatch', () => ({ ...claim(), envelope: { ...claim().envelope, id: 'another-job' } })],
  ['operation mismatch', () => ({ ...claim(), envelope: { ...claim().envelope, operation: 'system.upgrade' } })],
  ['unclaimed status', () => ({ ...claim(), job: { ...job, status: 'queued' } })],
  ['missing claim', () => undefined],
  ['array payload', () => ({ ...claim(), envelope: { ...claim().envelope, payload: [] } })],
]) {
  test(`inconsistent ${label} is rejected before any host call`, async t => {
    const { executor, calls } = fixture(t, { claim: changed });
    await assert.rejects(executor.runOnce(), { code: 'local_claim_invalid' });
    assert.equal(calls.executions, 0); assert.equal(calls.completions.length, 0);
  });
}
for (const [label, terminal] of [
  ['wrong ID', { ...job, id: 'another-job', status: 'succeeded' }],
  ['wrong server', { ...job, serverId: 'other', status: 'succeeded' }],
  ['wrong outcome', { ...job, status: 'failed' }],
  ['missing reply', null],
]) {
  test(`completion with ${label} cannot be reconciled as this job`, async t => {
    const { executor, calls } = fixture(t, { complete: () => terminal });
    await assert.rejects(executor.runOnce(), { code: 'local_completion_unconfirmed' });
    assert.equal(calls.reconciliations, 0); assert.equal(calls.completions.length, 1);
  });
}

test('ordinary host failures remain terminal failed jobs, with reconciliation', async t => {
  const { executor, calls } = fixture(t, { execute: () => { throw Object.assign(new Error('expected host failure'), { code: 'apt_failed' }); } });
  const completed = await executor.runOnce();
  assert.equal(completed.job.status, 'failed'); assert.equal(completed.job.error.code, 'apt_failed');
  assert.equal(calls.reconciliations, 1); assert.equal(executor.failure(), null);
});

test('concurrent callers share one host execution through completion and reconciliation', async t => {
  const hold = deferred();
  const { executor, calls } = fixture(t, { reconcile: () => hold.promise });
  const first = executor.runOnce(); const second = executor.runOnce();
  assert.equal(first, second);
  await tick(); assert.equal(calls.executions, 1);
  assert.equal(executor.runOnce(), first);
  hold.resolve({ reconciled: true }); await first;
});

test('stop drains the active operation and cannot be overtaken by start or manual work', async t => {
  const hold = deferred();
  const { executor, calls } = fixture(t, { execute: () => hold.promise });
  const work = executor.runOnce(); await tick();
  const stopped = executor.stop(); let drained = false; stopped.then(() => { drained = true; });
  await tick(); assert.equal(drained, false);
  assert.throws(() => executor.start(), { code: 'local_executor_stopping' });
  await assert.rejects(executor.runOnce(), { code: 'local_executor_stopping' });
  hold.resolve(result); await work; await stopped;
  assert.equal(calls.completions.length, 1); assert.equal(calls.reconciliations, 1);
  assert.equal(executor.running(), false);
});

test('background persistence failure reports safe metadata once and stops polling', async t => {
  const notified = deferred();
  const { executor, calls } = fixture(t, {
    complete: () => { throw new Error('PRIVATE_ENV_VALUE'); },
    onError: error => { notified.resolve(error); throw new Error('observer error'); },
  });
  executor.start(); executor.start();
  // Keep the loop alive: the production scheduler deliberately uses unref().
  const timeout = setTimeout(() => notified.resolve(new Error('test timeout')), 1000);
  t.after(() => clearTimeout(timeout));
  const error = await notified.promise;
  assert.equal(error.code, 'local_completion_unconfirmed');
  assert.equal(error.cause, undefined); assert.ok(!error.stack.includes('PRIVATE_ENV_VALUE'));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(calls.claims, 1); assert.equal(executor.running(), false);
});

test('idle runs return the existing result shape and create no failure latch', async t => {
  const { executor, calls } = fixture(t, { claim: () => null });
  assert.deepEqual(await executor.runOnce(), { claimed: false, job: null, reconciliation: null });
  assert.equal(calls.executions, 0); assert.equal(executor.failure(), null);
});

test('caller mutation of failure metadata cannot unhalt the executor', async t => {
  const { executor } = fixture(t, { claim: () => { throw new Error('failed'); } });
  await assert.rejects(executor.runOnce());
  const state = executor.failure(); state.code = 'rewritten'; state.phase = 'rewritten';
  assert.equal(executor.failure().phase, 'claim');
  await assert.rejects(executor.runOnce(), { code: 'local_claim_unconfirmed' });
});
