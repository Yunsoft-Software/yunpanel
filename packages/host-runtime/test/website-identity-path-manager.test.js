import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebsiteIdentityPathManager,
  WebsiteIdentityPathManagerError,
} from '../src/website-identity-path-manager.js';

const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const baseIntent = Object.freeze({
  user: 'yunapp-0123456789ab',
  homeDirectory: `/var/lib/yunpanel/data/${applicationId}`,
});
const boundIntent = Object.freeze({
  ...baseIntent,
  websiteId,
  applicationId,
});

function baseIdentity(overrides = {}) {
  return Object.freeze({
    satisfied: true,
    user: baseIntent.user,
    uid: 1201,
    gid: 1201,
    homeDirectory: baseIntent.homeDirectory,
    shell: '/usr/sbin/nologin',
    homeMode: 0o750,
    ...overrides,
  });
}

function fakeIdentityManager() {
  const calls = [];
  return {
    calls,
    inspect: async (intent) => {
      calls.push(['inspect', intent]);
      return baseIdentity();
    },
    apply: async (intent, options) => {
      calls.push(['apply', intent, options]);
      return baseIdentity({ created: true, receiptVersion: 1 });
    },
    compensate: async (intent, options) => {
      calls.push(['compensate', intent, options]);
      return { satisfied: true, removedUser: true };
    },
    inspectCompensation: async (intent, options) => {
      calls.push(['inspectCompensation', intent, options]);
      return { satisfied: true, removedUser: true };
    },
  };
}

function fakeWorkspace() {
  const entries = new Map();
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, [...args]]);
    assert.equal(file, '/usr/bin/install');
    const mode = Number.parseInt(args[args.indexOf('-m') + 1], 8);
    const directory = args.at(-1);
    entries.set(directory, { uid: 1201, gid: 1201, mode });
    return { stdout: '' };
  };
  const lstatFn = async (directory) => {
    const entry = entries.get(directory);
    if (!entry) {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
    return {
      ...entry,
      isDirectory: () => true,
    };
  };
  return { entries, calls, run, lstatFn };
}

test('path-bound identity apply prepares and verifies only site-owned tmp/log workspace', async () => {
  const identityManager = fakeIdentityManager();
  const workspace = fakeWorkspace();
  const manager = createWebsiteIdentityPathManager({
    identityManager,
    run: workspace.run,
    lstatFn: workspace.lstatFn,
  });

  const result = await manager.apply(boundIntent, { operationId: '9ae512c0-a717-4611-943c-6ce2ab0abf16' });

  assert.equal(result.satisfied, true);
  assert.equal(result.created, true);
  assert.equal(result.receiptVersion, 1);
  assert.equal(result.pathContract.workspace.sftpRoot, baseIntent.homeDirectory);
  assert.equal(result.pathContract.workspace.persistentDataDirectory, baseIntent.homeDirectory);
  assert.equal(result.pathContract.backup.authority, 'control_plane');
  assert.equal(result.pathContract.backup.artifactRoot, '/var/lib/yunpanel/backups/resources');
  assert.equal(result.pathContract.backup.scopeKey, `website:${websiteId}`);

  assert.deepEqual(workspace.calls, [
    ['/usr/bin/install', [
      '-d', '-o', baseIntent.user, '-g', baseIntent.user, '-m', '0700', `${baseIntent.homeDirectory}/tmp`,
    ]],
    ['/usr/bin/install', [
      '-d', '-o', baseIntent.user, '-g', baseIntent.user, '-m', '0750', `${baseIntent.homeDirectory}/logs`,
    ]],
  ]);
  assert.equal(workspace.calls.some(([, args]) => args.some((value) => String(value).includes('/backups/'))), false);
  assert.deepEqual(identityManager.calls[0].slice(0, 2), ['apply', baseIntent]);
});

test('path-bound identity inspect reports missing workspace without mutating host state', async () => {
  const identityManager = fakeIdentityManager();
  const workspace = fakeWorkspace();
  const manager = createWebsiteIdentityPathManager({
    identityManager,
    run: workspace.run,
    lstatFn: workspace.lstatFn,
  });

  const result = await manager.inspect(boundIntent);

  assert.equal(result.satisfied, false);
  assert.equal(result.reason, 'website_identity_workspace_missing');
  assert.equal(result.missingWorkspace, 'temporary');
  assert.deepEqual(workspace.calls, []);
});

test('path-bound identity inspect fails closed on workspace ownership or mode drift', async () => {
  const identityManager = fakeIdentityManager();
  const workspace = fakeWorkspace();
  workspace.entries.set(`${baseIntent.homeDirectory}/tmp`, { uid: 9999, gid: 1201, mode: 0o700 });
  const manager = createWebsiteIdentityPathManager({
    identityManager,
    run: workspace.run,
    lstatFn: workspace.lstatFn,
  });

  await assert.rejects(
    manager.inspect(boundIntent),
    (error) => error instanceof WebsiteIdentityPathManagerError
      && error.code === 'website_identity_workspace_drift',
  );
  assert.deepEqual(workspace.calls, []);
});

test('path-bound identity rejects a home that disagrees with canonical application scope', async () => {
  const manager = createWebsiteIdentityPathManager({ identityManager: fakeIdentityManager() });

  await assert.rejects(
    manager.inspect({ ...boundIntent, homeDirectory: '/var/lib/yunpanel/data/11111111-1111-4111-8111-111111111111' }),
    (error) => error instanceof WebsiteIdentityPathManagerError
      && error.code === 'website_identity_path_drift',
  );
});

test('legacy identity intents pass through without inventing workspace mutations', async () => {
  const identityManager = fakeIdentityManager();
  const workspace = fakeWorkspace();
  const manager = createWebsiteIdentityPathManager({
    identityManager,
    run: workspace.run,
    lstatFn: workspace.lstatFn,
  });

  const result = await manager.apply(baseIntent, { operationId: '9ae512c0-a717-4611-943c-6ce2ab0abf16' });

  assert.equal(result.satisfied, true);
  assert.equal(result.pathContract, undefined);
  assert.deepEqual(workspace.calls, []);
  assert.deepEqual(identityManager.calls[0].slice(0, 2), ['apply', baseIntent]);
});

test('path-bound compensation delegates destructive ownership decisions to durable identity receipt manager', async () => {
  const identityManager = fakeIdentityManager();
  const manager = createWebsiteIdentityPathManager({ identityManager });
  const options = { operationId: '9ae512c0-a717-4611-943c-6ce2ab0abf16', evidence: { created: true } };

  const result = await manager.compensate(boundIntent, options);

  assert.deepEqual(result, { satisfied: true, removedUser: true });
  assert.deepEqual(identityManager.calls[0], ['compensate', baseIntent, options]);
});
