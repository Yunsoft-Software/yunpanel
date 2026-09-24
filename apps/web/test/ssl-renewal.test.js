import assert from 'node:assert/strict';
import test from 'node:test';
import { createSslRenewal, renewalMetadata, renewalOutcome } from '../src/workspace/ssl-renewal.js';

const domainId = '11111111-1111-4111-8111-111111111111';
const certificateId = '22222222-2222-4222-8222-222222222222';
const websiteId = '33333333-3333-4333-8333-333333333333';
const jobId = '44444444-4444-4444-8444-444444444444';
const other = '55555555-5555-4555-8555-555555555555';
const fingerprint = (hex) => Array(32).fill(hex).join(':');
const target = { id: domainId, certificateId, websiteId, serverId: 'local-server', primaryDomain: 'example.test' };
const old = { validFrom: '2026-07-01T00:00:00.000Z', validTo: '2026-09-29T00:00:00.000Z', fingerprint256: fingerprint('AB') };
const renewed = { validFrom: '2026-09-24T00:00:00.000Z', validTo: '2026-12-23T00:00:00.000Z', fingerprint256: fingerprint('CD') };
const certPath = `/certificates/${certificateId}`;
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function setup(extra = {}) {
  const db = {
    domain: { ...target, httpsMode: 'managed', desiredRevision: 1 },
    certificate: { id: certificateId, domainId, serverId: target.serverId, source: 'acme', renewalMode: 'automatic',
      staging: false, purpose: 'web', state: 'active', certName: 'example.test', ...old },
    result: { certName: 'example.test', dryRun: false, status: 'renewed', ...renewed },
    jobStatus: 'succeeded', sync: true, body: null,
  };
  const calls = [], states = [];
  let intercept = null;
  const job = (status = db.jobStatus) => ({ id: jobId, serverId: target.serverId, resourceType: 'certificate', resourceId: certificateId,
    operation: 'ssl.renew', type: 'ssl.renew', status, result: status === 'succeeded' ? structuredClone(db.result) : null });
  const backend = async (path, options) => {
    if (path === `/domains/${domainId}`) return structuredClone(db.domain);
    if (path === certPath) return structuredClone(db.certificate);
    if (path === `${certPath}/renew`) { db.body = options.body; return job('queued'); }
    if (path === `/jobs/${jobId}`) {
      if (db.sync && db.jobStatus === 'succeeded' && db.result.dryRun === false) Object.assign(db.certificate, renewalMetadata(db.result), { state: 'active' });
      return job();
    }
    throw new Error(`Unexpected fixture request ${path}`);
  };
  const flow = createSslRenewal({ target, canManage: () => true,
    request: async (path, options) => { calls.push({ path, ...options }); return intercept ? intercept(path, options, backend) : backend(path, options); },
    onState: (state) => states.push(state), ...extra });
  return { flow, db, calls, states, job, intercept: (fn) => { intercept = fn; } };
}
const posts = (run) => run.calls.filter((item) => item.method === 'POST');
async function approve(run, dryRun = false) {
  await run.flow.prepare(dryRun); const approval = run.flow.getState().approval;
  assert.ok(approval, JSON.stringify(run.flow.getState())); return approval;
}
async function start(run, dryRun = false) { const a = await approve(run, dryRun); return run.flow.confirm(a, a.confirmation); }

test('one existing POST is followed by a matching job and stored dates, never a synthetic expiry', async () => {
  const run = setup(); const a = await approve(run);
  assert.equal(posts(run).length, 0);
  const state = await run.flow.confirm(a, a.confirmation);
  assert.equal(posts(run).length, 1); assert.equal(posts(run)[0].path, `${certPath}/renew`);
  assert.deepEqual(posts(run)[0].body, { dryRun: false });
  assert.equal(state.status, 'complete'); assert.equal(state.outcome, 'renewed');
  assert.deepEqual(renewalMetadata(state.certificate), renewed);
  assert.deepEqual(renewalMetadata(state.before), old);
  assert.equal(state.terminalVersion, 1); assert.equal(state.syncVersion, 1);
  await run.flow.refresh(); assert.equal(run.flow.getState().syncVersion, 1); assert.equal(posts(run).length, 1);
});

test('dry run completes without extending dates or requiring production metadata in the job', async () => {
  const run = setup(); run.db.result = { certName: 'example.test', dryRun: true, status: 'validated' };
  const state = await start(run, true);
  assert.equal(state.outcome, 'tested'); assert.deepEqual(renewalMetadata(state.certificate), old);
  assert.deepEqual(posts(run)[0].body, { dryRun: true });
});

test('renewed status with identical material is explicitly unchanged, not a new 90-day certificate', async () => {
  const run = setup(); Object.assign(run.db.result, old);
  const state = await start(run);
  assert.equal(state.outcome, 'unchanged'); assert.equal(state.certificate.validTo, old.validTo);
});

test('changed material with shorter validity keeps the actual dates rather than promising an extension', async () => {
  const run = setup(); run.db.result.validTo = '2026-09-28T00:00:00Z';
  const state = await start(run);
  assert.equal(state.outcome, 'renewed'); assert.equal(state.certificate.validTo, '2026-09-28T00:00:00.000Z');
});

test('terminal job before reconciliation stays syncing until fingerprint and dates match the registry', async () => {
  const run = setup(); run.db.sync = false;
  let state = await start(run);
  assert.equal(state.status, 'syncing'); assert.equal(state.terminalVersion, 1); assert.equal(state.syncVersion, 0);
  assert.equal(state.certificate.validTo, old.validTo);
  await run.flow.prepare(false); assert.equal(run.flow.getState().approval, null);
  run.db.sync = true; state = await run.flow.refresh();
  assert.equal(state.status, 'complete'); assert.equal(state.outcome, 'renewed');
  assert.equal(state.terminalVersion, 1); assert.equal(state.syncVersion, 1); assert.equal(posts(run).length, 1);
});

test('bounded metadata polling leaves a visible unresolved state and only GET rechecks', async () => {
  const run = setup(); run.db.sync = false; await start(run);
  for (let i = 0; i < 7; i++) await run.flow.refresh();
  assert.equal(run.flow.getState().status, 'unverified'); assert.equal(run.flow.getState().syncVersion, 0);
  assert.equal(posts(run).length, 1); run.db.sync = true;
  assert.equal((await run.flow.refresh()).status, 'complete');
});

for (const status of ['queued', 'running']) {
  test(`${status} never changes expiry or starts a second renewal`, async () => {
    const run = setup(); run.db.jobStatus = status; await start(run);
    assert.equal(run.flow.getState().status, 'waiting'); assert.equal(run.flow.getState().outcome, null);
    await run.flow.prepare(false); assert.equal(run.flow.getState().approval, null);
    run.db.jobStatus = 'succeeded'; await run.flow.refresh();
    assert.equal(run.flow.getState().outcome, 'renewed'); assert.equal(posts(run).length, 1);
  });
}

test('long running operation pauses automatic polling without cancelling the host or granting retry', async () => {
  const run = setup(); run.db.jobStatus = 'running'; await start(run);
  for (let i = 0; i < 119; i++) await run.flow.refresh();
  assert.equal(run.flow.getState().status, 'paused');
  await run.flow.prepare(false); assert.equal(run.flow.getState().approval, null); assert.equal(posts(run).length, 1);
});

for (const status of ['failed', 'cancelled']) {
  test(`${status} is not renewal success and invalidates inventory once`, async () => {
    const run = setup(); run.db.jobStatus = status; const state = await start(run);
    assert.equal(state.status, 'failed'); assert.equal(state.outcome, status); assert.ok(state.error);
    assert.equal(state.terminalVersion, 1); assert.equal(state.syncVersion, 0); assert.equal(state.certificate.validTo, old.validTo);
    await run.flow.refresh(); assert.equal(run.flow.getState().terminalVersion, 1); assert.equal(posts(run).length, 1);
  });
}

for (const status of [409, 429, 500, 503, undefined]) {
  test(`lost or rejected POST ${status ?? 'network'} stays sealed after read-only refresh`, async () => {
    const run = setup(); run.intercept((path, options, next) => {
      if (options.method === 'POST') throw Object.assign(new Error('private provider credential'), { status });
      return next(path, options);
    });
    await start(run); assert.equal(run.flow.getState().status, 'unverified');
    await run.flow.refresh(); await run.flow.prepare(false);
    assert.equal(run.flow.getState().status, 'uncertain'); assert.equal(run.flow.getState().approval, null);
    assert.equal(posts(run).length, 1); assert.equal(JSON.stringify(run.states).includes('private provider'), false);
  });
}

for (const field of ['certificateId', 'websiteId', 'serverId', 'primaryDomain', 'desiredRevision']) {
  test(`site ${field} change invalidates open approval before POST`, async () => {
    const run = setup(); const a = await approve(run);
    run.db.domain[field] = field === 'desiredRevision' ? 2 : field === 'primaryDomain' ? 'different.test' : other;
    await run.flow.confirm(a, a.confirmation);
    assert.equal(posts(run).length, 0); assert.equal(run.flow.getState().approval, null);
  });
}

for (const patch of [ { id: other }, { domainId: other }, { serverId: 'other-server' }, { state: 'renewing' },
  { source: 'custom' }, { renewalMode: 'manual' }, { staging: true }, { purpose: 'mail-service' },
  { fingerprint256: 'invalid' }, { validTo: null }, { validTo: old.validFrom } ]) {
  test(`invalid or nonrenewable certificate cannot be approved: ${JSON.stringify(patch)}`, async () => {
    const run = setup(); Object.assign(run.db.certificate, patch); await run.flow.prepare(false);
    assert.equal(run.flow.getState().approval, null); assert.equal(posts(run).length, 0);
  });
}

test('domain selection changed during the certificate GET is caught by the second binding read', async () => {
  const run = setup(); run.intercept(async (path, options, next) => {
    const value = await next(path, options); if (path === certPath) run.db.domain.certificateId = other; return value;
  });
  await run.flow.prepare(false); assert.equal(run.flow.getState().approval, null); assert.equal(posts(run).length, 0);
});

for (const field of ['id', 'resourceId', 'serverId', 'operation', 'resourceType']) {
  test(`wrong job ${field} cannot overwrite the observed certificate`, async () => {
    const run = setup(); run.intercept(async (path, options, next) => {
      const value = await next(path, options); if (path.startsWith('/jobs/')) value[field] = other; return value;
    });
    await start(run); assert.equal(run.flow.getState().status, 'unverified');
    assert.equal(run.flow.getState().outcome, null); assert.equal(run.flow.getState().certificate.validTo, old.validTo);
  });
}

for (const patch of [{ dryRun: true, status: 'validated' }, { staging: true }, { certName: 'wrong.test' },
  { validTo: 'invalid' }, { fingerprint256: fingerprint('AB'), validFrom: renewed.validFrom }]) {
  test(`contradictory renewal result remains unverified: ${JSON.stringify(patch)}`, async () => {
    const run = setup(); Object.assign(run.db.result, patch); await start(run);
    assert.equal(run.flow.getState().status, 'unverified'); assert.notEqual(run.flow.getState().outcome, 'renewed');
  });
}

test('same fingerprint with contradictory dates is invalid even when stored and job metadata agree', () => {
  const before = { certName: 'example.test', ...old };
  const changed = { ...renewed, fingerprint256: old.fingerprint256 };
  assert.throws(() => renewalOutcome({ status: 'succeeded', result: { certName: before.certName, dryRun: false, status: 'renewed', ...changed } }, before, { state: 'active', ...changed }, false));
});

test('metadata normalization equates ISO timestamps in different timezones and fingerprint casing', () => {
  assert.deepEqual(renewalMetadata({ ...old, fingerprint256: old.fingerprint256.toLowerCase(), validTo: '2026-09-29T02:00:00+02:00' }), old);
});

test('copied, replaced, cancelled and wrongly typed approvals cannot start jobs', async () => {
  const run = setup(); const a = await approve(run);
  await run.flow.confirm({ ...a }, a.confirmation); await run.flow.confirm(a, 'wrong');
  await approve(run); await run.flow.confirm(a, a.confirmation);
  const b = run.flow.getState().approval; run.flow.cancel(); await run.flow.confirm(b, b.confirmation);
  assert.equal(posts(run).length, 0);
});

test('double confirm and refresh while POST is pending dispatch one renewal', async () => {
  const run = setup(); const a = await approve(run); const gate = deferred();
  run.intercept(async (path, options, next) => { if (options.method === 'POST') await gate.promise; return next(path, options); });
  const first = run.flow.confirm(a, a.confirmation); await new Promise(setImmediate);
  await run.flow.confirm(a, a.confirmation); await run.flow.refresh(); assert.equal(posts(run).length, 1);
  gate.resolve(); await first; assert.equal(run.flow.getState().status, 'complete');
});

for (const boundary of ['preflight', 'post', 'job']) {
  for (const stop of ['session', 'dispose']) {
    test(`${stop} during ${boundary} suppresses late publication and additional requests`, async () => {
      let current = true; const run = setup({ isCurrent: () => current }); const a = await approve(run); const gate = deferred();
      run.intercept(async (path, options, next) => {
        if ((boundary === 'preflight' && path === certPath) || (boundary === 'post' && options.method === 'POST')
          || (boundary === 'job' && path.startsWith('/jobs/'))) await gate.promise;
        return next(path, options);
      });
      const first = run.flow.confirm(a, a.confirmation); await new Promise(setImmediate);
      if (stop === 'session') current = false; else run.flow.dispose();
      const size = run.states.length, requests = run.calls.length; gate.resolve(); await first;
      assert.equal(run.states.length, size); assert.equal(run.calls.length, requests);
      assert.equal(posts(run).length, boundary === 'preflight' ? 0 : 1);
    });
  }
}

test('management revoked during preflight does not write and clears retained information', async () => {
  let allowed = true; const run = setup({ canManage: () => allowed }); const a = await approve(run);
  run.intercept(async (path, options, next) => { const value = await next(path, options); allowed = false; return value; });
  await run.flow.confirm(a, a.confirmation);
  assert.equal(posts(run).length, 0); assert.equal(run.flow.getState().status, 'forbidden'); assert.equal(run.flow.getState().certificate, null);
});

for (const status of [401, 403]) {
  test(`authorization ${status} during observation clears prior certificate, job and proof`, async () => {
    const run = setup(); await start(run);
    run.intercept(() => { throw Object.assign(new Error('restricted'), { status }); }); await run.flow.refresh();
    assert.equal(run.flow.getState().status, 'forbidden');
    for (const field of ['certificate', 'before', 'job', 'approval', 'outcome']) assert.equal(run.flow.getState()[field], null);
  });
}

test('newer terminal result is never replaced by a late running response', async () => {
  const run = setup(); await start(run); const expiry = run.flow.getState().certificate.validTo;
  run.db.jobStatus = 'running'; await run.flow.refresh();
  assert.equal(run.flow.getState().status, 'error'); assert.equal(run.flow.getState().certificate.validTo, expiry);
});

test('publication contains no payload, path, private key or provider failure text', async () => {
  const run = setup(); run.db.certificate.privateKey = 'private-fixture'; run.db.result.privateKey = 'private-fixture';
  run.db.result.fullchainPath = '/private/fixture'; await start(run);
  assert.equal(JSON.stringify(run.states).includes('private-fixture'), false);
  assert.equal(JSON.stringify(run.states).includes('/private/fixture'), false);
  assert.equal(Object.isFrozen(run.flow.getState().certificate), true);
});

test('stored certificate name drift cannot be accepted as the approved renewal', async () => {
  const run = setup(); run.intercept(async (path, options, next) => {
    const value = await next(path, options);
    if (path.startsWith('/jobs/')) run.db.certificate.certName = 'other.test';
    return value;
  });
  await start(run); assert.equal(run.flow.getState().status, 'unverified');
  assert.equal(run.flow.getState().syncVersion, 0);
});
