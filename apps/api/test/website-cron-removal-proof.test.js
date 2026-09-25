import assert from 'node:assert/strict';
import test from 'node:test';
import { createCronRemovalRequest } from '../src/website-cron-removal-request.js';
import { verifyCronHostRemoval, verifyCronRemovalJob } from '../src/website-cron-removal-proof.js';
import { createLocalWebsiteCronOperation } from '../src/local-website-cron-operation.js';
import { createWebsiteCronApplyService } from '../src/website-cron-apply-service.js';
import { task, website, taskId, otherId, serverId, jobId, jobFor } from './fixtures/cron-removal-fixture.js';

const actor = Object.freeze({
  sessionId: '77777777-7777-4777-8777-777777777777',
  userId: '88888888-8888-4888-8888-888888888888',
  role: 'owner',
});

function operationHarness() {
  let current = task(); const calls = [];
  const hash = createCronRemovalRequest(current).identity.desiredStateSha256;
  const registry = { getTask: async () => current, deleteTask: async (id, { expectedRevision }) => {
    calls.push('metadata'); assert.equal(id, taskId); assert.equal(expectedRevision, 3);
    current = null; return { taskId, deleted: true };
  } };
  const manager = { apply: async () => { throw new Error('must not apply'); }, remove: async (input) => {
    calls.push('host'); assert.equal(input.taskId, taskId); assert.equal(input.user, task().unixUser);
    return { taskId, removed: true, previousSha256: hash, sideEffects: true };
  } };
  const receiptStore = { write: async (receipt) => { calls.push('receipt'); assert.equal(receipt.jobId, jobId); } };
  return { registry, manager, receiptStore, calls, setTask: (value) => { current = value; }, hash,
    execute: () => createLocalWebsiteCronOperation({ websiteCronRegistry: registry, websiteCronManager: manager, receiptStore })
      .execute('cron.remove', createCronRemovalRequest(task()).request.payload,
        { jobId, serverId, resourceType: 'website_cron', resourceId: taskId }) };
}

test('existing host remove precedes metadata and durable receipt, with unchanged safe result shape', async () => {
  const run = operationHarness(); const result = await run.execute();
  assert.deepEqual(run.calls, ['host', 'metadata', 'receipt']);
  assert.equal(result.removed, true); assert.equal(result.taskId, taskId);
  assert.equal(result.contentSha256, run.hash); assert.equal(await run.registry.getTask(taskId), null);
});
test('proven prior host absence may finalize the record without claiming host side effects', async () => {
  const run = operationHarness(); run.manager.remove = async () => ({ taskId, removed: false, previousSha256: null, sideEffects: false });
  const result = await run.execute(); assert.equal(result.removed, true); assert.equal(result.sideEffects, false); assert.equal(result.contentSha256, null);
});
for (const result of [null, {}, { taskId: otherId, removed: true },
  { taskId, removed: false, previousSha256: 'a'.repeat(64), sideEffects: false },
  { taskId, removed: true, previousSha256: null, sideEffects: true },
  { taskId, removed: true, previousSha256: 'a'.repeat(64), sideEffects: true }]) {
  test('unverified host removal never deletes cron metadata', async () => {
    const run = operationHarness(); run.manager.remove = async () => result;
    await assert.rejects(run.execute(), { code: 'website_cron_removal_unverified' });
    assert.equal(run.calls.includes('metadata'), false); assert.equal(run.calls.includes('receipt'), false);
  });
}
for (const patch of [{ id: otherId }, { serverId: otherId }, { websiteId: otherId },
  { applicationId: otherId }, { unixUser: 'yunapp-abcdefabcdef' }, { revision: 4 }, { command: '/bin/false' }]) {
  test('retargeted or changed queued task cannot invoke the host remover', async () => {
    const run = operationHarness(); run.setTask(task(patch)); await assert.rejects(run.execute()); assert.deepEqual(run.calls, []);
  });
}
test('missing metadata finalizer is detected before the host is changed', async () => {
  const run = operationHarness(); delete run.registry.deleteTask;
  await assert.rejects(run.execute(), { code: 'website_cron_cleanup_unavailable' }); assert.deepEqual(run.calls, []);
});
for (const result of [null, { taskId, deleted: false }, { taskId: otherId, deleted: true }]) {
  test('unverified metadata deletion is partial failure, not removal success', async () => {
    const run = operationHarness(); run.registry.deleteTask = async () => result;
    await assert.rejects(run.execute(), { code: 'website_cron_cleanup_unverified' }); assert.deepEqual(run.calls, ['host']);
  });
}
test('a success response with a remaining registry record cannot complete removal', async () => {
  const run = operationHarness(); run.registry.deleteTask = async () => ({ taskId, deleted: true });
  await assert.rejects(run.execute(), { code: 'website_cron_cleanup_unverified' });
});
test('receipt persistence failure is visible after host and metadata cleanup', async () => {
  const run = operationHarness(); run.receiptStore.write = async () => { throw new Error('private disk detail'); };
  await assert.rejects(run.execute(), (error) => error.code === 'website_cron_receipt_unavailable' && !error.message.includes('private'));
  assert.equal(await run.registry.getTask(taskId), null);
});
for (const field of ['taskId', 'websiteId', 'applicationId', 'unixUser', 'revision', 'desiredStateSha256', 'contentSha256', 'removed']) {
  test(`completed job must match ${field} before it becomes cleanup evidence`, () => {
    const job = jobFor(task(), { status: 'succeeded' }); job.result[field] = 'wrong';
    assert.throws(() => verifyCronRemovalJob(job, createCronRemovalRequest(task()).identity), { code: 'website_cron_removal_unverified' });
  });
}
test('job projection excludes command, payload and arbitrary raw error text', () => {
  const job = { ...jobFor(), payload: { command: 'private' }, error: 'private' };
  assert.deepEqual(verifyCronRemovalJob(job, createCronRemovalRequest(task()).identity), { id: jobId, status: 'queued' });
  assert.throws(() => verifyCronHostRemoval({ taskId, removed: false, previousSha256: null }, createCronRemovalRequest(task()).identity));
});
test('standalone delete queues the existing request but does not claim deletion at acceptance', async () => {
  const value = task(); let queued;
  const registry = { getTask: async () => value, createTask() {}, updateTask() {}, deleteTask() {} };
  const service = createWebsiteCronApplyService({ websiteCronRegistry: registry, websiteRegistry: { getWebsite: async () => website() },
    jobRegistry: { enqueue: async (request) => { queued = request; return jobFor(); } } });
  const result = await service.deleteCron(taskId, { expectedRevision: value.revision }, actor);
  assert.equal(result.accepted, true); assert.equal(result.deleted, false); assert.equal(result.job.id, jobId);
  assert.deepEqual(queued, createCronRemovalRequest(value, actor).request);
});
test('missing reconciliation cannot report the cron service and all tasks as healthy', async () => {
  const registry = { getTask() {}, createTask() {}, updateTask() {}, deleteTask() {}, listTasks: async () => [task()] };
  const service = createWebsiteCronApplyService({ websiteCronRegistry: registry, websiteRegistry: { getWebsite: async () => website() }, jobRegistry: { enqueue() {} } });
  const result = await service.listCrons(website().id);
  assert.equal(result.cronServiceActive, null); assert.equal(result.reconciled, false); assert.equal(result.summary.ready, 0); assert.equal(result.summary.unknown, 1);
});
