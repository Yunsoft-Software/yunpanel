import test from 'node:test';
import assert from 'node:assert/strict';
import { usagePercent, readableItems, databaseAccessView, filterConsoleDatabases, paginateConsoleItems } from './console-model.js';
const domains = { status: 'ready', items: [{ id: 'domain-a', websiteId: 'website-a', primaryDomain: 'yunsoft.test' }] };
const ready = { name: 'main_db', ownership: { websiteId: 'website-a', credential: { id: 'credential-a', username: 'main_user' } } };
const missing = { name: 'legacy_db', ownership: { websiteId: 'website-a', credential: null } };
const unbound = { name: 'unbound_db', ownership: null };
test('usage keeps zero and 91%, rejects unknown and inconsistent inventory', () => {
  assert.equal(usagePercent(0, 100), 0); assert.equal(usagePercent(91, 100), 91);
  for (const args of [[null, 100], [1, 0], [-1, 100], [101, 100], [NaN, 100], [1, Infinity]]) assert.equal(usagePercent(...args), null);
});
test('ready and stale are readable; failed inventories are not', () => {
  assert.equal(readableItems(domains).length, 1);
  assert.equal(readableItems({ ...domains, status: 'stale' }).length, 1);
  assert.deepEqual(readableItems({ ...domains, status: 'error' }), []);
});
test('phpMyAdmin uses explicit ownership and Domain route, not Website route guessing', () => {
  const view = databaseAccessView(ready, domains);
  assert.equal(view.canOpen, true); assert.equal(view.siteHref, '/websites/domain-a/resources');
  assert.equal(view.siteLabel, 'yunsoft.test');
});
test('missing credential gets a visible repair action', () => {
  const view = databaseAccessView(missing, domains);
  assert.equal(view.canOpen, false); assert.equal(view.label, 'Erişimi yapılandır'); assert.ok(view.siteHref);
});
test('unbound databases do not fabricate a website link or privilege', () => {
  const view = databaseAccessView(unbound, domains);
  assert.equal(view.canOpen, false); assert.equal(view.siteHref, null); assert.equal(view.label, 'Siteye bağla');
});
test('unavailable domain inventory cannot produce links', () => {
  assert.equal(databaseAccessView(ready, { ...domains, status: 'error' }).siteHref, null);
  assert.equal(databaseAccessView(ready, { status: 'ready', items: [] }).siteHref, null);
});
test('filters include database, username and related site', () => {
  const all = [ready, missing, unbound];
  assert.deepEqual(filterConsoleDatabases(all, { query: 'main_user', domains }), [ready]);
  assert.equal(filterConsoleDatabases(all, { query: 'yunsoft', domains }).length, 2);
  assert.equal(filterConsoleDatabases(all, { access: 'attention', domains }).length, 2);
  assert.deepEqual(filterConsoleDatabases(all, { access: 'ready', domains }), [ready]);
});
test('pagination bounds malformed pages and page sizes', () => {
  const all = Array.from({ length: 32 }, (_, n) => n);
  assert.equal(paginateConsoleItems(all, 999).page, 3);
  assert.deepEqual(paginateConsoleItems(all, 3).items, [30, 31]);
  assert.equal(paginateConsoleItems(all, -5).page, 1);
  assert.equal(paginateConsoleItems(all, 'NaN', 0).items.length, 15);
  assert.equal(paginateConsoleItems([], 9).page, 1);
});
