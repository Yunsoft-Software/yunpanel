import assert from 'node:assert/strict';
import test from 'node:test';
import { createSiteFileManager, SiteFileManagerError, siteFileManagerInternals } from '../src/site-file-manager.js';

const SERVER_ID = '9d4a4727-1aba-4d35-95fe-21db67042ce8';
const WEBSITE_ID = 'ff830043-9752-4640-83b4-3a1998de78a0';
const APPLICATION_ID = '2f334b35-03ce-4aa0-a8e4-b2ad4f592541';
const RELEASE_ID = '216e4db8-468b-4e2f-a021-3ab31e0f4123';

function website(overrides = {}) {
  return {
    id: WEBSITE_ID,
    serverId: SERVER_ID,
    applicationId: APPLICATION_ID,
    runtimeType: 'node',
    documentRoot: `/var/lib/yunpanel/apps/${APPLICATION_ID}/current`,
    unixUser: siteFileManagerInternals.appUnixUser(APPLICATION_ID),
    ...overrides,
  };
}

function fixture(overrides = {}) {
  const calls = [];
  const current = `/var/lib/yunpanel/apps/${APPLICATION_ID}/current`;
  const root = `/var/lib/yunpanel/apps/${APPLICATION_ID}/releases/${RELEASE_ID}`;
  const manager = createSiteFileManager({
    websiteRegistry: { getWebsite: async (id) => id === WEBSITE_ID ? website(overrides.website) : null },
    localServerId: overrides.localServerId === undefined ? SERVER_ID : overrides.localServerId,
    getuid: () => overrides.uid ?? 0,
    statFn: async () => ({ isDirectory: () => overrides.directory ?? true }),
    realpathFn: async () => overrides.releaseRoot ?? root,
    readPasswd: async () => `${siteFileManagerInternals.appUnixUser(APPLICATION_ID)}:x:991:991::/srv/yunpanel/build/${APPLICATION_ID}:/usr/sbin/nologin\n`,
    runWorker: async (input) => { calls.push(input); return { entries: [] }; },
  });
  return { manager, calls, current, root };
}

test('site file manager binds one local Website release to its deterministic Unix account', async () => {
  const state = fixture();
  assert.deepEqual(await state.manager.execute(WEBSITE_ID, { operation: 'list', path: '' }), { entries: [] });
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].user, siteFileManagerInternals.appUnixUser(APPLICATION_ID));
  assert.deepEqual(state.calls[0].request, { operation: 'list', path: '', root: state.root });
});

test('site file manager rejects non-root, remote, proxy and forged managed targets', async () => {
  const cases = [
    [fixture({ uid: 501 }).manager, 'site_files_root_runtime_required'],
    [fixture({ localServerId: 'other' }).manager, 'site_files_remote_unsupported'],
    [fixture({ website: { runtimeType: 'proxy', applicationId: null, documentRoot: null, unixUser: null } }).manager, 'site_files_unsupported'],
    [fixture({ website: { documentRoot: '/tmp/forged/current' } }).manager, 'site_files_target_invalid'],
    [fixture({ releaseRoot: `/var/lib/yunpanel/apps/${APPLICATION_ID}/other/${RELEASE_ID}` }).manager, 'site_files_release_invalid'],
  ];
  for (const [manager, code] of cases) {
    await assert.rejects(
      manager.execute(WEBSITE_ID, { operation: 'list', path: '' }),
      (error) => error instanceof SiteFileManagerError && error.code === code,
    );
  }
});

test('site file manager rejects missing Websites and managed Unix accounts', async () => {
  const missing = fixture();
  await assert.rejects(missing.manager.execute('missing', { operation: 'list', path: '' }), { code: 'website_not_found' });
  assert.throws(
    () => siteFileManagerInternals.parseManagedAccount('root:x:0:0:root:/root:/bin/bash\n', siteFileManagerInternals.appUnixUser(APPLICATION_ID)),
    (error) => error instanceof SiteFileManagerError && error.code === 'site_file_account_missing',
  );
});

test('site file manager serializes operations for one Application release', async () => {
  const gates = [];
  let active = 0;
  let maximum = 0;
  const target = website();
  const manager = createSiteFileManager({
    websiteRegistry: { getWebsite: async () => target },
    localServerId: SERVER_ID,
    getuid: () => 0,
    statFn: async () => ({ isDirectory: () => true }),
    realpathFn: async () => `/var/lib/yunpanel/apps/${APPLICATION_ID}/releases/${RELEASE_ID}`,
    readPasswd: async () => `${target.unixUser}:x:900:900::/var/lib/yunpanel/build/${APPLICATION_ID}:/usr/sbin/nologin\n`,
    runWorker: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => gates.push(resolve));
      active -= 1;
      return { ok: true };
    },
  });
  const first = manager.execute(WEBSITE_ID, { operation: 'write_text' });
  const second = manager.execute(WEBSITE_ID, { operation: 'rename' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 1);
  gates.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 1);
  gates.shift()();
  await Promise.all([first, second]);
  assert.equal(maximum, 1);
});

test('site file manager accepts only structured worker responses', () => {
  assert.deepEqual(siteFileManagerInternals.parseWorkerResult('{"ok":true,"data":{"done":true}}'), { done: true });
  assert.throws(
    () => siteFileManagerInternals.parseWorkerResult('{"ok":false,"error":{"code":"site_file_changed","message":"changed","status":409}}'),
    (error) => error instanceof SiteFileManagerError && error.code === 'site_file_changed' && error.status === 409,
  );
  assert.throws(
    () => siteFileManagerInternals.parseWorkerResult('not-json'),
    (error) => error instanceof SiteFileManagerError && error.code === 'site_file_worker_failed',
  );
});
