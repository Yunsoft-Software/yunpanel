import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationScope, conversationVisible, createConversationPager } from '../src/ai-conversation-history.js';
const siteA = '11111111-1111-4111-8111-111111111111';
const siteB = '22222222-2222-4222-8222-222222222222';
const auth = (id = 'owner-a') => ({ user: { id, role: 'owner' }, access: { mode: 'management', permissions: ['*'] }, security: { managementAllowed: true } });
const manager = (websiteIds = [siteA]) => ({ user: { id: 'manager-a', role: 'site_manager', websiteIds }, access: { mode: 'site_management' }, security: { managementAllowed: true } });
const row = (n, patch = {}) => ({ id: `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`, actorId: 'owner-a', websiteId: siteA,
  title: `Conversation ${n}`, messages: [{ text: 'private content' }], createdAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T00:00:00.000Z', ...patch });

test('stable keyset pages include all equal-time records exactly once, bounded to requested size', () => {
  const list = Array.from({ length: 53 }, (_, i) => row(i)); const page = createConversationPager(); const scope = conversationScope(auth());
  let cursor = null; const seen = [];
  do { const result = page(list, scope, { cursor, limit: 20 }); assert.ok(result.items.length <= 20); seen.push(...result.items.map((r) => r.id)); cursor = result.nextCursor; assert.equal(result.hasMore, cursor !== null); } while (cursor);
  assert.equal(seen.length, 53); assert.equal(new Set(seen).size, 53); assert.deepEqual(seen, list.map((r) => r.id).sort().reverse());
});
test('actor and Website filters apply before paging, not to the returned page afterwards', () => {
  const list = [row(1), row(2, { actorId: 'owner-b' }), row(3, { websiteId: siteB }), row(4, { actorId: null })];
  const result = createConversationPager()(list, conversationScope(auth(), siteA), { limit: 1 });
  assert.deepEqual(result.items.map((r) => r.id), [row(1).id]); assert.equal(result.hasMore, false); assert.equal(result.legacyUnassigned, true);
  assert.equal(JSON.stringify(result).includes('private content'), false); assert.equal(JSON.stringify(result).includes('owner-b'), false);
});
test('a cursor cannot cross actors, selected sites, grants or a restarted service', () => {
  const list = [row(1), row(2)]; const page = createConversationPager(); const scope = conversationScope(auth(), siteA);
  const { nextCursor } = page(list, scope, { limit: 1 });
  for (const other of [conversationScope(auth('owner-b'), siteA), conversationScope(auth(), siteB), conversationScope(auth())]) {
    assert.throws(() => page(list, other, { cursor: nextCursor }), { code: 'invalid_ai_history_cursor' });
  }
  assert.throws(() => createConversationPager()(list, scope, { cursor: nextCursor }), { code: 'invalid_ai_history_cursor' });
  const m = manager([siteA, siteB]); const mine = list.map((r) => ({ ...r, actorId: m.user.id }));
  const token = page(mine, conversationScope(m), { limit: 1 }).nextCursor;
  assert.throws(() => page(mine, conversationScope(manager([siteA])), { cursor: token }), { code: 'invalid_ai_history_cursor' });
});
test('tampered, oversized and malformed cursor values fail closed', () => {
  const page = createConversationPager(); const list = [row(1), row(2)]; const scope = conversationScope(auth());
  const token = page(list, scope, { limit: 1 }).nextCursor;
  for (const cursor of ['', {}, [], 'x'.repeat(2000), `${token}x`, `${token.slice(0, -1)}!`, token.replace(/^./, token[0] === 'a' ? 'b' : 'a')]) {
    assert.throws(() => page(list, scope, { cursor }), { code: 'invalid_ai_history_cursor' });
  }
});
test('invalid limits are not coerced or used as unbounded queries', () => {
  for (const limit of [0, -1, 51, 1.2, null, '20', {}, Infinity]) assert.throws(() => createConversationPager()([], conversationScope(auth()), { limit }), { code: 'invalid_ai_history_limit' });
});
test('a deleted cursor anchor and newer messages cannot skip older conversations', () => {
  const page = createConversationPager(); const scope = conversationScope(auth()); const list = [row(1), row(2), row(3), row(4)];
  const first = page(list, scope, { limit: 2 }); list.splice(2, 1); list[0].updatedAt = '2027-01-01T00:00:00Z';
  list.push(row(5, { createdAt: '2026-09-25T00:00:00Z' }));
  const second = page(list, scope, { cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(second.items.map((r) => r.id), [row(2).id, row(1).id]); assert.equal(second.hasMore, false);
});
test('site managers only see their own conversations for currently granted Websites', () => {
  const scope = conversationScope(manager());
  assert.equal(conversationVisible(row(1, { actorId: 'manager-a' }), scope), true);
  for (const patch of [{ actorId: 'manager-b' }, { websiteId: siteB }, { websiteId: null }, { actorId: null }]) {
    assert.equal(conversationVisible(row(1, { actorId: 'manager-a', ...patch }), scope), false);
  }
  assert.throws(() => conversationScope(manager(), siteB), { status: 404 });
  assert.throws(() => conversationScope(manager(), '../invalid'), { code: 'invalid_ai_website' });
});
test('missing identity, read-only role and management denial cannot enumerate history', () => {
  assert.throws(() => conversationScope(null), { status: 401 });
  const a = auth(); a.security.managementAllowed = false; assert.throws(() => conversationScope(a), { status: 403 });
  a.security.managementAllowed = true; a.user.role = 'read_only'; assert.throws(() => conversationScope(a), { status: 403 });
});
test('empty and final pages have null cursor and never expose message/tool payloads', () => {
  const page = createConversationPager(); const scope = conversationScope(auth());
  assert.deepEqual(page([], scope).items, []); assert.equal(page([], scope).nextCursor, null);
  const result = page([row(1, { secret: 'private-api-key' })], scope);
  assert.deepEqual(Object.keys(result.items[0]), ['id', 'title', 'websiteId', 'createdAt', 'updatedAt', 'messageCount']);
  assert.equal(JSON.stringify(result).includes('private'), false); assert.equal(Object.isFrozen(result.items), true);
});
