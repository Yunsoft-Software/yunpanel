import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhpSiteContainerManager, PhpSiteContainerManagerError } from '../src/php-site-container-manager.js';

const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const migrationOperationId = '4d7d1c87-c088-4c1d-bb44-7f370d315672';
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
      const [uid, gid] = owner === 'root:root'
        ? [0, 0]
        : owner.split(':').map((part) => Number.parseInt(part, 10));
      assert.equal(Number.isSafeInteger(uid) && uid >= 0, true);
      assert.equal(Number.isSafeInteger(gid) && gid >= 0, true);
      value.uid = uid;
      value.gid = gid;
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

function manager(fake, overrides = {}) {
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
    ...overrides,
  });
}

function receiptFs() {
  const files = new Map();
  const missing = () => { const error = new Error('missing'); error.code = 'ENOENT'; return error; };
  return {
    files,
    dependencies: {
      migrationReceiptRoot: '/receipts/php-container',
      mkdirFn: async () => {},
      readFileFn: async (target) => {
        if (!files.has(target)) throw missing();
        return files.get(target);
      },
      writeFileFn: async (target, content) => { files.set(target, String(content)); },
      renameFn: async (from, to) => {
        if (!files.has(from)) throw missing();
        files.set(to, files.get(from));
        files.delete(from);
      },
      rmFn: async (target) => { files.delete(target); },
    },
  };
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


test('PHP container migration candidate is limited to exact control-plane metadata drift', async () => {
  const fake = host();
  const preview = await manager(fake).previewMigration(intent(), { operationId });

  assert.equal(preview.safeMigrationCandidate, true);
  assert.deepEqual([...new Set(preview.differences)], ['php_site_container_control_plane_drift']);

  fake.entries.get(releaseDocumentRoot).mode = 0o755;
  const blocked = await manager(fake).previewMigration(intent(), { operationId });
  assert.equal(blocked.safeMigrationCandidate, false);
  assert.equal(blocked.differences.includes('php_site_container_release_drift'), true);
});

test('PHP container migration journals exact metadata, recovers by inspection and rolls back non-recursively', async () => {
  const fake = host();
  const receipts = receiptFs();
  const value = manager(fake, receipts.dependencies);

  const applied = await value.applyMigration(intent(), { operationId, migrationOperationId });
  assert.equal(applied.satisfied, true);
  assert.equal(applied.phpContainerReceiptVersion, 1);
  assert.equal(applied.migratedPhpContainer, true);
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
  assert.equal(receipts.files.size, 1);
  assert.match([...receipts.files.values()][0], /"state":"active"/);

  const restarted = manager(fake, receipts.dependencies);
  const inspected = await restarted.inspectMigrationOperation(intent(), { operationId, migrationOperationId });
  assert.equal(inspected.satisfied, true);
  assert.equal(inspected.receiptState, 'active');

  const rolledBack = await restarted.compensateMigration(intent(), { operationId, migrationOperationId });
  assert.equal(rolledBack.satisfied, true);
  assert.equal(rolledBack.restoredPhpContainerMetadata, true);
  assert.deepEqual(
    { uid: fake.entries.get(applicationRoot).uid, gid: fake.entries.get(applicationRoot).gid, mode: fake.entries.get(applicationRoot).mode },
    { uid: 1201, gid: 1201, mode: 0o750 },
  );
  assert.deepEqual(
    { uid: fake.entries.get(releasesDirectory).uid, gid: fake.entries.get(releasesDirectory).gid, mode: fake.entries.get(releasesDirectory).mode },
    { uid: 1201, gid: 1201, mode: 0o750 },
  );
  assert.deepEqual(
    { uid: fake.entries.get(currentRelease).uid, gid: fake.entries.get(currentRelease).gid },
    { uid: 1201, gid: 1201 },
  );
  assert.equal(fake.entries.get(releaseDirectory).uid, 1201);
  assert.match([...receipts.files.values()][0], /"state":"compensated"/);
});

test('PHP container migration rollback fails closed after unrelated metadata drift', async () => {
  const fake = host();
  const receipts = receiptFs();
  const value = manager(fake, receipts.dependencies);
  await value.applyMigration(intent(), { operationId, migrationOperationId });
  fake.entries.get(applicationRoot).uid = 9999;

  await assert.rejects(
    value.compensateMigration(intent(), { operationId, migrationOperationId }),
    (error) => error instanceof PhpSiteContainerManagerError
      && error.code === 'php_site_container_migration_compensation_drift',
  );
  assert.equal(fake.entries.get(releasesDirectory).uid, 0);
  assert.equal(fake.entries.get(currentRelease).uid, 0);
});


test('PHP container migration rollback refuses path type drift after receipt ownership', async () => {
  const fake = host();
  const receipts = receiptFs();
  const value = manager(fake, receipts.dependencies);
  await value.applyMigration(intent(), { operationId, migrationOperationId });
  const root = fake.entries.get(applicationRoot);
  root.directory = false;
  root.symbolicLink = true;

  await assert.rejects(
    value.compensateMigration(intent(), { operationId, migrationOperationId }),
    (error) => error instanceof PhpSiteContainerManagerError
      && error.code === 'php_site_container_migration_path_type_drift',
  );
});
