import test from 'node:test';
import assert from 'node:assert/strict';
import { initialScopedCollection, scopedCollectionReducer as reduce, scopedCollectionView as view } from '../src/workspace/collection-state.js';
const a = { path: '/applications/a/environment', enabled: true };
const b = { path: '/applications/b/environment', enabled: true };
function ready(scope = a, run = 1) {
  return reduce(reduce(initialScopedCollection(), { type: 'begin', scope, run }), { type: 'success', scope, run, items: ['private-a'], now: 1 });
}
test('resource change hides previous records before the effect starts', () => {
  const state = ready();
  assert.equal(view(state, a).status, 'ready');
  assert.deepEqual(view(state, b).items, []);
  assert.equal(view(state, b).status, 'loading');
});
test('disabled resources expose neither data nor a known count', () => {
  const off = { path: a.path, enabled: false };
  assert.equal(view(ready(), off).status, 'disabled');
  assert.deepEqual(view(ready(), off).items, []);
  const on = { ...a };
  assert.deepEqual(view(ready(), on).items, []);
});
test('late replies cannot populate a different scope even if abort arrives late', () => {
  const state = reduce(ready(), { type: 'begin', scope: b, run: 2 });
  for (const type of ['success', 'failure']) {
    assert.equal(reduce(state, { type, scope: a, run: 1, items: ['private-a'], error: { status: 401 } }), state);
  }
});
test('manual refresh fences an older response but retains same-resource data', () => {
  const state = reduce(ready(), { type: 'begin', scope: a, run: 2 });
  assert.deepEqual(view(state, a).items, ['private-a']);
  assert.equal(reduce(state, { type: 'success', scope: a, run: 1, items: ['old'] }), state);
  assert.deepEqual(reduce(state, { type: 'success', scope: a, run: 2, items: ['new'] }).value.items, ['new']);
});
test('disabled scope ignores subsequent responses', () => {
  const off = { path: a.path, enabled: false };
  const state = reduce(ready(), { type: 'begin', scope: off, run: 2 });
  assert.equal(reduce(state, { type: 'success', scope: off, run: 2, items: ['should-not-appear'] }), state);
});
test('current network failure is stale, access denial clears current records', () => {
  const stale = reduce(ready(), { type: 'failure', scope: a, run: 1, error: new TypeError() });
  assert.equal(stale.value.status, 'stale');
  assert.deepEqual(stale.value.items, ['private-a']);
  for (const status of [401, 403, 404]) {
    assert.deepEqual(reduce(ready(), { type: 'failure', scope: a, run: 1, error: { status } }).value.items, []);
  }
});
test('invalid payload and abort retain existing resource error semantics', () => {
  const state = ready();
  assert.equal(reduce(state, { type: 'success', scope: a, run: 1, items: null }).value.status, 'stale');
  assert.equal(reduce(state, { type: 'failure', scope: a, run: 1, error: { name: 'AbortError' } }).value, state.value);
});
