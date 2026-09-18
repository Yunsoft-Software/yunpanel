import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationIdentity } from '../src/application-identity.js';
import { createStaticPublishIsolationManager } from '../src/static-publish-isolation-manager.js';

const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const releaseId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const migrationOperationId = '4d7d1c87-c088-4c1d-bb44-7f370d315672';
const identity = createApplicationIdentity(applicationId);
const publishRoot = identity.paths.static.publishRoot;
const releasesRoot = `${publishRoot}/releases`;
const releaseRoot = `${releasesRoot}/${releaseId}`;
const assetPath = `${releaseRoot}/index.html`;
const currentPath = `${publishRoot}/current`;

function fakeHost({ mutable = false, controlDrift = false, currentOwnerDrift = false } = {}) {
  const calls = [];
  const entries = new Map([
    [publishRoot, { type: 'directory', uid: controlDrift ? 1201 : 0, gid: controlDrift ? 1201 : 0, mode: controlDrift ? 0o750 : 0o711 }],
    [releasesRoot, { type: 'directory', uid: controlDrift ? 1201 : 0, gid: controlDrift ? 1201 : 0, mode: controlDrift ? 0o750 : 0o711 }],
    [releaseRoot, { type: 'directory', uid: 1201, gid: 1201, mode: 0o750 }],
    [assetPath, { type: 'file', uid: 1201, gid: 1201, mode: 0o640 }],
    [currentPath, { type: 'symlink', uid: currentOwnerDrift || controlDrift ? 1201 : 0, gid: currentOwnerDrift || controlDrift ? 1201 : 0, mode: 0o777 }],
  ]);
  const lstatFn = async (target) => {
    const value = entries.get(target);
    if (!value) {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
    return {
      uid: value.uid,
      gid: value.gid,
      mode: value.mode,
      isDirectory: () => value.type === 'directory',
      isFile: () => value.type === 'file',
      isSymbolicLink: () => value.type === 'symlink',
    };
  };
  const readdirFn = async (target) => {
    if (target === releasesRoot) {
      return [{ name: releaseId, isDirectory: () => true }];
    }
    if (target === releaseRoot) {
      return [{ name: 'index.html', isDirectory: () => false }];
    }
    return [];
  };
  const run = async (file, args) => {
    calls.push([file, [...args]]);
    if (file === '/usr/bin/getfacl') {
      const target = args.at(-1);
      const entry = entries.get(target);
      return {
        stdout: entry?.type === 'directory'
          ? 'user:www-data:r-x\n'
          : 'user:www-data:r--\n',
      };
    }
    if (mutable && file === '/usr/bin/chown') {
      const target = args.at(-1);
      const entry = entries.get(target);
      if (!entry) throw new Error('unexpected chown target');
      const owner = args.includes('-h') ? args[1] : args[0];
      const [uid, gid] = owner === 'root:root'
        ? [0, 0]
        : owner.split(':').map((part) => Number.parseInt(part, 10));
      entry.uid = uid;
      entry.gid = gid;
      return { stdout: '' };
    }
    throw new Error(`unexpected command ${file} ${args.join(' ')}`);
  };
  return {
    calls,
    entries,
    run,
    accessFn: async () => {},
    lstatFn,
    readdirFn,
    readlinkFn: async (target) => {
      assert.equal(target, currentPath);
      return `releases/${releaseId}`;
    },
    chmodFn: async (target, mode) => {
      if (!mutable) throw new Error('preview must not chmod');
      const entry = entries.get(target);
      if (!entry) throw new Error('unexpected chmod target');
      entry.mode = mode;
    },
    chownFn: async (target, uid, gid) => {
      if (!mutable) throw new Error('preview must not chown');
      const entry = entries.get(target);
      if (!entry) throw new Error('unexpected chown target');
      entry.uid = uid;
      entry.gid = gid;
    },
  };
}

function manager(host, overrides = {}) {
  return createStaticPublishIsolationManager({
    identityManager: {
      inspect: async (value) => {
        assert.deepEqual(value, {
          user: identity.unixUser,
          homeDirectory: identity.paths.workspace.homeDirectory,
          websiteId,
          applicationId,
        });
        return {
          satisfied: true,
          user: identity.unixUser,
          uid: 1201,
          gid: 1201,
          homeDirectory: identity.paths.workspace.homeDirectory,
        };
      },
    },
    run: host.run,
    accessFn: host.accessFn,
    chmodFn: host.chmodFn,
    chownFn: host.chownFn,
    lstatFn: host.lstatFn,
    readdirFn: host.readdirFn,
    readlinkFn: host.readlinkFn,
    ...overrides,
  });
}

function receiptFs() {
  const files = new Map();
  const missing = () => { const error = new Error('missing'); error.code = 'ENOENT'; return error; };
  return {
    files,
    dependencies: {
      migrationReceiptRoot: '/receipts/static-control',
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

test('static publish migration preview snapshots exact release isolation without mutation', async () => {
  const host = fakeHost();
  const preview = await manager(host).previewMigration({ websiteId, applicationId });

  assert.equal(preview.version, 1);
  assert.equal(preview.adapter, 'static-publish-isolation');
  assert.equal(preview.satisfied, true);
  assert.deepEqual(preview.current.identity, {
    satisfied: true,
    uid: 1201,
    gid: 1201,
    homeDirectory: identity.paths.workspace.homeDirectory,
  });
  assert.equal(preview.current.aclToolsAvailable, true);
  assert.equal(preview.current.publishRoot.mode, '0711');
  assert.equal(preview.current.releasesRoot.mode, '0711');
  assert.deepEqual(preview.current.releases, [{
    releaseId,
    satisfied: true,
    reason: null,
  }]);
  assert.deepEqual(preview.current.current, {
    present: true,
    symbolicLink: true,
    uid: 0,
    gid: 0,
    target: `releases/${releaseId}`,
  });
  assert.equal(preview.desired.publishRoot, publishRoot);
  assert.equal(preview.desired.controlDirectoryMode, '0711');
  assert.deepEqual(preview.differences, []);
  assert.equal(host.calls.some(([file]) => ['/usr/bin/apt-get', '/usr/bin/chown', '/usr/bin/setfacl'].includes(file)), false);
});

test('static publish migration preview reports release ownership drift without repairing it', async () => {
  const host = fakeHost();
  host.entries.get(assetPath).mode = 0o644;

  const preview = await manager(host).previewMigration({ websiteId, applicationId });

  assert.equal(preview.satisfied, false);
  assert.deepEqual(preview.current.releases, [{
    releaseId,
    satisfied: false,
    reason: 'static_publish_release_drift',
  }]);
  assert.equal(preview.differences.includes('static_publish_release_drift'), true);
  assert.equal(host.entries.get(assetPath).mode, 0o644);
  assert.equal(host.calls.some(([file]) => ['/usr/bin/apt-get', '/usr/bin/chown', '/usr/bin/setfacl'].includes(file)), false);
});


test('static publish migration preview normalizes a non-symlink current path into bounded drift', async () => {
  const host = fakeHost();
  host.readlinkFn = async () => {
    const error = new Error('not a symlink');
    error.code = 'EINVAL';
    throw error;
  };

  const preview = await manager(host).previewMigration({ websiteId, applicationId });

  assert.equal(preview.satisfied, false);
  assert.deepEqual(preview.current.current, {
    present: false,
    error: 'static_publish_current_invalid',
  });
  assert.equal(preview.differences.includes('static_publish_current_invalid'), true);
});


test('static publish migration opens only for exact control-plane metadata drift', async () => {
  const host = fakeHost({ controlDrift: true });
  const preview = await manager(host).previewMigration({ websiteId, applicationId });

  assert.equal(preview.satisfied, false);
  assert.equal(preview.safeMigrationCandidate, true);
  assert.equal(preview.current.releases.every((entry) => entry.satisfied), true);
  assert.deepEqual([...new Set(preview.differences)].sort(), [
    'static_publish_container_drift',
    'static_publish_current_drift',
  ]);

  host.entries.get(assetPath).mode = 0o644;
  const blocked = await manager(host).previewMigration({ websiteId, applicationId });
  assert.equal(blocked.safeMigrationCandidate, false);
  assert.equal(blocked.differences.includes('static_publish_release_drift'), true);
});

test('static control migration journals metadata, recovers by inspection and rolls back non-recursively', async () => {
  const host = fakeHost({ mutable: true, controlDrift: true });
  const receipts = receiptFs();
  const value = manager(host, receipts.dependencies);

  const applied = await value.applyMigration({ websiteId, applicationId }, { operationId: migrationOperationId });
  assert.equal(applied.satisfied, true);
  assert.equal(applied.staticControlReceiptVersion, 1);
  assert.equal(applied.migratedStaticControlMetadata, true);
  assert.deepEqual(
    { uid: host.entries.get(publishRoot).uid, gid: host.entries.get(publishRoot).gid, mode: host.entries.get(publishRoot).mode },
    { uid: 0, gid: 0, mode: 0o711 },
  );
  assert.deepEqual(
    { uid: host.entries.get(releasesRoot).uid, gid: host.entries.get(releasesRoot).gid, mode: host.entries.get(releasesRoot).mode },
    { uid: 0, gid: 0, mode: 0o711 },
  );
  assert.deepEqual(
    { uid: host.entries.get(currentPath).uid, gid: host.entries.get(currentPath).gid },
    { uid: 0, gid: 0 },
  );
  assert.equal(host.entries.get(releaseRoot).uid, 1201);
  assert.equal(host.entries.get(assetPath).mode, 0o640);
  assert.equal(host.calls.some(([file, args]) => file === '/usr/bin/setfacl' || args.includes('-R')), false);
  assert.match([...receipts.files.values()][0], /"state":"active"/);

  const restarted = manager(host, receipts.dependencies);
  const inspected = await restarted.inspectMigrationOperation(
    { websiteId, applicationId },
    { operationId: migrationOperationId },
  );
  assert.equal(inspected.satisfied, true);
  assert.equal(inspected.receiptState, 'active');

  const rolledBack = await restarted.compensateMigration(
    { websiteId, applicationId },
    { operationId: migrationOperationId },
  );
  assert.equal(rolledBack.satisfied, true);
  assert.equal(rolledBack.restoredStaticControlMetadata, true);
  assert.equal(rolledBack.receiptState, 'compensated');
  assert.deepEqual(
    { uid: host.entries.get(publishRoot).uid, gid: host.entries.get(publishRoot).gid, mode: host.entries.get(publishRoot).mode },
    { uid: 1201, gid: 1201, mode: 0o750 },
  );
  assert.deepEqual(
    { uid: host.entries.get(releasesRoot).uid, gid: host.entries.get(releasesRoot).gid, mode: host.entries.get(releasesRoot).mode },
    { uid: 1201, gid: 1201, mode: 0o750 },
  );
  assert.deepEqual(
    { uid: host.entries.get(currentPath).uid, gid: host.entries.get(currentPath).gid },
    { uid: 1201, gid: 1201 },
  );
  assert.equal(host.entries.get(releaseRoot).uid, 1201);
  assert.equal(host.entries.get(assetPath).mode, 0o640);
});

test('static control migration rollback fails closed on foreign metadata or path-type drift', async () => {
  for (const mutate of [
    (host) => { host.entries.get(publishRoot).uid = 9999; },
    (host) => { host.entries.get(publishRoot).type = 'symlink'; },
  ]) {
    const host = fakeHost({ mutable: true, controlDrift: true });
    const receipts = receiptFs();
    const value = manager(host, receipts.dependencies);
    await value.applyMigration({ websiteId, applicationId }, { operationId: migrationOperationId });
    mutate(host);

    await assert.rejects(
      value.compensateMigration({ websiteId, applicationId }, { operationId: migrationOperationId }),
      (error) => error?.code === 'static_publish_migration_compensation_drift'
        || error?.code === 'static_publish_migration_path_type_drift',
    );
  }
});
