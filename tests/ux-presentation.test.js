import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFERENCES, PREFERENCE_KEY, normalizePreferences, readPreferences, writePreferences, resolveTheme, navigationGroups, websiteCount, commandEntries, groupSiteTabs } from '../apps/web/src/workspace/ui/ux-model.js';

test('preferences accept only the documented themes and density', () => {
  assert.deepEqual(normalizePreferences({ theme: 'dark', density: 'compact', token: 'secret' }), { theme: 'dark', density: 'compact' });
  assert.deepEqual(normalizePreferences({ theme: 'invalid', density: 'dense' }), DEFAULT_PREFERENCES);
  assert.deepEqual(normalizePreferences(null), DEFAULT_PREFERENCES);
});
test('malformed and unavailable storage do not break the workspace', () => {
  assert.deepEqual(readPreferences({ getItem: () => '{invalid' }), DEFAULT_PREFERENCES);
  assert.deepEqual(readPreferences({ getItem: () => { throw new Error('blocked'); } }), DEFAULT_PREFERENCES);
  assert.equal(writePreferences({ setItem: () => { throw new Error('quota'); } }, {}), false);
});
test('storage payload is restricted to two non-sensitive preferences', () => {
  let result;
  assert.equal(writePreferences({ setItem: (key, value) => { result = [key, JSON.parse(value)]; } }, { theme: 'light', density: 'compact', password: 'NEVER_STORE', domains: ['private'] }), true);
  assert.deepEqual(result, [PREFERENCE_KEY, { theme: 'light', density: 'compact' }]);
});
test('system theme follows OS and explicit theme wins', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});
test('read-only navigation retains only the existing authorized route set', () => {
  assert.deepEqual(navigationGroups(false).flatMap((group) => group.items.map(([to]) => to)), ['/websites', '/dashboard', '/servers']);
});
test('owner navigation preserves existing screens without advertising an unsupported backup screen', () => {
  const paths = navigationGroups(true).flatMap((group) => group.items.map(([to]) => to));
  assert.equal(paths.length, 9); assert.equal(new Set(paths).size, 9);
  assert.ok(paths.includes('/jobs')); assert.ok(!paths.includes('/applications')); assert.ok(!paths.includes('/backups'));
});
test('website counter uses unique Website records, not hostnames or aliases', () => {
  assert.equal(websiteCount({ status: 'ready', items: [{ id: 'w1', aliases: ['a', 'b'] }, { id: 'w1' }, { id: 'w2' }] }), 2);
  assert.equal(websiteCount({ status: 'ready', items: [] }), 0);
});
test('unavailable inventories are never represented as zero', () => {
  for (const status of ['loading', 'idle', 'forbidden', 'unauthorized', 'error']) assert.equal(websiteCount({ status, items: [{ id: 'hidden' }] }), null);
});
test('command palette cannot expose unavailable or forbidden domain data', () => {
  for (const status of ['idle', 'loading', 'forbidden', 'unauthorized', 'error']) {
    const entries = commandEntries({ domains: { status, items: [{ id: 'private', primaryDomain: 'private.example' }] } });
    assert.ok(!entries.some((entry) => entry.id === 'domain:private'));
  }
});
test('read-only command palette does not expose mutation or management destinations', () => {
  const entries = commandEntries({ query: '', canManage: false });
  assert.deepEqual(entries.map((entry) => entry.to), ['/websites', '/dashboard', '/servers']);
});
test('domain search preserves Domain route identity and safely encodes it', () => {
  const result = commandEntries({ query: 'alias', domains: { status: 'ready', items: [{ id: 'd/one', websiteId: 'w1', primaryDomain: 'example.test', aliases: ['alias.test'] }] } });
  assert.equal(result[0].to, '/websites/d%2Fone/overview');
  assert.ok(result.some((entry) => entry.to === '/websites?q=alias'));
});
test('search has bounded domain suggestions and encodes query strings', () => {
  const domains = { status: 'ready', items: Array.from({ length: 100 }, (_, i) => ({ id: String(i), primaryDomain: `site${i}.test` })) };
  assert.equal(commandEntries({ query: 'site', domains }).filter((entry) => entry.id.startsWith('domain:')).length, 8);
  assert.equal(commandEntries({ query: 'a&b?#' }).at(-1).to, '/websites?q=a%26b%3F%23');
  assert.equal(new URL(commandEntries({ query: 'x'.repeat(500) }).at(-1).to, 'https://panel.test').searchParams.get('q').length, 253);
});
test('site grouping keeps every existing tab exactly once in at most six groups', () => {
  const tabs = ['overview', 'resources', 'node', 'deploy', 'domains', 'dns', 'ssl', 'files', 'logs', 'terminal', 'settings'].map((key) => [key, key]);
  const grouped = groupSiteTabs(tabs);
  assert.equal(grouped.length, 6);
  assert.deepEqual(grouped.flatMap((group) => group.tabs.map(([key]) => key)).sort(), tabs.map(([key]) => key).sort());
});
test('runtime-filtered and future backend tabs remain reachable without placeholders', () => {
  assert.deepEqual(groupSiteTabs([['overview', 'Overview']]).map((group) => group.id), ['overview']);
  const grouped = groupSiteTabs([['overview', 'Overview'], ['future-runtime', 'New runtime']]);
  assert.ok(grouped.find((group) => group.id === 'operations').tabs.some(([key]) => key === 'future-runtime'));
});
