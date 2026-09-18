import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createWebsiteIsolationMigrationRegistry,
  websiteIsolationMigrationPublicView,
  WebsiteIsolationMigrationRegistryError,
} from '../src/website-isolation-migration-registry.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const sourceOperationId = '4d7d1c87-c088-4c1d-bb44-7f370d315672';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const applicationUser = 'yunapp-4dc352e64a14';
const previewDigest = 'a'.repeat(64);
const homeDirectory = `/var/lib/yunpanel/data/${applicationId}`;

function audit() {
  return {
    applicable: true,
    migrationRequired: true,
    websiteId,
    applicationId,
    websiteRevision: 3,
    expected: { unixUser: applicationUser, homeDirectory },
    migration: {
      applyAvailable: true,
      previewDigest,
      changes: [{
        action: 'create_workspace_directories',
        applyState: 'requires_explicit_apply',
        desired: { directories: [
          { name: 'temporary', directory: `${homeDirectory}/tmp`, mode: '0700' },
          { name: 'logs', directory: `${homeDirectory}/logs`, mode: '0750' },
        ] },
      }],
    },
  };
}

function identityAudit() {
  const desired = {
    user: applicationUser,
    homeDirectory,
    shellPolicy: 'nologin',
    privateGroup: true,
    groupMemberCount: 0,
    homeMode: '0750',
  };
  return {
    applicable: true,
    migrationRequired: true,
    websiteId,
    applicationId,
    websiteRevision: 3,
    expected: { unixUser: applicationUser, homeDirectory },
    migration: {
      applyAvailable: true,
      previewDigest,
      changes: [{
        action: 'create_canonical_unix_identity',
        applyState: 'requires_explicit_apply',
        current: {
          identityMigrationPreview: {
            version: 1,
            satisfied: false,
            safeCreateCandidate: true,
            current: { account: null, group: null, home: null },
            desired,
            differences: [
              'website_identity_user_missing',
              'website_identity_group_missing',
              'website_identity_home_missing',
            ],
          },
        },
        desired: { identity: desired },
      }],
    },
  };
}

function sftpAudit() {
  const desired = {
    websiteId,
    applicationId,
    unixUser: applicationUser,
    sourceDirectory: `${homeDirectory}`,
    chrootRoot: '/var/lib/yunpanel/sftp-chroots',
    chrootDirectory: `/var/lib/yunpanel/sftp-chroots/${applicationId}`,
    mountDirectory: `/var/lib/yunpanel/sftp-chroots/${applicationId}/site`,
    sshdConfigPath: `/etc/ssh/sshd_config.d/90-yunpanel-sftp-${applicationUser}.conf`,
    unitName: 'yunpanel-test.mount',
    sshdSha256: 'b'.repeat(64),
    mountSha256: 'c'.repeat(64),
    directoryMode: '0755',
    directoryUid: 0,
    directoryGid: 0,
  };
  return {
    applicable: true,
    migrationRequired: true,
    websiteId,
    applicationId,
    websiteRevision: 3,
    expected: { unixUser: applicationUser, homeDirectory },
    migration: {
      applyAvailable: true,
      previewDigest,
      changes: [{
        action: 'create_sftp_isolation',
        applyState: 'requires_explicit_apply',
        current: {
          sftpMigrationPreview: {
            version: 1,
            satisfied: false,
            safeCreateCandidate: true,
            current: {},
            desired,
            differences: ['sftp_receipt_missing'],
          },
        },
        desired: { sftp: desired },
      }],
    },
  };
}

function phpAudit() {
  const identity = createApplicationIdentity(applicationId);
  const desired = {
    websiteId,
    applicationId,
    unixUser: applicationUser,
    documentRoot: `${identity.paths.runtime.currentRelease}/public`,
    runtimeUmask: '0027',
  };
  return {
    applicable: true,
    migrationRequired: true,
    websiteId,
    applicationId,
    websiteRevision: 3,
    expected: { unixUser: applicationUser, homeDirectory },
    migration: {
      applyAvailable: true,
      previewDigest,
      changes: [{
        action: 'create_php_fpm_pool',
        applyState: 'requires_explicit_apply',
        current: {
          operationId: sourceOperationId,
          phpRuntimeMigrationPreview: {
            version: 1,
            adapter: 'php-runtime',
            satisfied: false,
            safeCreateCandidate: true,
            current: {},
            desired,
            differences: ['php_fpm_pool_missing'],
          },
        },
        desired: { phpRuntime: desired },
      }],
    },
  };
}

function registry() {
  return createWebsiteIsolationMigrationRegistry({
    now: () => Date.parse('2026-09-17T12:00:00.000Z'),
    idFactory: () => operationId,
  });
}

test('isolation migration registry journals exact workspace intent and lifecycle evidence', async () => {
  const store = registry();
  await store.init();
  const created = await store.create(audit());
  assert.equal(created.status, 'pending');
  assert.equal(created.intent.targets.length, 2);
  assert.equal(Object.hasOwn(websiteIsolationMigrationPublicView(created), 'intent'), false);

  await store.markApplying(operationId);
  const succeeded = await store.succeed(operationId, {
    satisfied: true,
    workspaceReceiptVersion: 1,
    createdWorkspaceDirectories: 2,
  });
  assert.equal(succeeded.status, 'succeeded');
  assert.equal(succeeded.result.createdWorkspaceDirectories, 2);

  await store.markCompensating(operationId);
  const compensated = await store.compensate(operationId, {
    satisfied: true,
    removedWorkspaceDirectories: 2,
  });
  assert.equal(compensated.status, 'compensated');
  assert.equal(compensated.compensation.removedWorkspaceDirectories, 2);
  assert.deepEqual(await store.listInterrupted(), []);
});

test('isolation migration registry rejects expanded or non-applicable previews', async () => {
  const store = registry();
  await store.init();
  const expanded = audit();
  expanded.migration.changes[0].desired.directories[0].recursive = true;

  await assert.rejects(
    store.create(expanded),
    (error) => error instanceof WebsiteIsolationMigrationRegistryError
      && error.code === 'website_isolation_migration_state_invalid',
  );
  await assert.rejects(
    store.create({ ...audit(), migration: { ...audit().migration, applyAvailable: false } }),
    (error) => error instanceof WebsiteIsolationMigrationRegistryError
      && error.code === 'website_isolation_migration_preview_invalid',
  );
});

test('isolation migration registry rejects non-canonical root mutation targets', async () => {
  const store = registry();
  await store.init();
  const tampered = audit();
  tampered.migration.changes[0].desired.directories[0].directory = '/etc/yunpanel';

  await assert.rejects(
    store.create(tampered),
    (error) => error instanceof WebsiteIsolationMigrationRegistryError
      && error.code === 'website_isolation_migration_state_invalid',
  );
});

test('isolation migration registry durably restores interrupted state with private permissions', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-isolation-migration-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'registry.json');
  const first = createWebsiteIsolationMigrationRegistry({
    filePath,
    now: () => Date.parse('2026-09-17T12:00:00.000Z'),
    idFactory: () => operationId,
  });
  await first.init();
  await first.create(audit());
  await first.markApplying(operationId);

  const restored = createWebsiteIsolationMigrationRegistry({ filePath });
  await restored.init();
  assert.equal((await restored.get(operationId)).status, 'applying');
  assert.deepEqual((await restored.listInterrupted()).map((entry) => entry.id), [operationId]);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).version, 1);
});


test('isolation migration registry journals identity-only receipt and data-preserving rollback evidence', async () => {
  const store = registry();
  await store.init();

  const created = await store.create(identityAudit());
  assert.equal(created.status, 'pending');
  assert.deepEqual(created.intent.targets, []);

  await store.markApplying(operationId);
  const succeeded = await store.succeed(operationId, {
    satisfied: true,
    identityReceiptVersion: 1,
    createdUnixIdentity: true,
  });
  assert.deepEqual(succeeded.result, {
    satisfied: true,
    identityReceiptVersion: 1,
    createdUnixIdentity: true,
  });

  await store.markCompensating(operationId);
  const compensated = await store.compensate(operationId, {
    satisfied: true,
    removedUser: true,
    removedGroup: true,
    removedHome: false,
    preservedHomeData: true,
  });
  assert.deepEqual(compensated.compensation, {
    satisfied: true,
    removedUser: true,
    removedGroup: true,
    removedHome: false,
    preservedHomeData: true,
  });
});

test('isolation migration registry rejects identity journaling unless preview proves all-missing safe-create state', async () => {
  const store = registry();
  await store.init();
  const unsafe = identityAudit();
  unsafe.migration.changes[0].current.identityMigrationPreview.safeCreateCandidate = false;

  await assert.rejects(
    store.create(unsafe),
    (error) => error instanceof WebsiteIsolationMigrationRegistryError
      && error.code === 'website_isolation_migration_preview_invalid',
  );
});


test('isolation migration registry journals typed SFTP receipt and key evidence', async () => {
  const store = registry();
  await store.init();

  const created = await store.create(sftpAudit());
  assert.equal(created.intent.adapter, 'sftp');
  assert.deepEqual(created.intent.targets, []);
  assert.equal(websiteIsolationMigrationPublicView(created).adapter, 'sftp');

  await store.markApplying(operationId);
  const succeeded = await store.succeed(operationId, {
    satisfied: true,
    sftpReceiptVersion: 1,
    activatedSftpIsolation: true,
    authorizedKeyCount: 2,
    authorizedKeysSha256: 'd'.repeat(64),
  });
  assert.deepEqual(succeeded.result, {
    satisfied: true,
    sftpReceiptVersion: 1,
    activatedSftpIsolation: true,
    authorizedKeyCount: 2,
    authorizedKeysSha256: 'd'.repeat(64),
  });

  await store.markCompensating(operationId);
  const compensated = await store.compensate(operationId, {
    satisfied: true,
    removedSftpIsolation: true,
  });
  assert.deepEqual(compensated.compensation, {
    satisfied: true,
    removedSftpIsolation: true,
  });
});

test('isolation migration registry rejects SFTP journaling when safe-create evidence is lost', async () => {
  const store = registry();
  await store.init();
  const unsafe = sftpAudit();
  unsafe.migration.changes[0].current.sftpMigrationPreview.safeCreateCandidate = false;

  await assert.rejects(
    store.create(unsafe),
    (error) => error instanceof WebsiteIsolationMigrationRegistryError
      && error.code === 'website_isolation_migration_preview_invalid',
  );
});


test('isolation migration registry journals typed PHP pool ownership and rollback evidence', async () => {
  const store = registry();
  await store.init();

  const created = await store.create(phpAudit());
  assert.equal(created.intent.adapter, 'php');
  assert.equal(created.intent.sourceOperationId, sourceOperationId);
  assert.deepEqual(created.intent.targets, []);

  await store.markApplying(operationId);
  const succeeded = await store.succeed(operationId, {
    satisfied: true,
    phpFpmReceiptVersion: 1,
    createdPhpFpmPool: true,
  });
  assert.deepEqual(succeeded.result, {
    satisfied: true,
    phpFpmReceiptVersion: 1,
    createdPhpFpmPool: true,
  });

  await store.markCompensating(operationId);
  const compensated = await store.compensate(operationId, {
    satisfied: true,
    restoredPrevious: false,
    preservedExisting: false,
  });
  assert.deepEqual(compensated.compensation, {
    satisfied: true,
    restoredPrevious: false,
    preservedExisting: false,
  });
});

test('isolation migration registry rejects PHP pool journaling when safe-create evidence is lost', async () => {
  const store = registry();
  await store.init();
  const unsafe = phpAudit();
  unsafe.migration.changes[0].current.phpRuntimeMigrationPreview.safeCreateCandidate = false;

  await assert.rejects(
    store.create(unsafe),
    (error) => error instanceof WebsiteIsolationMigrationRegistryError
      && error.code === 'website_isolation_migration_preview_invalid',
  );
});
