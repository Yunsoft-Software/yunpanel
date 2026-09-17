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
const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';

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

function fakeIdentityManager({ created = true, inspection = baseIdentity() } = {}) {
  const calls = [];
  return {
    calls,
    inspect: async (intent) => {
      calls.push(['inspect', intent]);
      return inspection;
    },
    apply: async (intent, options) => {
      calls.push(['apply', intent, options]);
      return baseIdentity({ created, receiptVersion: created ? 1 : null });
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
  const removed = [];
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
  const rmdirFn = async (directory) => {
    const entry = entries.get(directory);
    if (!entry) {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
    if (entry.notEmpty) {
      const error = new Error('not empty');
      error.code = 'ENOTEMPTY';
      throw error;
    }
    entries.delete(directory);
    removed.push(directory);
  };
  return { entries, calls, removed, run, lstatFn, rmdirFn };
}

function fakeReceiptStore() {
  const files = new Map();
  return {
    files,
    mkdirFn: async () => {},
    readFileFn: async (target) => {
      if (!files.has(target)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(target);
    },
    writeFileFn: async (target, content) => { files.set(target, content); },
    renameFn: async (source, target) => {
      files.set(target, files.get(source));
      files.delete(source);
    },
  };
}

test('path-bound identity apply prepares and verifies only site-owned tmp/log workspace', async () => {
  const identityManager = fakeIdentityManager();
  const workspace = fakeWorkspace();
  const receipts = fakeReceiptStore();
  const manager = createWebsiteIdentityPathManager({
    identityManager,
    run: workspace.run,
    lstatFn: workspace.lstatFn,
    rmdirFn: workspace.rmdirFn,
    ...receipts,
  });

  const result = await manager.apply(boundIntent, { operationId });

  assert.equal(result.satisfied, true);
  assert.equal(result.created, true);
  assert.equal(result.receiptVersion, 1);
  assert.equal(result.workspaceReceiptVersion, 1);
  assert.equal(result.createdWorkspaceDirectories, 2);
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
  assert.deepEqual(result.missingWorkspaces, ['temporary', 'logs']);
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

  const result = await manager.apply(baseIntent, { operationId });

  assert.equal(result.satisfied, true);
  assert.equal(result.pathContract, undefined);
  assert.deepEqual(workspace.calls, []);
  assert.deepEqual(identityManager.calls[0].slice(0, 2), ['apply', baseIntent]);
});

test('path-bound compensation delegates destructive ownership decisions to durable identity receipt manager', async () => {
  const identityManager = fakeIdentityManager();
  const manager = createWebsiteIdentityPathManager({ identityManager, ...fakeReceiptStore() });
  const options = { operationId, evidence: { created: true } };

  const result = await manager.compensate(boundIntent, options);

  assert.deepEqual(result, { satisfied: true, removedUser: true });
  assert.deepEqual(identityManager.calls[0], ['compensate', baseIntent, options]);
});

test('path-bound compensation removes only operation-created empty workspace directories', async () => {
  const identityManager = fakeIdentityManager({ created: false });
  const workspace = fakeWorkspace();
  const receipts = fakeReceiptStore();
  const manager = createWebsiteIdentityPathManager({
    identityManager,
    run: workspace.run,
    lstatFn: workspace.lstatFn,
    rmdirFn: workspace.rmdirFn,
    ...receipts,
  });

  const applied = await manager.apply(boundIntent, { operationId });
  assert.equal(applied.created, false);
  assert.equal(applied.createdWorkspaceDirectories, 2);

  const compensated = await manager.compensate(boundIntent, { operationId, evidence: applied });
  assert.equal(compensated.satisfied, true);
  assert.equal(compensated.workspaceCompensated, true);
  assert.equal(compensated.removedWorkspaceDirectories, 2);
  assert.deepEqual(workspace.removed, [
    `${baseIntent.homeDirectory}/logs`,
    `${baseIntent.homeDirectory}/tmp`,
  ]);
  assert.equal(identityManager.calls.at(-1)[0], 'compensate');

  const inspected = await manager.inspectCompensation(boundIntent, { operationId, evidence: applied });
  assert.equal(inspected.satisfied, true);
  assert.equal(inspected.removedWorkspaceDirectories, 2);
});

test('path-bound compensation preserves pre-existing workspace directories', async () => {
  const identityManager = fakeIdentityManager({ created: false });
  const workspace = fakeWorkspace();
  const receipts = fakeReceiptStore();
  workspace.entries.set(`${baseIntent.homeDirectory}/tmp`, { uid: 1201, gid: 1201, mode: 0o700 });
  workspace.entries.set(`${baseIntent.homeDirectory}/logs`, { uid: 1201, gid: 1201, mode: 0o750 });
  const manager = createWebsiteIdentityPathManager({
    identityManager,
    run: workspace.run,
    lstatFn: workspace.lstatFn,
    rmdirFn: workspace.rmdirFn,
    ...receipts,
  });

  const applied = await manager.apply(boundIntent, { operationId });
  assert.equal(applied.createdWorkspaceDirectories, 0);
  const compensated = await manager.compensate(boundIntent, { operationId, evidence: applied });

  assert.equal(compensated.removedWorkspaceDirectories, 0);
  assert.deepEqual(workspace.removed, []);
  assert.equal(workspace.entries.size, 2);
});

test('path-bound compensation refuses recursive removal when operation-owned workspace contains data', async () => {
  const identityManager = fakeIdentityManager({ created: false });
  const workspace = fakeWorkspace();
  const receipts = fakeReceiptStore();
  const manager = createWebsiteIdentityPathManager({
    identityManager,
    run: workspace.run,
    lstatFn: workspace.lstatFn,
    rmdirFn: workspace.rmdirFn,
    ...receipts,
  });
  const applied = await manager.apply(boundIntent, { operationId });
  workspace.entries.get(`${baseIntent.homeDirectory}/logs`).notEmpty = true;

  await assert.rejects(
    manager.compensate(boundIntent, { operationId, evidence: applied }),
    (error) => error instanceof WebsiteIdentityPathManagerError
      && error.code === 'website_identity_workspace_compensation_not_empty',
  );
  assert.equal(identityManager.calls.some(([name]) => name === 'compensate'), false);
  assert.equal(workspace.entries.has(`${baseIntent.homeDirectory}/logs`), true);
});

test('path-bound apply fails closed after an uncertain create without an ownership checkpoint', async () => {
  const identityManager = fakeIdentityManager({ created: false });
  const workspace = fakeWorkspace();
  const receipts = fakeReceiptStore();
  const temporaryDirectory = `${baseIntent.homeDirectory}/tmp`;
  workspace.entries.set(temporaryDirectory, { uid: 1201, gid: 1201, mode: 0o700 });
  receipts.files.set(
    `/var/lib/yunpanel/staging/website-identity-paths/${operationId}.json`,
    `${JSON.stringify({
      version: 1,
      operationId,
      websiteId,
      applicationId,
      user: baseIntent.user,
      homeDirectory: baseIntent.homeDirectory,
      uid: 1201,
      gid: 1201,
      state: 'active',
      targets: [{ name: 'temporary', directory: temporaryDirectory, mode: 0o700, state: 'planned' }],
    })}\n`,
  );
  const manager = createWebsiteIdentityPathManager({
    identityManager,
    run: workspace.run,
    lstatFn: workspace.lstatFn,
    rmdirFn: workspace.rmdirFn,
    ...receipts,
  });

  await assert.rejects(
    manager.apply(boundIntent, { operationId }),
    (error) => error instanceof WebsiteIdentityPathManagerError
      && error.code === 'website_identity_workspace_ownership_unknown',
  );
  assert.deepEqual(workspace.calls, []);
});

test('path-bound apply rejects expanded ownership receipts before host mutation', async () => {
  const identityManager = fakeIdentityManager({ created: false });
  const workspace = fakeWorkspace();
  const receipts = fakeReceiptStore();
  receipts.files.set(
    `/var/lib/yunpanel/staging/website-identity-paths/${operationId}.json`,
    `${JSON.stringify({
      version: 1,
      operationId,
      websiteId,
      applicationId,
      user: baseIntent.user,
      homeDirectory: baseIntent.homeDirectory,
      uid: 1201,
      gid: 1201,
      state: 'active',
      targets: [],
      recursive: true,
    })}\n`,
  );
  const manager = createWebsiteIdentityPathManager({
    identityManager,
    run: workspace.run,
    lstatFn: workspace.lstatFn,
    rmdirFn: workspace.rmdirFn,
    ...receipts,
  });

  await assert.rejects(
    manager.apply(boundIntent, { operationId }),
    (error) => error instanceof WebsiteIdentityPathManagerError
      && error.code === 'website_identity_path_receipt_invalid',
  );
  assert.deepEqual(workspace.calls, []);
});

test('workspace-only migration creates and compensates scoped directories without mutating Unix identity', async () => {
  const identityManager = fakeIdentityManager({ created: false });
  const workspace = fakeWorkspace();
  const receipts = fakeReceiptStore();
  const manager = createWebsiteIdentityPathManager({
    identityManager,
    run: workspace.run,
    lstatFn: workspace.lstatFn,
    rmdirFn: workspace.rmdirFn,
    ...receipts,
  });

  const before = await manager.inspectWorkspace(boundIntent);
  assert.equal(before.satisfied, false);
  assert.equal(before.missingWorkspace, 'temporary');

  const applied = await manager.applyWorkspace(boundIntent, { operationId });
  assert.equal(applied.satisfied, true);
  assert.equal(applied.createdWorkspaceDirectories, 2);
  assert.equal(identityManager.calls.some(([name]) => name === 'apply'), false);

  const compensated = await manager.compensateWorkspace(boundIntent, { operationId });
  assert.equal(compensated.satisfied, true);
  assert.equal(compensated.removedWorkspaceDirectories, 2);
  assert.equal(identityManager.calls.some(([name]) => name === 'compensate'), false);
});

test('workspace-only migration requires an already-satisfied canonical Unix identity', async () => {
  const identityManager = fakeIdentityManager({
    created: false,
    inspection: { satisfied: false, reason: 'website_identity_user_missing' },
  });
  const workspace = fakeWorkspace();
  const manager = createWebsiteIdentityPathManager({
    identityManager,
    run: workspace.run,
    lstatFn: workspace.lstatFn,
    rmdirFn: workspace.rmdirFn,
    ...fakeReceiptStore(),
  });

  await assert.rejects(
    manager.applyWorkspace(boundIntent, { operationId }),
    (error) => error instanceof WebsiteIdentityPathManagerError
      && error.code === 'website_identity_workspace_identity_required',
  );
  assert.deepEqual(workspace.calls, []);
});
