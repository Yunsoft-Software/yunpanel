import test from 'node:test';
import assert from 'node:assert/strict';
import { siteListPage } from '../src/workspace/site-list-model.js';
const row = (id, depth, state = 'active') => ({ domain: { id, state, targetType: 'proxy' }, depth });
const rows = [row('a', 0, 'draft'), row('b', 1), row('c', 2), row('d', 0), row('e', 1)];
test('page boundaries never detach a child from its parent group', () => {
  const first = siteListPage(rows, { perPage: 1 });
  assert.deepEqual(first.rows.map(x => x.domain.id), ['a', 'b', 'c']);
  assert.equal(first.pageCount, 2);
  assert.deepEqual(siteListPage(rows, { perPage: 1, page: 2 }).rows.map(x => x.domain.id), ['d', 'e']);
});
test('filtering retains necessary parent context without claiming it matches', () => {
  const result = siteListPage(rows, { status: 'active' });
  assert.equal(result.rows[0].contextOnly, true);
  assert.equal(result.rows[1].contextOnly, false);
  assert.equal(result.totalMatches, 4);
});
test('descending sort reverses groups without reversing child ancestry', () => {
  assert.deepEqual(siteListPage(rows, { sort: 'desc' }).rows.map(x => x.domain.id), ['d', 'e', 'a', 'b', 'c']);
});
test('invalid and out of range pagination clamps without changing source rows', () => {
  const before = JSON.stringify(rows);
  assert.equal(siteListPage(rows, { page: 999, perPage: 1 }).page, 2);
  assert.equal(siteListPage(rows, { page: NaN }).page, 1);
  assert.equal(siteListPage(rows, { type: 'static' }).pageCount, 1);
  assert.equal(JSON.stringify(rows), before);
});
