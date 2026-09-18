import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhpSiteContainerManager, PhpSiteContainerManagerError } from '../src/php-site-container-manager.js';

const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const unixUser = 'yunapp-4dc352e64a14';
const applicationRoot = `/var/lib/yunpanel/apps/${applicationId}`;
const releasesDirectory = `${applicationRoot}/releases`;
const releaseDirectory = `${releasesDirectory}/${operationId}`;
const releaseDocumentRoot = `${releaseDirectory}/public`;
const currentRelease = `${applicationRoot}/current`;
const documentRoot = `${currentRelease}/public`;

function intent() {
  return { websiteId, applicationId, unixUser, documentRoot };
}

function host({ currentTarget = releaseDirectory, releaseUid = 1201 } = {}) {
  const calls = [];
  const entries = new Map([
    [applicationRoot, { type: 'directory', uid: 1201, gid: 1201, mode: 0o750 }],
    [releasesDirectory, { type: 'directory', uid: 1201, gid: 1201, mode: 0o750 }],
    [releaseDirectory, { type: 'directory', uid: releaseUid, gid: 1201, mode: 0o750 }],
    [releaseDocumentRoot, { type: 'directory', uid: releaseUid, gid: 1201, mode: 0o750 }],
    [currentRelease, { type: 'symlink', uid: 1201, gid: 1201, mode: 0o777, target: currentTarget }],
  ]);
  const lstatFn = async (target) => {
    const value = entries.get(target);
    if (!value) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
    return {
      uid: value.uid,
      gid: value.gid,
      mode: value.mode,
      isDirectory: () => value.type === 'directory',
      isSymbolicLink: () => value.type === 'symlink',
    };
  };
  const readlinkFn = async (target) => entries.get(target)?.target;
  const run = async (file, args) => {
    calls.push([file, [...args]]);
    const target = args.at(-1);
    const value = entries.get(target);
    if (!value) throw new Error('unexpected target');
    if (file === '/usr/bin/chown') {
      const owner = args.includes('-h') ? args[1] : args[0];
      assert.equal(owner, 'root:root');
      value.uid = 0;
      value.gid = 0;
      return { stdout: '' };
    }
    if (file === '/usr/bin/chmod') {
      value.mode = Number.parseInt(args[0], 8);
      return { stdout: '' };
    }
    throw new Error(`unexpected command ${file}`);
  };
  return { entries, calls, run, lstatFn, readlinkFn };
}

function manager(fake) {
  return createPhpSiteContainerManager({
    identityManager: {
      inspect: async (value) => {
        assert.deepEqual(value, {
          user: unixUser,
          homeDirectory: `/var/lib/yunpanel/data/${applicationId}`,
          websiteId,
          applicationId,
        });
        return { satisfied: true, user: unixUser, uid: 1201, gid: 1201, homeDirectory: value.homeDirectory };
      },
    },
    run: fake.run,
    lstatFn: fake.lstatFn,
    readlinkFn: fake.readlinkFn,
  });
}

test('PHP container lockdown keeps release site-owned while making routing containers root-owned', async () => {
  const fake = host();
  const value = manager(fake);

  const result = await value.apply(intent(), { operationId });

  assert.equal(result.satisfied, true);
  assert.equal(result.containerOwner, 'root:root');
  assert.equal(result.releaseUid, 1201);
  assert.deepEqual(
    { uid: fake.entries.get(applicationRoot).uid, gid: fake.entries.get(applicationRoot).gid, mode: fake.entries.get(applicationRoot).mode },
    { uid: 0, gid: 0, mode: 0o755 },
  );
  assert.deepEqual(
    { uid: fake.entries.get(releasesDirectory).uid, gid: fake.entries.get(releasesDirectory).gid, mode: fake.entries.get(releasesDirectory).mode },
    { uid: 0, gid: 0, mode: 0o755 },
  );
  assert.equal(fake.entries.get(currentRelease).uid, 0);
  assert.equal(fake.entries.get(releaseDirectory).uid, 1201);
  assert.equal(fake.entries.get(releaseDocumentRoot).uid, 1201);
});

test('PHP container lockdown is idempotent after control-plane ownership is established', async () => {
  const fake = host();
  const value = manager(fake);
  await value.apply(intent(), { operationId });
  const second = await value.apply(intent(), { operationId });
  assert.equal(second.satisfied, true);
  assert.equal(second.releaseId, operationId);
});

test('PHP container lockdown refuses release ownership or current-target drift', async () => {
  const releaseDrift = host({ releaseUid: 9999 });
  await assert.rejects(
    manager(releaseDrift).apply(intent(), { operationId }),
    (error) => error instanceof PhpSiteContainerManagerError && error.code === 'php_site_container_release_drift',
  );

  const currentDrift = host({ currentTarget: '/tmp/escaped-release' });
  await assert.rejects(
    manager(currentDrift).apply(intent(), { operationId }),
    (error) => error instanceof PhpSiteContainerManagerError && error.code === 'php_site_container_current_drift',
  );
});


test('PHP container migration preview reports exact ownership transition without changing host state', async () => {
  const fake = host();
  const value = manager(fake);

  const preview = await value.previewMigration(intent(), { operationId });

  assert.equal(preview.version, 1);
  assert.equal(preview.adapter, 'php-container');
  assert.equal(preview.satisfied, false);
  assert.equal(preview.current.identity.uid, 1201);
  assert.equal(preview.current.applicationRoot.uid, 1201);
  assert.equal(preview.current.applicationRoot.mode, '0750');
  assert.equal(preview.current.releaseDirectory.uid, 1201);
  assert.equal(preview.current.currentTarget, releaseDirectory);
  assert.equal(preview.desired.applicationRoot, applicationRoot);
  assert.equal(preview.desired.releaseDirectory, releaseDirectory);
  assert.equal(preview.differences.includes('php_site_container_control_plane_drift'), true);
  assert.deepEqual(fake.calls, []);
  assert.equal(fake.entries.get(applicationRoot).uid, 1201);
  assert.equal(fake.entries.get(currentRelease).uid, 1201);
});

test('PHP container migration preview becomes satisfied after exact lockdown and pins current-target drift', async () => {
  const fake = host();
  const value = manager(fake);
  await value.apply(intent(), { operationId });

  const healthy = await value.previewMigration(intent(), { operationId });
  assert.equal(healthy.satisfied, true);
  assert.deepEqual(healthy.differences, []);
  assert.equal(healthy.current.applicationRoot.uid, 0);
  assert.equal(healthy.current.releasesDirectory.mode, '0755');
  assert.equal(healthy.current.currentRelease.symbolicLink, true);

  fake.entries.get(currentRelease).target = '/tmp/escaped-release';
  const drift = await value.previewMigration(intent(), { operationId });
  assert.equal(drift.satisfied, false);
  assert.equal(drift.current.currentTarget, '/tmp/escaped-release');
  assert.equal(drift.differences.includes('php_site_container_current_drift'), true);
});
