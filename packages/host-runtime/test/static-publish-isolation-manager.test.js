import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationIdentity } from '../src/application-identity.js';
import { createStaticPublishIsolationManager } from '../src/static-publish-isolation-manager.js';

const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const releaseId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const identity = createApplicationIdentity(applicationId);
const publishRoot = identity.paths.static.publishRoot;
const releasesRoot = `${publishRoot}/releases`;
const releaseRoot = `${releasesRoot}/${releaseId}`;
const assetPath = `${releaseRoot}/index.html`;
const currentPath = `${publishRoot}/current`;

function fakeHost() {
  const calls = [];
  const entries = new Map([
    [publishRoot, { type: 'directory', uid: 0, gid: 0, mode: 0o711 }],
    [releasesRoot, { type: 'directory', uid: 0, gid: 0, mode: 0o711 }],
    [releaseRoot, { type: 'directory', uid: 1201, gid: 1201, mode: 0o750 }],
    [assetPath, { type: 'file', uid: 1201, gid: 1201, mode: 0o640 }],
    [currentPath, { type: 'symlink', uid: 0, gid: 0, mode: 0o777 }],
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
    chmodFn: async () => { throw new Error('preview must not chmod'); },
    chownFn: async () => { throw new Error('preview must not chown'); },
  };
}

function manager(host) {
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
  });
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
