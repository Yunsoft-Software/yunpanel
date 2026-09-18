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

function fakeHost({ mutable = false, controlDrift = false, currentOwnerDrift = false, files = new Map() } = {}) {
  const calls = [];
  const entries = new Map([
    [publishRoot, { type: 'directory', uid: controlDrift ? 1201 : 0, gid: controlDrift ? 1201 : 0, mode: controlDrift ? 0o750 : 0o711 }],
    [releasesRoot, { type: 'directory', uid: controlDrift ? 1201 : 0, gid: controlDrift ? 1201 : 0, mode: controlDrift ? 0o750 : 0o711 }],
    [releaseRoot, {
      type: 'directory', uid: 1201, gid: 1201, mode: 0o750,
      acl: 'user::rwx\nuser:www-data:r-x\ngroup::r-x\nmask::r-x\nother::---\n',
    }],
    [assetPath, {
      type: 'file', uid: 1201, gid: 1201, mode: 0o640,
      acl: 'user::rw-\nuser:www-data:r--\ngroup::r--\nmask::r--\nother::---\n',
    }],
    [currentPath, { type: 'symlink', uid: currentOwnerDrift || controlDrift ? 1201 : 0, gid: currentOwnerDrift || controlDrift ? 1201 : 0, mode: 0o777 }],
  ]);
  let nextIno = 1000;
  for (const value of entries.values()) {
    value.dev = 1;
    value.ino = nextIno;
    nextIno += 1;
  }
  const fdTargets = new Map();
  let nextFd = 40;
  const resolveTarget = (target) => {
    const match = String(target).match(new RegExp(`^/proc/${process.pid}/fd/(\\d+)import assert from 'node:assert/strict';
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

function fakeHost({ mutable = false, controlDrift = false, currentOwnerDrift = false, files = new Map() } = {}) {
  const calls = [];
  const entries = new Map([
    [publishRoot, { type: 'directory', uid: controlDrift ? 1201 : 0, gid: controlDrift ? 1201 : 0, mode: controlDrift ? 0o750 : 0o711 }],
    [releasesRoot, { type: 'directory', uid: controlDrift ? 1201 : 0, gid: controlDrift ? 1201 : 0, mode: controlDrift ? 0o750 : 0o711 }],
    [releaseRoot, {
      type: 'directory', uid: 1201, gid: 1201, mode: 0o750,
      acl: 'user::rwx\nuser:www-data:r-x\ngroup::r-x\nmask::r-x\nother::---\n',
    }],
    [assetPath, {
      type: 'file', uid: 1201, gid: 1201, mode: 0o640,
      acl: 'user::rw-\nuser:www-data:r--\ngroup::r--\nmask::r--\nother::---\n',
    }],
    [currentPath, { type: 'symlink', uid: currentOwnerDrift || controlDrift ? 1201 : 0, gid: currentOwnerDrift || controlDrift ? 1201 : 0, mode: 0o777 }],
  ]);
));
    return match ? fdTargets.get(Number.parseInt(match[1], 10)) : target;
  };
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
      dev: value.dev,
      ino: value.ino,
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
    const resolvedTarget = resolveTarget(args.at(-1));
    if (file === '/usr/bin/getfacl') {
      const entry = entries.get(resolvedTarget);
      if (!entry) throw new Error(`unexpected getfacl target ${args.at(-1)}`);
      return { stdout: entry.acl ?? '' };
    }
    if (mutable && file === '/usr/bin/chown') {
      const entry = entries.get(resolvedTarget);
      if (!entry) throw new Error('unexpected chown target');
      const owner = args.includes('-h') ? args[1] : args[0];
      const [uid, gid] = owner === 'root:root'
        ? [0, 0]
        : owner.split(':').map((part) => Number.parseInt(part, 10));
      entry.uid = uid;
      entry.gid = gid;
      return { stdout: '' };
    }
    if (mutable && file === '/usr/bin/setfacl' && String(args[0]).startsWith('--set-file=')) {
      const aclPath = String(args[0]).slice('--set-file='.length);
      const entry = entries.get(resolvedTarget);
      if (!entry || !files.has(aclPath)) throw new Error('unexpected setfacl state');
      entry.acl = files.get(aclPath);
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
    openFn: async (target) => {
      const entry = entries.get(target);
      if (!entry || entry.type === 'symlink') {
        const error = new Error('nofollow');
        error.code = 'ELOOP';
        throw error;
      }
      const fd = nextFd;
      nextFd += 1;
      fdTargets.set(fd, target);
      return {
        fd,
        async stat() {
          return {
            uid: entry.uid, gid: entry.gid, mode: entry.mode, dev: entry.dev, ino: entry.ino,
            isDirectory: () => entry.type === 'directory',
            isFile: () => entry.type === 'file',
          };
        },
        async chown(uid, gid) { entry.uid = uid; entry.gid = gid; },
        async chmod(mode) {
          entry.mode = mode;
          const lines = String(entry.acl ?? '').split(/\r?\n/).filter(Boolean);
          const hasMask = lines.some((line) => line.startsWith('mask::'));
          const owner = entry.type === 'directory' ? 'rwx' : 'rw-';
          const group = entry.type === 'directory' ? 'r-x' : 'r--';
          const other = '---';
          entry.acl = `${lines.map((line) => {
            if (line.startsWith('user::')) return `user::${owner}`;
            if (line.startsWith('other::')) return `other::${other}`;
            if (hasMask && line.startsWith('mask::')) return `mask::${group}`;
            if (!hasMask && line.startsWith('group::')) return `group::${group}`;
            return line;
          }).join('\n')}\n`;
        },
        async close() { fdTargets.delete(fd); },
      };
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
    openFn: host.openFn,
    readdirFn: host.readdirFn,
    readlinkFn: host.readlinkFn,
    ...overrides,
  });
}

function receiptFs(files = new Map()) {
  const missing = () => { const error = new Error('missing'); error.code = 'ENOENT'; return error; };
  return {
    files,
    dependencies: {
      migrationReceiptRoot: '/receipts/static-control',
      releaseMigrationReceiptRoot: '/receipts/static-release',
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


test('static release permission preview hashes exact managed tree without exposing file paths or ACL text', async () => {
  const host = fakeHost();
  host.entries.get(assetPath).mode = 0o644;
  const value = manager(host);

  const first = await value.previewReleaseMigration({ websiteId, applicationId });

  assert.equal(first.version, 1);
  assert.equal(first.adapter, 'static-release-permissions');
  assert.equal(first.satisfied, false);
  assert.equal(first.automaticMigration, false);
  assert.equal(first.repairCandidate, true);
  assert.equal(first.migrationBlockedReason, 'static_release_receipt_not_operation_owned');
  assert.deepEqual(first.current.releases, [releaseId]);
  assert.equal(first.current.tree.entryCount, 2);
  assert.equal(first.current.tree.ownershipModeDriftCount, 1);
  assert.equal(first.current.tree.aclDriftCount, 0);
  assert.match(first.current.tree.sha256, /^[a-f0-9]{64}$/);
  assert.equal(first.differences.includes('static_publish_release_drift'), true);
  assert.equal(JSON.stringify(first).includes(assetPath), false);
  assert.equal(JSON.stringify(first).includes('user:www-data:r--'), true);
  assert.equal(JSON.stringify(first).includes('index.html'), false);

  host.entries.get(assetPath).mode = 0o600;
  const second = await value.previewReleaseMigration({ websiteId, applicationId });
  assert.notEqual(first.current.tree.sha256, second.current.tree.sha256);
});

test('static release permission preview fails closed when current target is not a managed release', async () => {
  const host = fakeHost();
  host.entries.get(assetPath).mode = 0o644;
  host.readlinkFn = async () => 'releases/3854e385-adfc-42bd-bccf-f655f24cd68f';

  const preview = await manager(host).previewReleaseMigration({ websiteId, applicationId });

  assert.equal(preview.repairCandidate, false);
  assert.equal(preview.differences.includes('static_publish_current_drift'), true);
});


test('static release permission migration applies exact receipt state and rolls back entry-by-entry', async () => {
  const files = new Map();
  const receipts = receiptFs(files);
  const host = fakeHost({ mutable: true, files });
  host.entries.get(assetPath).uid = 9999;
  host.entries.get(assetPath).acl = 'user::rw-\nuser:www-data:---\ngroup::r--\nmask::r--\nother::---\n';
  const value = manager(host, receipts.dependencies);

  const preview = await value.previewReleaseMigration({ websiteId, applicationId });
  assert.equal(preview.repairCandidate, true);
  assert.equal(preview.current.tree.ownershipModeDriftCount, 1);
  assert.equal(preview.current.tree.aclDriftCount, 1);

  const applied = await value.applyReleaseMigration(
    { websiteId, applicationId },
    { operationId: migrationOperationId },
  );
  assert.equal(applied.satisfied, true);
  assert.equal(applied.staticReleaseReceiptVersion, 1);
  assert.equal(applied.migratedStaticReleasePermissions, true);
  assert.equal(host.entries.get(assetPath).uid, 1201);
  assert.equal(host.entries.get(assetPath).mode, 0o640);
  assert.match(host.entries.get(assetPath).acl, /user:www-data:r--/);
  assert.equal(host.calls.some(([file, args]) => file === '/usr/bin/setfacl' && args.includes('-R')), false);
  assert.equal(host.calls.some(([, args]) => args.includes('-R')), false);

  const restarted = manager(host, receipts.dependencies);
  const inspected = await restarted.inspectReleaseMigrationOperation(
    { websiteId, applicationId },
    { operationId: migrationOperationId },
  );
  assert.equal(inspected.satisfied, true);
  assert.equal(inspected.receiptState, 'active');

  const rolledBack = await restarted.compensateReleaseMigration(
    { websiteId, applicationId },
    { operationId: migrationOperationId },
  );
  assert.equal(rolledBack.satisfied, true);
  assert.equal(rolledBack.restoredStaticReleasePermissions, true);
  assert.equal(rolledBack.receiptState, 'compensated');
  assert.equal(host.entries.get(assetPath).uid, 9999);
  assert.match(host.entries.get(assetPath).acl, /user:www-data:---/);
});

test('static release rollback blocks inode or ACL drift not owned by the receipt', async () => {
  for (const mutate of [
    (host) => { host.entries.get(assetPath).ino += 1; },
    (host) => { host.entries.get(assetPath).acl += 'user:foreign:r--\n'; },
  ]) {
    const files = new Map();
    const receipts = receiptFs(files);
    const host = fakeHost({ mutable: true, files });
    host.entries.get(assetPath).uid = 9999;
    const value = manager(host, receipts.dependencies);
    await value.applyReleaseMigration({ websiteId, applicationId }, { operationId: migrationOperationId });
    mutate(host);

    await assert.rejects(
      value.compensateReleaseMigration(
        { websiteId, applicationId },
        { operationId: migrationOperationId },
      ),
      (error) => error?.code === 'static_publish_release_migration_drift',
    );
  }
});
