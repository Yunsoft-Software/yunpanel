import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiHistory, createAiConversationReader, resolveAiWebsiteContext } from '../src/workspace/ai-history.js';
const site = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const item = (n, patch = {}) => ({ id: `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`, title: `Sohbet ${n}`, websiteId: site,
  createdAt: '2026-09-24T00:00:00Z', updatedAt: '2026-09-24T00:00:00Z', messageCount: 0, ...patch });
const page = (items, nextCursor = null, patch = {}) => ({ items, hasMore: nextCursor !== null, nextCursor, legacyUnassigned: false, scope: { actorId: 'owner', websiteId: site }, ...patch });
const gate = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function harness(read, extra = {}) {
  const states = [], calls = [];
  const history = createAiHistory({ actorId: 'owner', websiteId: site, read: (options) => { calls.push(options); return read(options); },
    onState: (state) => states.push(state), ...extra });
  return { history, calls, states };
}

test('loads only the first page, then appends older entries without reloading existing history', async () => {
  const run = harness(async ({ cursor }) => cursor ? page([item(1)]) : page([item(3), item(2)], 'next'));
  await run.history.load(); assert.equal(run.calls.length, 1); assert.equal(run.calls[0].limit, 20);
  const first = run.history.getState().items[0]; await run.history.more();
  assert.deepEqual(run.history.getState().items.map((r) => r.id), [3, 2, 1].map((n) => item(n).id));
  assert.equal(run.history.getState().items[0], first); assert.equal(run.calls[1].cursor, 'next');
  await run.history.more(); assert.equal(run.calls.length, 2);
});
test('repeated scroll triggers while loading produce one request', async () => {
  const pending = gate(); const run = harness(async ({ cursor }) => cursor ? pending.promise : page([item(2)], 'next'));
  await run.history.load(); const first = run.history.more(); await run.history.more(); await run.history.more();
  assert.equal(run.calls.length, 2); pending.resolve(page([item(1)])); await first;
});
test('failed older page preserves items and cursor for an explicit retry', async () => {
  let fail = true; const run = harness(async ({ cursor }) => {
    if (!cursor) return page([item(2)], 'next'); if (fail) throw new Error('private transport'); return page([item(1)]);
  });
  await run.history.load(); await run.history.more(); assert.equal(run.history.getState().status, 'error');
  assert.equal(run.history.getState().items.length, 1); assert.equal(run.history.getState().nextCursor, 'next');
  fail = false; await run.history.more(); assert.equal(run.history.getState().items.length, 2);
  assert.equal(JSON.stringify(run.states).includes('private transport'), false);
});
test('expired cursor requires reload rather than repeatedly requesting the stale page', async () => {
  const run = harness(async ({ cursor }) => { if (cursor) throw Object.assign(new Error('expired'), { code: 'invalid_ai_history_cursor' }); return page([item(2)], 'next'); });
  await run.history.load(); await run.history.more(); await run.history.more(); assert.equal(run.calls.length, 2);
  assert.equal(run.history.getState().reloadRequired, true); await run.history.load(); assert.equal(run.calls.at(-1).cursor, null);
});
test('repeated or circular cursors cannot cause an automatic fetch loop', async () => {
  const run = harness(async ({ cursor }) => cursor ? page([item(1)], cursor) : page([item(2)], 'next'));
  await run.history.load(); await run.history.more(); assert.equal(run.history.getState().status, 'error'); assert.equal(run.history.getState().items.length, 1);
});
test('overlapping pages deduplicate identities and cannot replace a newer local header', async () => {
  const run = harness(async ({ cursor }) => cursor ? page([item(2), item(1)]) : page([item(3), item(2)], 'next'));
  await run.history.load(); run.history.upsert(item(2, { title: 'Güncel', updatedAt: '2026-09-24T01:00:00Z', messageCount: 2 }));
  await run.history.more(); assert.equal(run.history.getState().items.length, 3);
  assert.equal(run.history.getState().items[1].title, 'Güncel');
});
test('a new conversation created during the first GET is not lost when its stale reply arrives', async () => {
  const pending = gate(); const run = harness(() => pending.promise); const loading = run.history.load();
  run.history.upsert(item(3)); pending.resolve(page([item(2)])); await loading;
  assert.deepEqual(run.history.getState().items.map((r) => r.id), [item(3).id, item(2).id]);
});
test('a deleted conversation cannot reappear from an already pending page', async () => {
  const pending = gate(); const run = harness(async ({ cursor }) => cursor ? pending.promise : page([item(2)], 'next'));
  await run.history.load(); const loading = run.history.more(); run.history.remove(item(2).id); pending.resolve(page([item(2), item(1)])); await loading;
  assert.deepEqual(run.history.getState().items.map((r) => r.id), [item(1).id]);
});
test('new first-page read supersedes and aborts an older load', async () => {
  const pending = gate(); let count = 0; const run = harness(() => ++count === 1 ? pending.promise : Promise.resolve(page([item(3)])));
  const first = run.history.load(); await run.history.load(); pending.resolve(page([item(1)])); await first;
  assert.equal(run.calls[0].signal.aborted, true); assert.equal(run.history.getState().items[0].id, item(3).id);
});
for (const status of [401, 403]) test(`${status} clears previously loaded conversation summaries`, async () => {
  let fail = false; const run = harness(async () => { if (fail) throw Object.assign(new Error('denied'), { status }); return page([item(1)]); });
  await run.history.load(); fail = true; await run.history.load(); assert.equal(run.history.getState().status, 'forbidden'); assert.equal(run.history.getState().items.length, 0);
  run.history.upsert(item(2)); assert.equal(run.history.getState().items.length, 0);
});
for (const patch of [ { scope: { actorId: 'other', websiteId: site } }, { scope: { actorId: 'owner', websiteId: other } },
  { items: [item(1), item(1)] }, { items: [item(1, { websiteId: other })] }, { items: [item(1, { createdAt: 'bad' })] },
  { items: [], hasMore: true, nextCursor: 'next' }, { hasMore: false, nextCursor: 'unexpected' }, { items: Array.from({ length: 21 }, (_, i) => item(i)) } ]) {
  test('malformed or cross-scope page is never published as valid history', async () => {
    const run = harness(async () => page([item(1)], null, patch)); await run.history.load();
    assert.equal(run.history.getState().status, 'error'); assert.equal(run.history.getState().items.length, 0);
  });
}
for (const stop of ['dispose', 'session']) test(`${stop} ignores late list replies`, async () => {
  let current = true; const pending = gate(); const run = harness(() => pending.promise, { isCurrent: () => current }); const loading = run.history.load();
  if (stop === 'dispose') run.history.dispose(); else current = false;
  const count = run.states.length; pending.resolve(page([item(1)])); await loading; assert.equal(run.states.length, count);
});
test('detail reader ignores old A when B is selected before A completes', async () => {
  const a = gate(), b = gate(), states = [];
  const reader = createAiConversationReader({ websiteId: site, read: (id) => id === item(1).id ? a.promise : b.promise, onState: (state) => states.push(state) });
  const first = reader.load(item(1).id), second = reader.load(item(2).id);
  b.resolve({ ...item(2), messages: [] }); await second; a.resolve({ ...item(1), messages: [] }); await first;
  assert.equal(states.at(-1).conversation.id, item(2).id);
});
test('wrong detail identity and wrong Website cannot replace the selected conversation', async () => {
  for (const value of [{ ...item(2), messages: [] }, { ...item(1, { websiteId: other }), messages: [] }]) {
    const states = []; const reader = createAiConversationReader({ websiteId: site, read: async () => value, onState: (state) => states.push(state) });
    await reader.load(item(1).id); assert.equal(states.at(-1).status, 'error'); assert.equal(states.at(-1).conversation, null);
  }
});
test('detail selection reset and disposal ignore outstanding requests', async () => {
  const pending = gate(), states = []; const reader = createAiConversationReader({ websiteId: site, read: () => pending.promise, onState: (state) => states.push(state) });
  const first = reader.load(item(1).id); await reader.load(null); reader.dispose(); pending.resolve({ ...item(1), messages: [] }); await first;
  assert.equal(states.at(-1).status, 'idle'); assert.equal(states.at(-1).conversation, null);
});
test('Domain URL identity is resolved to the actual same-server Website before AI access', async () => {
  const calls = []; const id = await resolveAiWebsiteContext(other, async (path) => {
    calls.push(path); return path.startsWith('/domains/') ? { id: other, websiteId: site, serverId: 'local' } : { id: site, serverId: 'local' };
  });
  assert.equal(id, site); assert.deepEqual(calls, [`/domains/${other}`, `/websites/${site}`]);
});
test('missing, mismatched or cross-server Website cannot fall back to a global AI context', async () => {
  for (const website of [null, { id: other, serverId: 'local' }, { id: site, serverId: 'other' }]) {
    await assert.rejects(resolveAiWebsiteContext(other, async (path) => path.startsWith('/domains/') ? { id: other, websiteId: site, serverId: 'local' } : website));
  }
  await assert.rejects(resolveAiWebsiteContext('new', async () => { throw new Error('not called'); }));
});
