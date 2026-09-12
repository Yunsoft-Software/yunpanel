import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditFilterInput, auditMessage, auditRequestPath, createAuditClient, readAuditEvent, readAuditPage,
} from '../src/workspace/audit-client.js';

const event = {
  id: 1, actorId: 'owner-1', action: 'site.create', resourceType: 'website', resourceId: 'website-1',
  outcome: 'succeeded', code: null, createdAt: 1_000,
};
const page = (events = [event], offset = 0, total = events.length) => ({ events, offset, total, limit: 50 });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(t, request) {
  const states = []; let generation = 1; let lost = 0;
  const client = createAuditClient({ request, generation: () => generation, onPage: (state) => states.push(state), onAccessLost: () => { lost += 1; generation += 1; } });
  t.after(() => client.dispose());
  return { client, states, state: () => states.at(-1), advance: () => { generation += 1; }, lost: () => lost };
}
const failure = (status, code) => Object.assign(new Error('private server message'), { status, code });

test('audit parser keeps only the bounded public event shape', () => {
  assert.deepEqual(readAuditEvent({ ...event, password: 'must-not-retain', body: 'must-not-retain' }), event);
  for (const changes of [
    { id: 0 }, { actorId: '\n' }, { action: 'UPPER' }, { outcome: 'unknown' }, { createdAt: Infinity },
    { resourceType: 'website', resourceId: null }, { code: 'UPPER' },
  ]) assert.throws(() => readAuditEvent({ ...event, ...changes }), { code: 'audit_result_invalid' });
});

test('audit page parser checks exact pagination and duplicate records', () => {
  assert.deepEqual(readAuditPage(page(), { offset: 0, limit: 50 }), page());
  for (const value of [{ ...page(), offset: 50 }, { ...page(), limit: 25 }, { ...page(), total: 2 }, { ...page(), events: null }, page([event, event])]) {
    assert.throws(() => readAuditPage(value, { offset: 0, limit: 50 }), { code: 'audit_page_invalid' });
  }
  assert.deepEqual(readAuditPage(page([], 50, 1), { offset: 50, limit: 50 }).events, []);
});

test('audit filters require exact bounded fields and build an encoded API query', () => {
  const filters = auditFilterInput({ actorId: 'owner-1', action: 'site.create', outcome: 'failed', resourceType: 'website', resourceId: 'site one', from: 100, to: 200 });
  assert.deepEqual(filters, { actorId: 'owner-1', action: 'site.create', outcome: 'failed', resourceType: 'website', resourceId: 'site one', from: 100, to: 200 });
  const path = auditRequestPath({ filters, offset: 50, limit: 50 });
  assert.match(path, /^\/audit\?/);
  const query = new URLSearchParams(path.split('?')[1]);
  assert.equal(query.get('resourceId'), 'site one');
  assert.equal(query.get('offset'), '50');
  for (const invalid of [
    { resourceType: 'website' }, { resourceId: 'id' }, { action: 'UPPER' }, { outcome: 'unknown' }, { from: 200, to: 100 },
  ]) assert.throws(() => auditFilterInput(invalid));
});

test('new audit read aborts and fences the old response', async (t) => {
  const first = deferred(); const second = deferred(); const calls = [];
  const f = fixture(t, (url, options) => { calls.push({ url, options }); return calls.length === 1 ? first.promise : second.promise; });
  const old = f.client.load(); const fresh = f.client.load({ offset: 50 });
  assert.equal(calls[0].options.signal.aborted, true);
  second.resolve(page([], 50, 1)); await fresh;
  first.resolve(page()); await old;
  assert.equal(f.state().data.offset, 50);
});

test('obsolete session and denied audit reads never retain privileged history', async (t) => {
  const waiting = deferred(); const stale = fixture(t, () => waiting.promise);
  const loading = stale.client.load(); stale.advance(); waiting.resolve(page()); await loading;
  assert.equal(stale.state().data, null);

  let denied = false;
  const f = fixture(t, async () => { if (denied) throw failure(403, 'forbidden'); return page(); });
  await f.client.load(); assert.equal(f.state().data.events.length, 1);
  denied = true; await f.client.load();
  assert.equal(f.state().data, null); assert.equal(f.lost(), 1);
});

test('malformed and network audit responses clear earlier privileged data', async (t) => {
  let response = page(); const f = fixture(t, async () => { if (response instanceof Error) throw response; return response; });
  await f.client.load(); response = { events: [] }; await f.client.load();
  assert.equal(f.state().data, null); assert.equal(f.state().error.code, 'audit_page_invalid');
  response = new TypeError('network'); await f.client.load();
  assert.equal(f.state().data, null); assert.equal(auditMessage(response).includes('network'), false);
});
