import assert from 'node:assert/strict';
import test from 'node:test';
import { createMailboxAccessPreparation, mailboxAccessBusy } from '../src/workspace/mailbox-access-preparation.js';

const id = '11111111-1111-4111-8111-111111111111';
const domainId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const target = { id, mailDomainId: domainId, address: 'chosen@example.test' };
const boxPath = `/mailboxes/${id}`, domainPath = `/mail-domains/${domainId}`;
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { resolve, promise }; };
function setup(extra = {}) {
  const calls = [], states = [];
  const db = { mailbox: { ...target, enabled: true, revision: 1 },
    sibling: { id: otherId, enabled: true, revision: 7 },
    domain: { id: domainId, domainName: 'example.test', revision: 4, status: 'enabled', managementMode: 'local' },
    digest: 'a'.repeat(64), config: 'b'.repeat(64), jobStatus: 'succeeded', savedBody: null };
  let intercept = null;
  const preview = () => ({ version: 1, operation: 'mail_configuration_apply', mailDomainId: domainId,
    expectedRevision: db.domain.revision, currentStatus: db.domain.status, desiredStatus: db.domain.status,
    readyToApply: true, sideEffects: false, blockers: [], previewDigest: db.digest,
    configuration: { sha256: db.config }, configurationSha256: db.config,
    confirmation: `apply-mail-configuration:${domainId}:${db.digest}` });
  const job = () => ({ id: 'mail-apply-job-1', operation: 'mail.config.apply', resourceType: 'mail_domain', resourceId: domainId,
    status: db.jobStatus, result: { version: 3, applied: true, sideEffects: true, mailDomainId: domainId,
      configurationSha256: db.savedBody?.configurationSha256 ?? db.config, previousRevision: 4,
      previousStatus: db.savedBody?.status ?? db.domain.status, desiredStatus: db.savedBody?.status ?? db.domain.status } });
  async function backend(path, options) {
    if (path === boxPath) {
      if (options.method === 'PATCH') {
        assert.deepEqual(options.body, { expectedRevision: db.mailbox.revision, enabled: false });
        db.mailbox.enabled = false; db.mailbox.revision++;
      }
      return structuredClone(db.mailbox);
    }
    if (path === domainPath) { assert.equal(options.method, undefined); return structuredClone(db.domain); }
    if (path.endsWith('/config-preview')) {
      assert.deepEqual(options.body, { expectedRevision: db.domain.revision, status: db.domain.status }); return preview();
    }
    if (path.endsWith('/config-apply')) { db.savedBody = options.body; return { ...job(), status: 'queued', result: undefined }; }
    if (path === '/jobs/mail-apply-job-1') return job();
    throw new Error(`Unexpected fixture request ${path}`);
  }
  const flow = createMailboxAccessPreparation({ target, canManage: () => true,
    request: async (path, options) => { calls.push({ path, ...options }); return intercept ? intercept(path, options, backend) : backend(path, options); },
    onState: (value) => states.push(value), ...extra });
  return { flow, db, calls, states, preview, job, intercept: (fn) => { intercept = fn; } };
}
const writes = (run) => run.calls.filter(({ method, path }) => method === 'PATCH' || path.endsWith('/config-apply'));
async function prepare(run, action) { await run.flow.prepare(action); const a = run.flow.getState().approval; assert.ok(a, JSON.stringify(run.flow.getState())); return a; }
async function perform(run, action) { const a = await prepare(run, action); return run.flow.perform(a, a.confirmation); }
async function disabled(run) { await run.flow.load(); await perform(run, 'disable'); }

test('disables only one mailbox and applies the unchanged enabled domain status', async () => {
  const run = setup(); const sibling = structuredClone(run.db.sibling);
  await disabled(run);
  assert.equal(run.db.domain.status, 'enabled'); assert.deepEqual(run.db.sibling, sibling);
  assert.equal(run.flow.getState().applied, false);
  assert.equal(writes(run).length, 1);
  const state = await perform(run, 'apply');
  assert.equal(state.status, 'ready'); assert.equal(state.applied, true); assert.equal(writes(run).length, 2);
  assert.equal(writes(run)[1].body.status, 'enabled'); assert.equal(run.db.domain.revision, 4);
  assert.deepEqual(run.db.sibling, sibling); assert.equal(run.calls.some(({ method }) => method === 'DELETE'), false);
});

test('an already disabled domain is not silently enabled by account preparation', async () => {
  const run = setup(); run.db.domain.status = 'disabled'; await disabled(run); await perform(run, 'apply');
  assert.equal(writes(run)[1].body.status, 'disabled'); assert.equal(run.db.domain.status, 'disabled');
});

test('queued/running config is not live application proof and cannot start more writes', async () => {
  const run = setup(); await disabled(run); run.db.jobStatus = 'running'; await perform(run, 'apply');
  assert.equal(run.flow.getState().status, 'waiting'); assert.equal(run.flow.getState().applied, false);
  await run.flow.prepare('apply'); assert.equal(writes(run).length, 2);
  run.db.jobStatus = 'succeeded'; await run.flow.load();
  assert.equal(run.flow.getState().applied, true); assert.equal(writes(run).length, 2);
});
for (const status of ['failed', 'cancelled']) {
  test(`${status} needs a fresh explicit apply confirmation, never an automatic retry`, async () => {
    const run = setup(); await disabled(run); run.db.jobStatus = status; await perform(run, 'apply');
    assert.equal(run.flow.getState().applied, false); assert.ok(run.flow.getState().error);
    await run.flow.load(); assert.equal(writes(run).length, 2);
    await prepare(run, 'apply'); assert.equal(writes(run).length, 2);
  });
}
for (const status of [409, 429, 500, 503]) {
  test(`lost/uncertain apply ${status} stays locked until the actual job is read`, async () => {
    const run = setup(); await disabled(run);
    run.intercept(async (path, options, next) => { const value = await next(path, options); if (path.endsWith('/config-apply')) throw Object.assign(new Error('private message'), { status }); return value; });
    await perform(run, 'apply'); assert.equal(run.flow.getState().status, 'uncertain');
    await run.flow.load(); await run.flow.prepare('apply'); assert.equal(writes(run).length, 2); assert.equal(run.flow.getState().approval, null);
    run.intercept(null); await run.flow.resume('mail-apply-job-1');
    assert.equal(run.flow.getState().applied, true); assert.equal(writes(run).length, 2);
    assert.equal(JSON.stringify(run.states).includes('private message'), false);
  });
}

test('lost PATCH reply is reconciled by GET without a second mailbox write', async () => {
  const run = setup(); await run.flow.load();
  run.intercept(async (path, options, next) => { const value = await next(path, options); if (options.method === 'PATCH') throw new Error('reply lost'); return value; });
  await perform(run, 'disable'); run.intercept(null); await run.flow.load();
  assert.equal(run.flow.getState().snapshot.enabled, false); assert.equal(writes(run).length, 1);
  await run.flow.prepare('disable'); assert.equal(run.flow.getState().approval, null); assert.equal(writes(run).length, 1);
});
for (const change of ['mailbox', 'domain', 'digest']) {
  test(`${change} changes invalidate the already displayed apply approval`, async () => {
    const run = setup(); await disabled(run); const a = await prepare(run, 'apply');
    if (change === 'mailbox') run.db.mailbox.revision++;
    if (change === 'domain') run.db.domain.status = 'disabled';
    if (change === 'digest') run.db.digest = 'c'.repeat(64);
    await run.flow.perform(a, a.confirmation); assert.equal(writes(run).length, 1); assert.equal(run.flow.getState().approval, null);
  });
}
for (const mutate of [
  (v) => { v.desiredStatus = 'disabled'; }, (v) => { v.currentStatus = 'disabled'; },
  (v) => { v.mailDomainId = otherId; }, (v) => { v.expectedRevision = 99; },
  (v) => { v.readyToApply = false; }, (v) => { v.blockers = ['mail_tls_required']; },
  (v) => { v.configuration.sha256 = 'bad'; }, (v) => { v.confirmation = 'wrong'; },
]) {
  test('an unverified or retargeted config preview cannot be applied', async () => {
    const run = setup(); await disabled(run);
    run.intercept(async (path, options, next) => { const v = await next(path, options); if (path.endsWith('/config-preview')) mutate(v); return v; });
    await run.flow.prepare('apply'); assert.equal(run.flow.getState().approval, null); assert.equal(writes(run).length, 1);
  });
}
for (const mutate of [
  (v) => { v.resourceId = otherId; }, (v) => { v.id = 'different-job'; },
  (v) => { v.result.configurationSha256 = 'c'.repeat(64); }, (v) => { v.result.desiredStatus = 'disabled'; },
  (v) => { v.result.previousRevision = 99; }, (v) => { v.result.applied = false; },
]) {
  test('wrong job proof never authorizes mailbox data deletion', async () => {
    const run = setup(); await disabled(run);
    run.intercept(async (path, options, next) => { const v = await next(path, options); if (path.startsWith('/jobs/')) mutate(v); return v; });
    await perform(run, 'apply'); assert.equal(run.flow.getState().applied, false); assert.equal(run.flow.getState().status, 'uncertain');
  });
}

test('double confirmation and parallel refresh dispatch only one PATCH', async () => {
  const run = setup(); await run.flow.load(); const a = await prepare(run, 'disable'); const gate = deferred();
  run.intercept(async (path, options, next) => { if (options.method === 'PATCH') await gate.promise; return next(path, options); });
  const first = run.flow.perform(a, a.confirmation); await new Promise(setImmediate);
  await run.flow.perform(a, a.confirmation); await run.flow.load(); gate.resolve(); await first;
  assert.equal(writes(run).length, 1);
});

test('copied, cancelled or wrongly typed approval does not mutate', async () => {
  const run = setup(); await run.flow.load(); const a = await prepare(run, 'disable');
  await run.flow.perform({ ...a }, a.confirmation); await run.flow.perform(a, 'wrong'); run.flow.cancel(); await run.flow.perform(a, a.confirmation);
  assert.equal(writes(run).length, 0);
});
for (const stop of ['permission', 'session', 'dispose']) {
  test(`${stop} during preflight suppresses the pending write`, async () => {
    let current = true, allowed = true;
    const run = setup({ isCurrent: () => current, canManage: () => allowed }); await run.flow.load();
    const a = await prepare(run, 'disable'); const gate = deferred();
    run.intercept(async (path, options, next) => { if (path === boxPath) await gate.promise; return next(path, options); });
    const pending = run.flow.perform(a, a.confirmation); await new Promise(setImmediate);
    if (stop === 'permission') allowed = false; else if (stop === 'session') current = false; else run.flow.dispose();
    const n = run.states.length; gate.resolve(); await pending;
    assert.equal(writes(run).length, 0);
    if (stop === 'permission') assert.equal(run.flow.getState().status, 'forbidden'); else assert.equal(run.states.length, n);
  });
}

test('forbidden reads clear previously displayed mailbox/config proof', async () => {
  const run = setup(); await disabled(run); await perform(run, 'apply');
  run.intercept(() => { throw Object.assign(new Error('forbidden'), { status: 403 }); });
  await run.flow.load(); assert.equal(run.flow.getState().snapshot, null); assert.equal(run.flow.getState().applied, false); assert.equal(run.flow.getState().job, null);
});

test('later re-enable invalidates applied proof and keeps subsequent writes closed', async () => {
  const run = setup(); await disabled(run); await perform(run, 'apply'); run.db.mailbox.enabled = true; run.db.mailbox.revision++;
  await run.flow.load(); assert.equal(run.flow.getState().applied, false);
  await run.flow.prepare('apply'); assert.equal(run.flow.getState().approval, null); assert.equal(writes(run).length, 2);
});

test('busy only means an actual pending request, not an uncertain outcome', () => {
  for (const status of ['loading', 'checking', 'sending', 'preparing']) assert.equal(mailboxAccessBusy({ status }), true);
  for (const status of ['uncertain', 'ready', 'waiting', 'error']) assert.equal(mailboxAccessBusy({ status }), false);
});
