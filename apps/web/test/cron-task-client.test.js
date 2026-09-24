import assert from 'node:assert/strict';
import test from 'node:test';
import { cronDraft, cronScope, cronTask, cronList, createCronTaskClient } from '../src/workspace/cron-task-client.js';

const websiteId = '11111111-1111-4111-8111-111111111111';
const serverId = '22222222-2222-4222-8222-222222222222';
const applicationId = '33333333-3333-4333-8333-333333333333';
const taskId = '44444444-4444-4444-8444-444444444444';
const foreignId = '55555555-5555-4555-8555-555555555555';
const jobId = '66666666-6666-4666-8666-666666666666';
const scope = { websiteId, serverId, applicationId, unixUser: 'yunapp-123456789abc' };
const draft = { name: 'Nightly task', schedule: '0 3 * * *', command: '/usr/bin/true', enabled: true };
const task = (patch = {}) => ({ id: taskId, ...scope, ...draft, revision: 1, ...patch });
const list = (tasks = [task()], patch = {}) => ({ websiteId, tasks, cronServiceActive: null, reconciled: false, ...patch });
const job = (value = task(), patch = {}) => ({ id: jobId, serverId, resourceId: value.id, resourceType: 'website_cron', operation: 'cron.apply', status: 'queued', result: null, ...patch });
const proof = (value = task(), patch = {}) => ({ version: 1, taskId: value.id, websiteId, applicationId, unixUser: scope.unixUser,
  revision: value.revision, desiredStateSha256: 'a'.repeat(64), contentSha256: 'a'.repeat(64), sideEffects: true, applied: true, ...patch });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function harness(options = {}) {
  const calls = [], observations = []; let handler = async (path) => path.endsWith('/crons') ? list() : task();
  const client = createCronTaskClient({ scope,
    request: (path, request = {}) => { calls.push({ path, ...request }); return handler(path, request); },
    onJob: (value, first) => observations.push({ value, first }), ...options });
  return { client, calls, observations, handle: (value) => { handler = value; }, writes: () => calls.filter((value) => value.method && value.method !== 'GET') };
}
async function accepted(h, kind = 'apply', value = task()) {
  await h.client.load();
  h.handle(async (path, options) => {
    if (!options.method) return value;
    return kind === 'remove' ? { accepted: true, deleted: false, websiteId, taskId: value.id, job: job(value, { operation: 'cron.remove' }) }
      : { task: value, job: job(value) };
  });
  assert.equal(await (kind === 'remove' ? h.client.remove(value) : h.client.save(draft)), true);
}

test('draft is narrow, normalized and preserves shell characters', () => {
  assert.deepEqual(cronDraft({ ...draft, name: ' Task ', schedule: '0  3 * * *', command: 'echo "100%"', root: true }), { ...draft, name: 'Task', command: 'echo "100%"' });
});
for (const [field, value] of [['name', ''], ['name', 'a'.repeat(81)], ['command', 'x\ny'], ['command', 'x'.repeat(4097)], ['schedule', '@daily'], ['enabled', 'true']]) {
  test(`invalid ${field} is rejected`, () => assert.throws(() => cronDraft({ ...draft, [field]: value })));
}
for (const field of ['websiteId', 'serverId', 'applicationId', 'unixUser']) {
  test(`invalid scope ${field} is rejected`, () => assert.throws(() => cronScope({ ...scope, [field]: '../root' })));
  test(`foreign task ${field} is rejected`, () => assert.throws(() => cronTask(task({ [field]: foreignId }), scope)));
}
test('raw inventory never implies host readiness', () => {
  assert.equal(cronList(list(), scope).items[0].hostState, 'unknown');
});
test('reconciliation taskId shape is supported without guessing a raw serverId', () => {
  const entry = { ...task(), taskId }; delete entry.id; delete entry.serverId;
  const host = { ...entry, expectedSha256: 'a'.repeat(64), currentSha256: 'a'.repeat(64), hostFileExists: true, hostFileExact: true };
  assert.equal(cronList(list([host], { cronServiceActive: true, reconciled: true }), scope).items[0].hostState, 'ready');
  assert.throws(() => cronTask(entry, scope));
  assert.throws(() => cronList(list([{ ...host, serverId: foreignId }]), scope));
});
for (const [patch, service, expected] of [[{ hostFileExists: false }, true, 'missing_host_file'], [{ hostFileExists: true, hostFileExact: false }, true, 'drifted'], [{}, false, 'service_inactive'], [{ status: 'ready' }, true, 'unknown']]) {
  test(`host state ${expected} uses evidence`, () => assert.equal(cronList(list([task(patch)], { cronServiceActive: service }), scope).items[0].hostState, expected));
}
test('duplicate, foreign or malformed inventory is rejected', () => {
  for (const value of [list([task(), task()]), list([], { websiteId: foreignId }), list([], { tasks: null }), list([], { cronServiceActive: undefined })]) assert.throws(() => cronList(value, scope));
});
test('create performs one existing POST and accepted is not success', async () => {
  const h = harness(); await accepted(h);
  assert.equal(h.writes().length, 1);
  assert.equal(h.writes()[0].path, `/websites/${websiteId}/crons`);
  assert.deepEqual(h.writes()[0].body, draft);
  assert.equal(h.client.getSnapshot().operation.phase, 'queued');
  assert.equal(h.observations[0].first, true);
});
test('update rechecks current task and uses one PATCH with revision', async () => {
  const h = harness(); await h.client.load(); const changed = { ...draft, enabled: false };
  h.handle(async (path, options) => !options.method ? task() : { task: task({ ...changed, revision: 2 }), job: job() });
  assert.equal(await h.client.save(changed, task()), true);
  assert.equal(h.writes()[0].method, 'PATCH');
  assert.deepEqual(h.writes()[0].body, { ...changed, expectedRevision: 1 });
});
test('delete uses explicit selected task and revision, never optimistic removal', async () => {
  const h = harness(); await accepted(h, 'remove');
  assert.equal(h.writes()[0].method, 'DELETE');
  assert.deepEqual(h.writes()[0].body, { expectedRevision: 1 });
  assert.equal(h.client.getSnapshot().items.length, 1);
  assert.equal(h.client.getSnapshot().operation.phase, 'queued');
});
test('stale revision or changed content prevents PATCH and DELETE', async () => {
  for (const patch of [{ revision: 2 }, { command: '/bin/false' }, { unixUser: 'yunapp-abcdef123456' }]) {
    for (const remove of [false, true]) {
      const h = harness(); await h.client.load(); h.handle(async () => task(patch));
      await (remove ? h.client.remove(task()) : h.client.save(draft, task()));
      assert.equal(h.writes().length, 0);
    }
  }
});
test('permission is rechecked after verification GET before mutation', async () => {
  let permitted = true; const h = harness({ canWrite: () => permitted }); await h.client.load();
  h.handle(async () => { permitted = false; return task(); });
  assert.equal(await h.client.remove(task()), false); assert.equal(h.writes().length, 0);
});
test('double click cannot enqueue twice', async () => {
  const h = harness(); await h.client.load(); const pending = deferred(); h.handle(() => pending.promise);
  const first = h.client.save(draft); assert.equal(await h.client.save(draft), false);
  pending.resolve({ task: task(), job: job() }); await first; assert.equal(h.writes().length, 1);
});
test('lost mutation response is unknown and refresh never resends it', async () => {
  const h = harness(); await h.client.load(); h.handle(async () => { throw new Error('connection lost'); });
  await h.client.save(draft); assert.equal(h.client.getSnapshot().operation.phase, 'unknown');
  assert.equal(await h.client.save(draft), false); assert.equal(h.client.acknowledgeUnknown(), false);
  h.handle(async () => list()); await h.client.load(); assert.equal(h.client.getSnapshot().operation.phase, 'unknown');
  assert.equal(h.writes().length, 1); assert.equal(h.client.acknowledgeUnknown(), true);
  assert.equal(h.client.getSnapshot().operation, null); assert.match(h.client.getSnapshot().error, /bilinmiyor/);
});
test('HTTP 500 after saved record is unknown, not safe to repeat', async () => {
  const h = harness(); await h.client.load(); h.handle(async () => { throw Object.assign(new Error(), { status: 500, code: 'queue_unavailable' }); });
  await h.client.save(draft); assert.equal(h.client.getSnapshot().operation.phase, 'unknown');
});
for (const patch of [{ resourceId: foreignId }, { serverId: foreignId }, { operation: 'mail.remove' }, { resourceType: 'website' }, { id: '../bad' }]) {
  test(`queued job mismatch ${Object.keys(patch)[0]} remains unknown`, async () => {
    const h = harness(); await h.client.load(); h.handle(async () => ({ task: task(), job: job(task(), patch) }));
    await h.client.save(draft); assert.equal(h.client.getSnapshot().operation.phase, 'unknown'); assert.equal(h.observations.length, 0);
  });
}
test('apply completion requires terminal proof and exact current task', async () => {
  const h = harness(); await accepted(h); h.handle(async (path) => path.startsWith('/jobs/') ? job(task(), { status: 'succeeded', result: proof() }) : list());
  assert.equal(await h.client.refreshOperation(), true); assert.equal(h.client.getSnapshot().operation.phase, 'succeeded'); assert.equal(h.writes().length, 1);
});
test('terminal success without result is not completion', async () => {
  const h = harness(); await accepted(h); h.handle(async () => job(task(), { status: 'succeeded' }));
  assert.equal(await h.client.refreshOperation(), false); assert.equal(h.client.getSnapshot().operation.phase, 'unverified');
});
for (const patch of [{ websiteId: foreignId }, { revision: 2 }, { contentSha256: 'b'.repeat(64) }, { unixUser: 'root' }]) {
  test(`terminal proof mismatch ${Object.keys(patch)[0]} is rejected`, async () => {
    const h = harness(); await accepted(h); h.handle(async () => job(task(), { status: 'succeeded', result: proof(task(), patch) }));
    await h.client.refreshOperation(); assert.equal(h.client.getSnapshot().operation.phase, 'unverified');
  });
}
test('different polled job ID cannot replace expected job', async () => {
  const h = harness(); await accepted(h); h.handle(async () => job(task(), { id: foreignId }));
  await h.client.refreshOperation(); assert.equal(h.client.getSnapshot().operation.phase, 'unverified');
});
test('metadata revision mismatch leaves successful apply verifying', async () => {
  const h = harness(); await accepted(h); h.handle(async (path) => path.startsWith('/jobs/') ? job(task(), { status: 'succeeded', result: proof() }) : list([task({ revision: 2 })]));
  assert.equal(await h.client.refreshOperation(), false); assert.equal(h.client.getSnapshot().operation.phase, 'verifying');
});
test('delete completion needs host proof plus absence in a fresh list', async () => {
  const h = harness(); await accepted(h, 'remove'); let tasks = [task()];
  h.handle(async (path) => path.startsWith('/jobs/') ? job(task(), { operation: 'cron.remove', status: 'succeeded', result: proof(task(), { removed: true }) }) : list(tasks));
  assert.equal(await h.client.refreshOperation(), false); assert.equal(h.client.getSnapshot().operation.phase, 'verifying');
  tasks = []; assert.equal(await h.client.refreshOperation(), true); assert.equal(h.client.getSnapshot().operation.phase, 'succeeded');
});
test('proven prior absence is a valid remove result', async () => {
  const h = harness(); await accepted(h, 'remove');
  h.handle(async (path) => path.startsWith('/jobs/') ? job(task(), { operation: 'cron.remove', status: 'succeeded', result: proof(task(), { removed: true, contentSha256: null, sideEffects: false }) }) : list([]));
  assert.equal(await h.client.refreshOperation(), true);
});
for (const status of ['failed', 'cancelled']) {
  test(`${status} job is not replayed or successful`, async () => {
    const h = harness(); await accepted(h); h.handle(async () => job(task(), { status }));
    assert.equal(await h.client.refreshOperation(), false); assert.equal(h.client.getSnapshot().operation.phase, 'failed');
    assert.equal(await h.client.refreshOperation(), false); assert.equal(h.writes().length, 1);
  });
}
test('poll failure retains known job and only GET is retried', async () => {
  const h = harness(); await accepted(h); h.handle(async () => { throw new Error('offline'); });
  await h.client.refreshOperation(); assert.equal(h.client.getSnapshot().operation.job.id, jobId);
  await h.client.refreshOperation(); assert.equal(h.writes().length, 1);
});
for (const status of [401, 403]) {
  test(`${status} clears protected state and blocks reads and writes`, async () => {
    const h = harness(); await accepted(h); h.handle(async () => { throw Object.assign(new Error(), { status }); });
    await h.client.refreshOperation(); const state = h.client.getSnapshot();
    assert.equal(state.denied, true); assert.equal(state.items, null); assert.equal(state.operation, null);
    const count = h.calls.length; await h.client.load(); await h.client.save(draft); assert.equal(h.calls.length, count);
  });
}
test('old list cannot overwrite a newer list', async () => {
  const h = harness(); const first = deferred(); h.handle(() => first.promise);
  const loading = h.client.load(); h.handle(async () => list([])); await h.client.load();
  first.resolve(list()); await loading; assert.deepEqual(h.client.getSnapshot().items, []);
});
test('unmount aborts requests and suppresses late notifications', async () => {
  const h = harness(); const pending = deferred(); h.handle(() => pending.promise); let changes = 0;
  h.client.subscribe(() => changes++); const loading = h.client.load(); h.client.dispose(); const count = changes;
  pending.resolve(list()); await loading; assert.equal(changes, count); assert.equal(h.calls[0].signal.aborted, true);
});
test('session changed after GET prevents both result use and mutation', async () => {
  let valid = true; const h = harness({ isCurrent: () => valid }); await h.client.load();
  h.handle(async () => { valid = false; return task(); });
  assert.equal(await h.client.remove(task()), false); assert.equal(h.writes().length, 0);
});
test('drawer failure does not recast an accepted write as unknown', async () => {
  const h = harness({ onJob: () => { throw new Error('view failed'); } }); await accepted(h);
  assert.equal(h.client.getSnapshot().operation.phase, 'queued'); assert.equal(h.writes().length, 1);
});
