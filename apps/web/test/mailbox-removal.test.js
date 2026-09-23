import assert from 'node:assert/strict';
import test from 'node:test';
import { createMailboxRemoval } from '../src/workspace/mailbox-removal-controller.js';
import { mailboxRemovalEligible, mailboxRemovalJob, mailboxRemovalSnapshot, mailboxRemovalTarget } from '../src/workspace/mailbox-removal-model.js';

const id = '11111111-1111-4111-8111-111111111111';
const domainId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const target = { id, mailDomainId: domainId, address: 'user@example.test' };
const base = `/mailboxes/${id}`;
const sha = (n) => String(n).repeat(64);
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function backend() {
  const db = { revision: 1, domainStatus: 'disabled', present: true, bytes: 25, snapshot: sha(1), quota: false, forwarding: false, aliases: 0, removed: false, jobs: new Map(), autoFinish: true };
  const mailbox = () => ({ ...target, revision: db.revision, enabled: true });
  const domain = () => ({ id: domainId, domainName: 'example.test', managementMode: 'local', status: db.domainStatus, revision: 2 });
  function impact() {
    const activeJobs = [...db.jobs.values()].filter((job) => ['queued', 'running'].includes(job.status)).length;
    const blockers = [];
    for (const [condition, code, count] of [[db.present, 'mail_data_backup_required', 1], [db.quota, 'mailbox_quota_configured', 1],
      [db.forwarding, 'mailbox_forwarding_configured', 1], [db.aliases, 'mailbox_alias_reference_configured', db.aliases], [activeJobs, 'mail_domain_job_active', activeJobs]]) {
      if (condition) blockers.push({ code, count });
    }
    return { version: 1, resourceType: 'mailbox', resourceId: id, address: target.address, revision: db.revision, enabled: true,
      dependencies: { quotaConfigured: db.quota, forwardingConfigured: db.forwarding, aliasReferences: { count: db.aliases }, activeJobs: { count: activeJobs } },
      mailData: { present: db.present, bytes: db.bytes, snapshotSha256: db.snapshot }, requiresDataBackup: db.present,
      safeToDelete: !blockers.length, blockers, confirmation: `delete-mailbox:${target.address}`, sideEffects: false };
  }
  function preview(action, backupId) {
    const common = { version: 1, operation: `mail_data_${action}`, scope: 'mailbox', resourceId: id, mailDomainId: domainId,
      identity: target.address, expectedRevision: db.revision, previewDigest: action === 'backup' ? sha(2) : sha(3), sideEffects: false };
    const fields = action === 'backup' ? { snapshotSha256: db.snapshot, sourcePresent: db.present, bytes: db.bytes }
      : { backupId, backupContentSha256: sha(4), backupBytes: 25, targetSnapshotSha256: db.snapshot, targetPresent: db.present, targetBytes: db.bytes };
    return { ...common, ...fields, confirmation: `${action}-mail-data:${domainId}:${common.previewDigest}` };
  }
  function finish(job) {
    if (job.status !== 'queued') return job;
    const result = { version: 1, scope: 'mailbox', mailDomainId: domainId, identity: target.address, contentSha256: sha(4), bytes: db.bytes,
      files: db.present ? 1 : 0, directories: db.present ? 1 : 0, sideEffects: true, sourcePresent: db.present };
    if (job.operation === 'mail.data.backup') Object.assign(result, { backupId: job.id, backedUp: true, sourceSnapshotSha256: db.snapshot });
    else {
      Object.assign(result, { transactionId: job.id, backupId: job.input.backupId, resourceId: id, expectedResourceRevision: db.revision, deleted: true });
      db.present = false; db.bytes = 0; db.snapshot = sha(5);
    }
    job.status = 'succeeded'; job.result = result; return job;
  }
  async function request(path, options = {}) {
    const method = options.method ?? 'GET';
    if (path === base && method === 'GET') {
      if (db.removed) throw Object.assign(new Error('not found'), { status: 404, code: 'mailbox_not_found' });
      return mailbox();
    }
    if (path === `/mail-domains/${domainId}`) return domain();
    if (path === `${base}/delete-impact`) return impact();
    if (path === `${base}/data/backup-preview`) return preview('backup');
    if (path === `${base}/data/delete-preview`) return preview('delete', options.body.backupId);
    if (path === `${base}/data/backup` || path === `${base}/data/delete`) {
      const action = path.endsWith('/backup') ? 'backup' : 'delete';
      const job = { id: `${action}-job-${db.jobs.size + 1}`, operation: `mail.data.${action}`, resourceType: 'mail_domain', resourceId: domainId, status: 'queued', input: options.body };
      db.jobs.set(job.id, job);
      return { previewDigest: options.body.expectedPreviewDigest, job: { ...job } };
    }
    if (path.startsWith('/jobs/')) {
      const job = db.jobs.get(path.slice('/jobs/'.length));
      if (!job) throw Object.assign(new Error('missing job'), { status: 404, code: 'job_not_found' });
      return structuredClone(db.autoFinish ? finish(job) : job);
    }
    if (path === base && method === 'DELETE') {
      db.removed = true;
      return { id, resourceType: 'mailbox', deleted: true, deleteJobId: options.body.deleteJobId, backupId: db.jobs.get(options.body.deleteJobId).result.backupId };
    }
    throw new Error(`Unexpected fixture request ${method} ${path}`);
  }
  return { db, mailbox, domain, impact, preview, finish, request };
}
function setup(extra = {}) {
  const api = backend(); const calls = []; const states = []; let intercept = null;
  const flow = createMailboxRemoval({ target, canManage: () => true,
    request: async (path, options) => {
      calls.push({ path, ...options });
      return intercept ? intercept(path, options, api.request) : api.request(path, options);
    }, onState: (state) => states.push(state), ...extra });
  return { ...api, flow, calls, states, intercept: (value) => { intercept = value; } };
}
const mutations = (run) => run.calls.filter((call) => (call.method === 'POST' && !call.path.endsWith('-preview')) || call.method === 'DELETE' || call.method === 'PATCH');
async function action(run, name) {
  await run.flow.prepare(name); const approval = run.flow.getState().approval;
  assert.ok(approval, `${name}: ${JSON.stringify(run.flow.getState())}`);
  return run.flow.confirm(approval, approval.data.confirmation);
}
async function backedUp(run) { await run.flow.refresh(); await action(run, 'backup'); assert.equal(run.flow.getState().backupId, 'backup-job-1'); }

test('existing backup → delete job → guarded finalize stays explicitly staged', async () => {
  const run = setup(); await run.flow.refresh();
  assert.equal(mutations(run).length, 0);
  await action(run, 'backup');
  assert.equal(run.flow.getState().backupId, 'backup-job-1'); assert.equal(mutations(run).length, 1);
  await action(run, 'delete');
  let state = run.flow.getState();
  assert.equal(state.receipt.id, 'delete-job-2'); assert.equal(state.status, 'ready'); assert.equal(state.result, null); assert.equal(run.db.removed, false);
  assert.equal(mutations(run).length, 2);
  state = await action(run, 'finalize');
  assert.equal(state.status, 'deleted'); assert.equal(run.db.removed, true);
  assert.deepEqual(mutations(run)[2].body, { confirmation: `delete-mailbox:${target.address}`, expectedRevision: 1, deleteJobId: 'delete-job-2' });
  assert.equal(mutations(run).some((call) => call.path.startsWith('/mail-domains/')), false);
});

test('a verified backup is still required when the mailbox data directory is absent', async () => {
  const run = setup(); run.db.present = false; run.db.bytes = 0;
  await run.flow.refresh(); await run.flow.prepare('delete'); assert.equal(mutations(run).length, 0); assert.equal(run.flow.getState().approval, null);
  await run.flow.refresh(); await action(run, 'backup'); await action(run, 'delete'); await action(run, 'finalize');
  assert.equal(run.flow.getState().status, 'deleted');
});
for (const [field, value] of [['domainStatus', 'enabled'], ['quota', true], ['forwarding', true], ['aliases', 2]]) {
  test(`${field} blocks mutation without disabling the domain or silently removing dependencies`, async () => {
    const run = setup(); run.db[field] = value; await run.flow.refresh(); await run.flow.prepare('backup');
    assert.equal(run.flow.getState().approval, null); assert.equal(mutations(run).length, 0);
  });
}

test('queued/running jobs are observations, not backups or deletion receipts', async () => {
  const run = setup(); run.db.autoFinish = false; await run.flow.refresh(); await action(run, 'backup');
  assert.equal(run.flow.getState().status, 'waiting'); assert.equal(run.flow.getState().backupId, null);
  await run.flow.prepare('delete'); await run.flow.refresh(); assert.equal(mutations(run).length, 1);
  run.db.autoFinish = true; await run.flow.refresh(); assert.equal(run.flow.getState().backupId, 'backup-job-1');
  assert.equal(mutations(run).length, 1);
});
for (const status of ['failed', 'cancelled']) {
  test(`${status} never grants a successful backup or automatically queues another job`, async () => {
    const run = setup(); run.db.autoFinish = false; await run.flow.refresh(); await action(run, 'backup');
    run.db.jobs.get('backup-job-1').status = status; await run.flow.refresh();
    assert.equal(run.flow.getState().uncertain, true); assert.equal(run.flow.getState().backupId, null);
    await run.flow.prepare('backup'); assert.equal(run.flow.getState().approval, null); assert.equal(mutations(run).length, 1);
  });
}
for (const change of ['revision', 'snapshot', 'domainStatus', 'aliases']) {
  test(`changed ${change} invalidates an already displayed confirmation before POST`, async () => {
    const run = setup(); await run.flow.refresh(); await run.flow.prepare('backup'); const old = run.flow.getState().approval;
    run.db[change] = { revision: 2, snapshot: sha(6), domainStatus: 'enabled', aliases: 1 }[change];
    await run.flow.confirm(old, old.data.confirmation);
    assert.equal(run.flow.getState().approval, null); assert.equal(mutations(run).length, 0);
  });
}

test('copied, wrong-text, cancelled and replaced approvals cannot dispatch writes', async () => {
  const run = setup(); await run.flow.refresh(); await run.flow.prepare('backup'); const old = run.flow.getState().approval;
  await run.flow.confirm({ ...old }, old.data.confirmation); await run.flow.confirm(old, 'wrong');
  run.flow.cancel(); await run.flow.confirm(old, old.data.confirmation);
  await run.flow.prepare('backup'); await run.flow.confirm(old, old.data.confirmation);
  assert.equal(mutations(run).length, 0);
});

test('lost delete POST after a completed backup stays locked even when refreshing that old backup', async () => {
  const run = setup(); await backedUp(run);
  run.intercept(async (path, options, next) => {
    if (path === `${base}/data/delete`) { await next(path, options); throw new Error('reply lost'); }
    return next(path, options);
  });
  await action(run, 'delete'); assert.equal(run.flow.getState().status, 'uncertain');
  await run.flow.refresh(); await run.flow.prepare('delete');
  assert.equal(run.flow.getState().uncertain, true); assert.equal(run.flow.getState().approval, null);
  assert.equal(mutations(run).length, 2);
  await run.flow.resume('delete-job-2');
  assert.equal(run.flow.getState().receipt.id, 'delete-job-2'); assert.equal(mutations(run).length, 2);
  await action(run, 'finalize'); assert.equal(run.flow.getState().status, 'deleted');
});
for (const status of [409, 429, 500, 503]) {
  test(`ambiguous ${status} queue result does not retry after refresh`, async () => {
    const run = setup(); await run.flow.refresh();
    run.intercept((path, options, next) => {
      if (path.endsWith('/data/backup')) throw Object.assign(new Error('private error'), { status });
      return next(path, options);
    });
    await action(run, 'backup'); await run.flow.refresh(); await run.flow.prepare('backup');
    assert.equal(run.flow.getState().approval, null); assert.equal(mutations(run).length, 1);
    assert.equal(JSON.stringify(run.states).includes('private error'), false);
  });
}

test('failed finalize retains data-deletion receipt and never restarts data deletion', async () => {
  const run = setup(); await backedUp(run); await action(run, 'delete');
  run.intercept((path, options, next) => { if (options.method === 'DELETE') throw new Error('lost'); return next(path, options); });
  await action(run, 'finalize'); assert.equal(run.flow.getState().status, 'uncertain'); assert.equal(run.flow.getState().result, null);
  run.intercept(null); await run.flow.refresh(); await run.flow.prepare('delete');
  assert.equal(run.flow.getState().approval, null); assert.equal(mutations(run).length, 3);
  await run.flow.refresh(); await action(run, 'finalize'); assert.equal(run.flow.getState().status, 'deleted');
});

test('a missing mailbox after lost finalize reply is not falsely reported as full deletion success', async () => {
  const run = setup(); await backedUp(run); await action(run, 'delete');
  run.intercept(async (path, options, next) => { const value = await next(path, options); if (options.method === 'DELETE') throw new Error('lost'); return value; });
  await action(run, 'finalize'); await run.flow.refresh();
  assert.equal(run.flow.getState().status, 'absent'); assert.equal(run.flow.getState().result, null);
});

test('finalize is not allowed after the mailbox revision changes', async () => {
  const run = setup(); await backedUp(run); await action(run, 'delete'); run.db.revision++;
  await run.flow.refresh(); await run.flow.prepare('finalize'); assert.equal(run.flow.getState().approval, null);
  assert.equal(mutations(run).length, 2);
});

test('read-only caller cannot prepare a write', async () => {
  const run = setup({ canManage: () => false }); await run.flow.refresh(); await run.flow.prepare('backup');
  assert.equal(run.flow.getState().status, 'forbidden'); assert.equal(mutations(run).length, 0);
});
for (const status of [401, 403]) {
  test(`${status} clears stored snapshots, approvals and proof`, async () => {
    const run = setup(); await backedUp(run);
    run.intercept(() => { throw Object.assign(new Error('restricted'), { status }); });
    await run.flow.refresh(); assert.equal(run.flow.getState().status, 'forbidden');
    for (const field of ['snapshot', 'approval', 'job', 'backupId', 'receipt']) assert.equal(run.flow.getState()[field], null);
  });
}

test('double confirm and refresh during pending queue send exactly one POST', async () => {
  const run = setup(); const gate = deferred(); await run.flow.refresh(); await run.flow.prepare('backup');
  const approval = run.flow.getState().approval;
  run.intercept(async (path, options, next) => { if (path.endsWith('/data/backup')) await gate.promise; return next(path, options); });
  const first = run.flow.confirm(approval, approval.data.confirmation); await new Promise(setImmediate);
  await run.flow.confirm(approval, approval.data.confirmation); await run.flow.refresh();
  assert.equal(mutations(run).length, 1); gate.resolve(); await first;
  assert.equal(mutations(run).length, 1);
});
for (const stop of ['dispose', 'session', 'permission']) {
  test(`${stop} while preflight is pending prevents a subsequent mutation`, async () => {
    let current = true, allowed = true; const run = setup({ isCurrent: () => current, canManage: () => allowed });
    await run.flow.refresh(); await run.flow.prepare('backup'); const approval = run.flow.getState().approval; const gate = deferred();
    run.intercept(async (path, options, next) => { if (path === base) await gate.promise; return next(path, options); });
    const pending = run.flow.confirm(approval, approval.data.confirmation); await new Promise(setImmediate);
    if (stop === 'dispose') run.flow.dispose(); if (stop === 'session') current = false; if (stop === 'permission') allowed = false;
    const count = run.states.length; gate.resolve(); await pending;
    assert.equal(mutations(run).length, 0);
    if (stop === 'permission') assert.equal(run.flow.getState().status, 'forbidden'); else assert.equal(run.states.length, count);
  });
}

test('unmount after POST suppresses late result and aborts observation, not the host operation', async () => {
  const run = setup(); const gate = deferred(); await run.flow.refresh(); await run.flow.prepare('backup'); const approval = run.flow.getState().approval;
  run.intercept(async (path, options, next) => { if (path.endsWith('/data/backup')) await gate.promise; return next(path, options); });
  const pending = run.flow.confirm(approval, approval.data.confirmation); await new Promise(setImmediate); run.flow.dispose(); const count = run.states.length;
  gate.resolve(); await pending; assert.equal(run.states.length, count); assert.equal(run.calls.at(-1).signal.aborted, true); assert.equal(mutations(run).length, 1);
});

test('other mailbox/domain job proofs and unverified receipts cannot be resumed as success', async () => {
  const good = setup(); await backedUp(good); const original = good.db.jobs.get('backup-job-1');
  for (const patch of [{ resourceId: otherId }, { result: { ...original.result, identity: 'other@example.test' } },
    { result: { ...original.result, scope: 'domain' } }, { result: { ...original.result, backedUp: false } }, { id: 'different-job' }]) {
    const run = setup(); run.intercept((path, options, next) => path.startsWith('/jobs/') ? { ...original, ...patch } : next(path, options));
    await run.flow.resume('backup-job-1'); assert.equal(run.flow.getState().backupId, null); assert.equal(mutations(run).length, 0);
  }
});

test('snapshot and queued payload mismatch fails closed without invented success', async () => {
  const run = setup(); await run.flow.refresh();
  run.intercept(async (path, options, next) => {
    const value = await next(path, options);
    return path.endsWith('/data/backup') ? { ...value, previewDigest: sha(9) } : value;
  });
  await action(run, 'backup'); assert.equal(run.flow.getState().status, 'uncertain'); assert.equal(run.flow.getState().backupId, null);
});

test('invalid and contradictory snapshot projections cannot enable deletion', () => {
  const api = backend();
  for (const patch of [{ resourceId: otherId }, { revision: 22 }, { sideEffects: true }, { safeToDelete: true },
    { mailData: { present: false } }, { dependencies: {} }]) {
    assert.throws(() => mailboxRemovalSnapshot(api.mailbox(), api.domain(), { ...api.impact(), ...patch }, target));
  }
  assert.throws(() => mailboxRemovalTarget({ ...target, id: '../wrong' }));
  assert.equal(mailboxRemovalEligible(null), false);
});

test('unknown blockers stop the flow instead of being ignored', () => {
  const api = backend(); const impact = api.impact(); impact.blockers.push({ code: 'future_safety_gate', count: 1 });
  const snapshot = mailboxRemovalSnapshot(api.mailbox(), api.domain(), impact, target);
  assert.equal(mailboxRemovalEligible(snapshot), false);
});

test('job public projection excludes payloads, arbitrary error text and secret data', async () => {
  const run = setup(); await backedUp(run); const job = run.db.jobs.get('backup-job-1');
  const data = mailboxRemovalJob({ ...job, error: { message: 'private-sql-password' }, payload: { password: 'private-sql-password' }, result: { ...job.result, privateKey: 'private-sql-password' } }, target);
  assert.equal(JSON.stringify(data).includes('private-sql'), false); assert.equal(Object.isFrozen(data), true);
});
