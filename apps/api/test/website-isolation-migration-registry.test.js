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
