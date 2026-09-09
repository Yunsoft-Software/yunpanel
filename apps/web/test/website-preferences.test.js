import test from 'node:test';
import assert from 'node:assert/strict';
import { WEBSITE_PREFERENCES_KEY, normalizeWebsitePreferences as normalize, readWebsitePreferences as read, saveWebsitePreferences as save } from '../src/workspace/website-preferences.js';
const defaults = { version: 1, density: 'comfortable', perPage: 10 };
test('unknown schema and corrupt browser storage use safe defaults', () => {
  for (const value of [null, [], 'test', { version: 2, density: 'compact', perPage: 50 }]) assert.deepEqual(normalize(value), defaults);
  assert.deepEqual(read({ getItem: () => '{bad-json' }), defaults);
});
test('page size and density accept only declared values', () => {
  for (const perPage of [10, 25, 50]) assert.equal(normalize({ version: 1, perPage }).perPage, perPage);
  for (const perPage of [-1, 0, 100, '25', Infinity]) assert.equal(normalize({ version: 1, perPage }).perPage, 10);
  assert.equal(normalize({ version: 1, density: 'compact' }).density, 'compact');
  assert.equal(normalize({ version: 1, density: 'invalid-class' }).density, 'comfortable');
});
test('only non-sensitive view fields can be persisted', () => {
  let stored;
  assert.equal(save({ setItem: (key, value) => { assert.equal(key, WEBSITE_PREFERENCES_KEY); stored = value; } }, {
    version: 1, density: 'compact', perPage: 25, token: 'do-not-store', query: 'private.example', domainId: 'private-id', items: ['private'],
  }), true);
  assert.deepEqual(JSON.parse(stored), { version: 1, density: 'compact', perPage: 25 });
});
test('blocked storage never breaks list rendering or requires credentials', () => {
  assert.deepEqual(read(null), defaults);
  assert.deepEqual(read({ getItem: () => { throw new Error('blocked'); } }), defaults);
  assert.equal(save(null, defaults), false);
  assert.equal(save({ setItem: () => { throw new Error('quota'); } }, defaults), false);
});
test('preferences round-trip without retaining unrelated stored fields', () => {
  let data = JSON.stringify({ version: 1, density: 'compact', perPage: 50, username: 'discard' });
  const storage = { getItem: () => data, setItem: (_key, value) => { data = value; } };
  const preferences = read(storage);
  assert.equal(preferences.perPage, 50); assert.equal(preferences.username, undefined);
  save(storage, preferences);
  assert.equal(data.includes('discard'), false);
  assert.deepEqual(read(storage), preferences);
});
test('normalization never mutates the caller input', () => {
  const input = Object.freeze({ version: 1, density: 'compact', perPage: 25 });
  assert.deepEqual(normalize(input), input);
  assert.notEqual(normalize(input), input);
});
