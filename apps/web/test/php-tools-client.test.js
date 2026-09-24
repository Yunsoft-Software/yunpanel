import assert from 'node:assert/strict';
import test from 'node:test';
import { phpToolsStatus, resolvePhpToolsAccess, phpToolsScope } from '../src/workspace/php-tools-model.js';
import { createPhpToolsClient } from '../src/workspace/php-tools-client.js';

const scope = { websiteId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', serverId: '22222222-2222-4222-8222-222222222222',
  applicationId: '11111111-1111-4111-8111-111111111111', unixUser: 'yunapp-0123456789ab' };
const domainId = '33333333-3333-4333-8333-333333333333';
const shared = { schemaVersion: 1, ...scope, available: true, version: '2.8.1', inspectedAt: '2026-09-25T00:00:00.000Z' };
const wp = () => ({ ...shared, installed: true, coreVersion: '6.4.2', plugins: [{ name: 'example', status: 'active', version: '1.0', secret: 'not-for-UI' }], themes: [],
  checks: { installation: 'ready', coreVersion: 'ready', plugins: 'ready', themes: 'ready' } });
const composer = () => ({ ...shared, hasComposerJson: true, hasComposerLock: true, valid: true, projectLocation: 'root',
  checks: { project: 'present', lock: 'present', validation: 'ready' } });
function access() { return { domainId, canManage: true, domains: { status: 'ready', items: [{ id: domainId, websiteId: scope.websiteId, serverId: scope.serverId }] },
  websites: { status: 'ready', items: [{ id: scope.websiteId, ...scope, runtimeType: 'php' }] } }; }
function harness(options = {}) {
  const calls = []; let handler = async (path) => path.includes('/wp-cli/') ? wp() : composer();
  const client = createPhpToolsClient({ scope, request: (path, options) => { calls.push({ path, ...options }); return handler(path, options); }, ...options });
  return { client, calls, handle(fn) { handler = fn; } };
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
test('PHP domain resolves to Website identity, without Domain-ID substitution', () => {
  const value = resolvePhpToolsAccess(access()); assert.equal(value.state, 'ready'); assert.deepEqual(value.scope, scope); assert.notEqual(scope.websiteId, domainId);
});
for (const status of ['loading', 'stale', 'error', 'forbidden', 'unauthorized']) {
  test(`inventory state ${status} cannot open PHP tools`, () => {
    const input = access(); input.websites.status = status; assert.notEqual(resolvePhpToolsAccess(input).state, 'ready');
  });
}
for (const change of ['no-permission', 'no-binding', 'duplicate-domain', 'duplicate-website', 'wrong-server', 'wrong-runtime', 'wrong-unix']) {
  test(`access rejects ${change}`, () => {
    const input = access();
    if (change === 'no-permission') input.canManage = false;
    if (change === 'no-binding') input.domains.items[0].websiteId = null;
    if (change === 'duplicate-domain') input.domains.items.push(input.domains.items[0]);
    if (change === 'duplicate-website') input.websites.items.push(input.websites.items[0]);
    if (change === 'wrong-server') input.websites.items[0].serverId = domainId;
    if (change === 'wrong-runtime') input.websites.items[0].runtimeType = 'node';
    if (change === 'wrong-unix') input.websites.items[0].unixUser = 'root';
    assert.notEqual(resolvePhpToolsAccess(input).state, 'ready');
  });
}
for (const field of Object.keys(scope)) {
  test(`response with foreign ${field} is rejected`, () => {
    for (const [tool, value] of [['wordpress', wp()], ['composer', composer()]]) assert.throws(() => phpToolsStatus(tool, { ...value, [field]: domainId }, scope));
  });
}
test('scope rejects unsafe path and root user', () => {
  for (const field of Object.keys(scope)) assert.throws(() => phpToolsScope({ ...scope, [field]: '../root' }));
});
test('WP inventory keeps only display fields', () => {
  const result = phpToolsStatus('wordpress', wp(), scope);
  assert.deepEqual(result.plugins, [{ name: 'example', status: 'active', version: '1.0' }]);
});
test('false readiness, duplicate entries and malformed lists are rejected', () => {
  const values = [wp(), wp(), wp(), wp()];
  values[0].available = false; values[1].plugins.push(values[1].plugins[0]); values[2].plugins = {}; values[3].checks.coreVersion = 'unknown';
  for (const value of values) assert.throws(() => phpToolsStatus('wordpress', value, scope));
});
test('unknown WP installation is not absence; inventories must be unchecked', () => {
  const value = { ...wp(), installed: null, coreVersion: null, plugins: [], themes: [], checks: { installation: 'unknown', coreVersion: 'not_checked', plugins: 'not_checked', themes: 'not_checked' } };
  assert.equal(phpToolsStatus('wordpress', value, scope).installed, null);
  value.plugins = [{ name: 'wrong', status: 'active' }]; assert.throws(() => phpToolsStatus('wordpress', value, scope));
});
test('composer unknown project remains unknown', () => {
  const value = { ...composer(), hasComposerJson: null, hasComposerLock: null, valid: null, projectLocation: null, checks: { project: 'unknown', lock: 'not_checked', validation: 'not_checked' } };
  assert.equal(phpToolsStatus('composer', value, scope).hasComposerJson, null);
});
for (const patch of [{ valid: true, available: false }, { hasComposerJson: false }, { projectLocation: '../private' }, { schemaVersion: 2 }, { inspectedAt: 'invalid' }]) {
  test(`invalid Composer result ${JSON.stringify(patch)} is rejected`, () => assert.throws(() => phpToolsStatus('composer', { ...composer(), ...patch }, scope)));
}
test('both sections use existing Website GET status endpoints only', async () => {
  const h = harness(); assert.deepEqual(await h.client.loadAll(), [true, true]);
  assert.deepEqual(h.calls.map((c) => c.path), [`/websites/${scope.websiteId}/wp-cli/status`, `/websites/${scope.websiteId}/composer/status`]);
  assert.ok(h.calls.every((c) => c.method === undefined && c.body === undefined));
  assert.equal(h.client.getSnapshot().wordpress.fresh, true); assert.equal(h.client.getSnapshot().composer.fresh, true);
});
test('one failed section does not hide the other successful section', async () => {
  const h = harness(); h.handle(async (path) => { if (path.includes('wp-cli')) throw new Error('raw secret'); return composer(); });
  await h.client.loadAll(); const value = h.client.getSnapshot();
  assert.equal(value.wordpress.data, null); assert.equal(value.composer.fresh, true);
  assert.ok(!value.wordpress.error.includes('raw secret'));
});
test('failed refresh labels previous data stale without inventing tool absence', async () => {
  const h = harness(); await h.client.load('wordpress'); h.handle(async () => { throw new Error(); });
  await h.client.load('wordpress'); assert.equal(h.client.getSnapshot().wordpress.fresh, false);
  assert.equal(h.client.getSnapshot().wordpress.data.available, true);
});
test('old response cannot overwrite newer section data and old request is aborted', async () => {
  const h = harness(), pending = deferred(); h.handle(() => pending.promise);
  const first = h.client.load('wordpress'); h.handle(async () => ({ ...wp(), coreVersion: '6.4.3' }));
  await h.client.load('wordpress'); pending.resolve(wp()); await first;
  assert.equal(h.client.getSnapshot().wordpress.data.coreVersion, '6.4.3'); assert.equal(h.calls[0].signal.aborted, true);
});
for (const status of [401, 403]) {
  test(`${status} clears both channels and blocks late success`, async () => {
    const h = harness(); await h.client.loadAll(); const pending = deferred();
    h.handle(async (path) => { if (path.includes('wp-cli')) throw Object.assign(new Error(), { status }); return pending.promise; });
    const reads = h.client.loadAll(); pending.resolve(composer()); await reads;
    const value = h.client.getSnapshot(); assert.equal(value.denied, true); assert.equal(value.wordpress.data, null); assert.equal(value.composer.data, null);
    const count = h.calls.length; await h.client.loadAll(); assert.equal(h.calls.length, count);
  });
}
test('a permission failure in a superseded request still invalidates both sections', async () => {
  const h = harness(), pending = deferred(); h.handle(() => pending.promise); const first = h.client.load('wordpress');
  h.handle(async () => wp()); await h.client.load('wordpress'); pending.reject(Object.assign(new Error(), { status: 403 })); await first;
  assert.equal(h.client.getSnapshot().denied, true);
});
test('session change rejects a late result', async () => {
  let valid = true; const h = harness({ isCurrent: () => valid }), pending = deferred(); h.handle(() => pending.promise);
  const loading = h.client.load('composer'); valid = false; pending.resolve(composer()); await loading;
  assert.equal(h.client.getSnapshot().composer.data, null);
});
test('unmount aborts both requests and never publishes late results', async () => {
  const h = harness(), pending = deferred(); h.handle(() => pending.promise); let count = 0; h.client.subscribe(() => count++);
  const loading = h.client.loadAll(); h.client.dispose(); const before = count;
  pending.resolve(wp()); await loading; assert.equal(count, before); assert.ok(h.calls.every((c) => c.signal.aborted));
});
test('unsupported tool cannot be turned into an arbitrary API path', async () => {
  const h = harness(); await assert.rejects(h.client.load('../run')); assert.equal(h.calls.length, 0);
});
