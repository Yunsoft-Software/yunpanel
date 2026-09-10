import assert from 'node:assert/strict';
import test from 'node:test';
import { planLocalMigrationRestoreMetadata } from '../src/local-migration-restore-metadata-plan.js';

const backupDirectory = '/var/backups/yunpanel/migration-2026-09-10T15-00-00-000Z';
const sha256 = 'a'.repeat(64);
const targetSpecs = [
  ['/etc/yunpanel', 'directory', true, 'restore_replace'],
  ['/var/lib/yunpanel', 'directory', true, 'restore_replace'],
  ['/etc/passwd', 'file', true, 'identity_reference'],
  ['/etc/group', 'file', true, 'identity_reference'],
  ['/etc/nginx', 'directory', true, 'restore_replace'],
  ['/etc/letsencrypt', 'directory', false, 'preserve_current'],
  ['/etc/systemd/system/yunpanel-api.service', 'file', true, 'restore_replace'],
  ['/etc/systemd/system/yunpanel-web.service', 'file', false, 'not_present'],
  ['/etc/systemd/system/yun-agent.service', 'file', false, 'preserve_current'],
];

function member(name, type, root, overrides = {}) {
  return {
    name,
    type,
    root,
    resolvedLinkTarget: type === 'l' || type === 'h' ? overrides.resolvedLinkTarget : null,
    uid: 0,
    gid: 0,
    mode: type === 'd' ? 0o750 : type === 'l' ? 0o777 : 0o640,
    metadataMarker: null,
    ...overrides,
  };
}

function members() {
  return [
    member('etc/yunpanel', 'd', '/etc/yunpanel'),
    member('etc/yunpanel/api.env', '-', '/etc/yunpanel'),
    member('var/lib/yunpanel', 'd', '/var/lib/yunpanel', { mode: 0o700 }),
    member('var/lib/yunpanel/data', 'd', '/var/lib/yunpanel', { uid: 101, gid: 101 }),
    member('var/lib/yunpanel/data/value', '-', '/var/lib/yunpanel', { uid: 101, gid: 101 }),
    member('etc/passwd', '-', '/etc/passwd', { mode: 0o644 }),
    member('etc/group', '-', '/etc/group', { mode: 0o644 }),
    member('etc/nginx', 'd', '/etc/nginx', { mode: 0o755 }),
    member('etc/nginx/sites-enabled', 'd', '/etc/nginx', { mode: 0o755 }),
    member('etc/nginx/sites-enabled/app', 'l', '/etc/nginx', { resolvedLinkTarget: 'etc/nginx/sites-available/app' }),
    member('etc/systemd/system/yunpanel-api.service', '-', '/etc/systemd/system/yunpanel-api.service', { mode: 0o644 }),
  ];
}

function targets(overrides = {}) {
  return targetSpecs.map(([path, snapshotType, snapshotPresent, action]) => ({
    path,
    snapshotType,
    snapshotPresent,
    action: overrides[path]?.action ?? action,
    current: { present: overrides[path]?.currentPresent ?? (action !== 'not_present') },
  }));
}

function identityComparison(overrides = {}) {
  return {
    destructive: false,
    backupDirectory,
    sha256,
    snapshotUsers: 2,
    currentUsers: 2,
    counts: { match: 2, drift: 0, missingCurrent: 0, addedCurrent: 0 },
    identities: [
      { name: 'yunapp-aaaaaaaaaaaa', status: 'match', changedFields: [] },
      { name: 'yunapp-bbbbbbbbbbbb', status: 'match', changedFields: [] },
    ],
    ...overrides,
  };
}

function preview({ memberList = members(), targetList = targets(), identity = identityComparison() } = {}) {
  const extendedMetadata = memberList.filter((entry) => entry.metadataMarker !== null).length;
  return {
    destructive: false,
    backupDirectory,
    archivePath: `${backupDirectory}/state.tar`,
    manifestPath: `${backupDirectory}/manifest.json`,
    sha256,
    targets: targetList,
    archiveInspection: {
      destructive: false,
      linksSafe: true,
      ownershipMetadata: true,
      extendedMetadataValidated: false,
      backupDirectory,
      sha256,
      counts: {
        total: memberList.length,
        files: memberList.filter((entry) => entry.type === '-').length,
        directories: memberList.filter((entry) => entry.type === 'd').length,
        symlinks: memberList.filter((entry) => entry.type === 'l').length,
        hardlinks: memberList.filter((entry) => entry.type === 'h').length,
        extendedMetadata,
      },
      members: memberList,
    },
    identityComparison: identity,
  };
}

test('metadata plan summarizes fixed restore roots without enabling live apply', async () => {
  const result = await planLocalMigrationRestoreMetadata({
    backupDirectory,
    previewRestore: async () => preview(),
  });

  assert.equal(result.destructive, false);
  assert.equal(result.liveMutation, false);
  assert.equal(result.liveApplyEnabled, false);
  assert.equal(result.ownershipMetadata, true);
  assert.equal(result.extendedMetadataValidated, false);
  assert.deepEqual(result.blocks, []);
  assert.deepEqual(result.counts, {
    members: 11,
    restoreTargets: 4,
    identityReferences: 2,
    preservedTargets: 3,
    privilegedModeMembers: 0,
    extendedMetadataMembers: 0,
    identityDrift: 0,
    identityMissingCurrent: 0,
    identityAddedCurrent: 0,
  });

  const appState = result.targets.find((entry) => entry.path === '/var/lib/yunpanel');
  assert.deepEqual(appState.rootMetadata, { uid: 0, gid: 0, mode: 0o700, metadataMarker: null });
  assert.equal(appState.members, 3);
  assert.equal(appState.ownershipPairs, 2);

  const passwd = result.targets.find((entry) => entry.path === '/etc/passwd');
  assert.equal(passwd.action, 'identity_reference');
  assert.equal(passwd.members, 1);
});

test('metadata plan blocks identity drift and top-level type mismatch', async () => {
  const identity = identityComparison({
    currentUsers: 1,
    counts: { match: 0, drift: 1, missingCurrent: 1, addedCurrent: 0 },
    identities: [
      { name: 'yunapp-aaaaaaaaaaaa', status: 'drift', changedFields: ['uid'] },
      { name: 'yunapp-bbbbbbbbbbbb', status: 'missing_current', changedFields: [] },
    ],
  });
  const result = await planLocalMigrationRestoreMetadata({
    backupDirectory,
    previewRestore: async () => preview({
      targetList: targets({ '/etc/nginx': { action: 'restore_type_mismatch' } }),
      identity,
    }),
  });

  assert.deepEqual(result.blocks, ['unix_identity_drift', 'restore_target_type_mismatch']);
  assert.equal(result.counts.identityDrift, 1);
  assert.equal(result.counts.identityMissingCurrent, 1);
});

test('privileged mode bits and unvalidated extended metadata are explicit blockers', async () => {
  const memberList = members().map((entry) => {
    if (entry.name === 'etc/yunpanel/api.env') return { ...entry, mode: 0o4640 };
    if (entry.name === 'var/lib/yunpanel/data/value') return { ...entry, metadataMarker: '*' };
    return entry;
  });
  const result = await planLocalMigrationRestoreMetadata({
    backupDirectory,
    previewRestore: async () => preview({ memberList }),
  });

  assert.deepEqual(result.blocks, ['privileged_mode_requires_policy', 'extended_metadata_unvalidated']);
  assert.equal(result.counts.privilegedModeMembers, 1);
  assert.equal(result.counts.extendedMetadataMembers, 1);
  assert.equal(result.targets.find((entry) => entry.path === '/etc/yunpanel').privilegedModeMembers, 1);
  assert.equal(result.targets.find((entry) => entry.path === '/var/lib/yunpanel').extendedMetadataMembers, 1);
});

test('metadata plan rejects missing fixed targets and archive members for absent roots', async () => {
  await assert.rejects(
    planLocalMigrationRestoreMetadata({
      backupDirectory,
      previewRestore: async () => preview({ targetList: targets().slice(1) }),
    }),
    { code: 'migration_restore_metadata_targets_invalid' },
  );

  await assert.rejects(
    planLocalMigrationRestoreMetadata({
      backupDirectory,
      previewRestore: async () => preview({
        memberList: [...members(), member('etc/letsencrypt', 'd', '/etc/letsencrypt')],
      }),
    }),
    { code: 'migration_restore_metadata_root_unexpected' },
  );
});

test('metadata plan rejects incomplete preview evidence without leaking nested errors', async () => {
  await assert.rejects(
    planLocalMigrationRestoreMetadata({
      backupDirectory,
      previewRestore: async () => ({ ...preview(), archiveInspection: { linksSafe: true } }),
    }),
    { code: 'migration_restore_metadata_preview_invalid' },
  );

  await assert.rejects(
    planLocalMigrationRestoreMetadata({
      backupDirectory,
      previewRestore: async () => { throw new Error('SECRET=/root/private/token'); },
    }),
    (error) => {
      assert.equal(error.code, 'migration_restore_metadata_preview_failed');
      assert.doesNotMatch(error.message, /SECRET|token|\/root\/private/i);
      return true;
    },
  );
});
