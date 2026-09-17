import assert from 'node:assert/strict';
import test from 'node:test';
import {
  databaseBackupChoices,
  databaseDropPreviewView,
  databaseInventoryView,
  databaseRestorePreviewView,
  formatDatabaseBytes,
  validDatabaseName,
  websiteDatabaseResourcesView,
} from '../src/workspace/database-model.js';

const serverId = '12345678-1234-4234-8234-123456789012';

test('database names mirror the host/protocol safety boundary', () => {
  assert.equal(validDatabaseName('app_main'), true);
  assert.equal(validDatabaseName('Customer42'), true);
  assert.equal(validDatabaseName('mysql'), false);
  assert.equal(validDatabaseName('information_schema'), false);
  assert.equal(validDatabaseName('app-main'), false);
  assert.equal(validDatabaseName('../app'), false);
});

test('database byte formatter stays compact and deterministic', () => {
  assert.equal(formatDatabaseBytes(0), '0 B');
  assert.equal(formatDatabaseBytes(1024), '1 KB');
  assert.equal(formatDatabaseBytes(1536), '1.5 KB');
  assert.equal(formatDatabaseBytes(10 * 1024 * 1024), '10 MB');
  assert.equal(formatDatabaseBytes(-1), '—');
});

test('database inventory view sorts safe rows and computes total size without trusting malformed entries', () => {
  const ownership = {
    bindingId: '12345678-1234-4234-8234-123456789012',
    websiteId: '22345678-1234-4234-8234-123456789012',
    applicationId: '32345678-1234-4234-8234-123456789012',
    unixUser: 'yunapp-abcdef012345',
    revision: 2,
    credential: {
      id: '42345678-1234-4234-8234-123456789012',
      username: 'ydb_abcdef012345abcdef012345',
      host: 'localhost',
      revision: 3,
    },
  };
  const view = databaseInventoryView({
    engine: 'mariadb',
    version: '10.11.13-MariaDB',
    databases: [
      { name: 'zeta', sizeBytes: 2048 },
      { name: 'mysql', sizeBytes: 999 },
      { name: 'alpha', sizeBytes: 1024, ownership },
      { name: 'broken-name', sizeBytes: 1 },
    ],
    live: true,
    health: {
      available: true,
      ready: true,
      reason: null,
      connection: {
        protocol: 'socket',
        adminAccount: 'root@localhost',
        loginAccount: 'root@localhost',
        authPlugin: 'unix_socket',
        nativeSocketAuth: true,
      },
      hygiene: {
        anonymousAccountsAbsent: true,
        remoteRootAccountsAbsent: true,
        testSchemaAbsent: true,
      },
    },
    ownership: { bindingCount: 1, credentialCount: 1, missingDatabaseBindingCount: 0 },
    snapshot: { jobId: 'job-1', refreshedAt: '2026-09-10T00:00:00.000Z', raw: 'drop' },
  });
  assert.deepEqual(view.databases.map((entry) => entry.name), ['alpha', 'zeta']);
  assert.equal(view.totalBytes, 3072);
  assert.equal(view.live, true);
  assert.equal(view.health.ready, true);
  assert.deepEqual(view.health.connection, {
    adminAccount: 'root@localhost',
    authPlugin: 'unix_socket',
    nativeSocketAuth: true,
  });
  assert.equal(view.databases[0].ownership.credential.username, ownership.credential.username);
  assert.deepEqual(view.ownership, { bindingCount: 1, credentialCount: 1, missingDatabaseBindingCount: 0 });
  assert.deepEqual(view.snapshot, { jobId: 'job-1', refreshedAt: '2026-09-10T00:00:00.000Z' });
});

test('Website database resource view keeps only scoped secret-free binding and credential state', () => {
  const websiteId = '12345678-1234-4234-8234-123456789012';
  const applicationId = '22345678-1234-4234-8234-123456789012';
  const result = websiteDatabaseResourcesView({
    websiteId,
    applicationId,
    databases: [{
      binding: {
        id: '32345678-1234-4234-8234-123456789012',
        databaseName: 'app_main',
        websiteId,
        applicationId,
        unixUser: 'yunapp-abcdef012345',
        revision: 2,
      },
      credential: {
        id: '42345678-1234-4234-8234-123456789012',
        username: 'ydb_abcdef012345abcdef012345',
        host: 'localhost',
        privileges: ['SELECT', 'INSERT'],
        revision: 3,
        passwordConfigured: true,
        passwordUpdatedAt: '2026-09-17T12:00:00.000Z',
        password: 'drop-me',
      },
    }],
  });
  assert.deepEqual(result.databases[0], {
    binding: {
      id: '32345678-1234-4234-8234-123456789012',
      databaseName: 'app_main',
      unixUser: 'yunapp-abcdef012345',
      revision: 2,
    },
    credential: {
      id: '42345678-1234-4234-8234-123456789012',
      username: 'ydb_abcdef012345abcdef012345',
      privileges: ['SELECT', 'INSERT'],
      revision: 3,
      passwordUpdatedAt: '2026-09-17T12:00:00.000Z',
    },
  });
  assert.equal(JSON.stringify(result).includes('drop-me'), false);
  assert.equal(websiteDatabaseResourcesView({
    websiteId,
    applicationId,
    databases: [{
      binding: {
        id: '32345678-1234-4234-8234-123456789012',
        databaseName: 'app_main',
        websiteId: '52345678-1234-4234-8234-123456789012',
        applicationId,
        unixUser: 'yunapp-abcdef012345',
        revision: 2,
      },
      credential: null,
    }],
  }), null);
});

test('database backup choices keep only exact successful server and schema evidence', () => {
  const backupId = '52345678-1234-4234-8234-123456789012';
  const valid = {
    id: backupId,
    serverId,
    operation: 'database.backup',
    status: 'succeeded',
    resourceType: 'database',
    resourceId: 'app_main',
    result: {
      version: 1,
      backupId,
      databaseName: 'app_main',
      engine: 'mariadb',
      databaseVersion: '10.11.13-MariaDB',
      dumpSha256: 'a'.repeat(64),
      dumpBytes: 4096,
      createdAt: '2026-09-17T12:00:00.000Z',
      backedUp: true,
      sideEffects: true,
      dumpPath: '/private/ignored.sql',
    },
  };
  const choices = databaseBackupChoices([
    { ...valid, id: '62345678-1234-4234-8234-123456789012', serverId: '72345678-1234-4234-8234-123456789012' },
    { ...valid, id: '82345678-1234-4234-8234-123456789012', resourceId: 'other_db' },
    { ...valid, id: '92345678-1234-4234-8234-123456789012', status: 'failed' },
    valid,
  ], { serverId, databaseName: 'app_main' });
  assert.equal(choices.length, 1);
  assert.deepEqual(choices[0], {
    id: backupId,
    createdAt: '2026-09-17T12:00:00.000Z',
    dumpBytes: 4096,
    engine: 'mariadb',
    databaseVersion: '10.11.13-MariaDB',
    dumpSha256: 'a'.repeat(64),
  });
  assert.equal(JSON.stringify(choices).includes('/private/'), false);
});

test('Website backup choices require exact binding ownership evidence', () => {
  const backupId = '52345678-1234-4234-8234-123456789012';
  const websiteId = '22345678-1234-4234-8234-123456789012';
  const bindingId = '32345678-1234-4234-8234-123456789012';
  const valid = {
    id: backupId,
    serverId,
    operation: 'database.backup',
    status: 'succeeded',
    resourceType: 'database',
    resourceId: 'app_main',
    payload: {
      databaseName: 'app_main',
      websiteId,
      databaseBindingId: bindingId,
      expectedBindingRevision: 7,
    },
    result: {
      version: 1,
      backupId,
      databaseName: 'app_main',
      engine: 'mariadb',
      databaseVersion: '10.11.13-MariaDB',
      dumpSha256: 'a'.repeat(64),
      dumpBytes: 4096,
      createdAt: '2026-09-17T12:00:00.000Z',
      backedUp: true,
      sideEffects: true,
    },
  };
  const expected = { serverId, databaseName: 'app_main', websiteId, bindingId, bindingRevision: 7 };
  assert.deepEqual(databaseBackupChoices([valid], expected).map((entry) => entry.id), [backupId]);
  assert.deepEqual(databaseBackupChoices([{ ...valid, payload: { ...valid.payload, expectedBindingRevision: 6 } }], expected), []);
  assert.deepEqual(databaseBackupChoices([{ ...valid, payload: { databaseName: 'app_main' } }], expected), []);
  assert.deepEqual(databaseBackupChoices([valid], { ...expected, bindingId: '42345678-1234-4234-8234-123456789012' }), []);
});

test('database restore preview stays bound to the selected server schema backup and digest', () => {
  const backupId = '52345678-1234-4234-8234-123456789012';
  const previewDigest = 'b'.repeat(64);
  const input = {
    version: 1,
    operation: 'database_restore',
    serverId,
    databaseName: 'app_main',
    backupId,
    backupSha256: 'a'.repeat(64),
    backupBytes: 4096,
    engine: 'mariadb',
    databaseVersion: '10.11.13-MariaDB',
    previewDigest,
    confirmation: `restore-database:app_main:${previewDigest}`,
    sideEffects: false,
    dumpPath: '/private/ignored.sql',
  };
  const view = databaseRestorePreviewView(input, { serverId, databaseName: 'app_main', backupId });
  assert.equal(view.previewDigest, previewDigest);
  assert.equal(JSON.stringify(view).includes('/private/'), false);
  assert.equal(databaseRestorePreviewView({ ...input, databaseName: 'other_db' }, { serverId, databaseName: 'app_main', backupId }), null);
  assert.equal(databaseRestorePreviewView({ ...input, confirmation: 'restore-anything' }, { serverId, databaseName: 'app_main', backupId }), null);
});

test('Website restore preview requires exact route and ownership scope evidence', () => {
  const backupId = '52345678-1234-4234-8234-123456789012';
  const websiteId = '22345678-1234-4234-8234-123456789012';
  const applicationId = '32345678-1234-4234-8234-123456789012';
  const bindingId = '42345678-1234-4234-8234-123456789012';
  const previewDigest = 'b'.repeat(64);
  const input = {
    version: 1,
    operation: 'database_restore',
    serverId,
    databaseName: 'app_main',
    backupId,
    backupSha256: 'a'.repeat(64),
    backupBytes: 4096,
    engine: 'mariadb',
    databaseVersion: '10.11.13-MariaDB',
    websiteId,
    databaseBindingId: bindingId,
    expectedBindingRevision: 7,
    previewDigest,
    confirmation: `restore-database:app_main:${previewDigest}`,
    sideEffects: false,
    scope: {
      serverId,
      websiteId,
      applicationId,
      databaseBindingId: bindingId,
      bindingRevision: 7,
      databaseName: 'app_main',
    },
  };
  const expected = {
    serverId,
    databaseName: 'app_main',
    backupId,
    websiteId,
    applicationId,
    bindingId,
    bindingRevision: 7,
  };
  const view = databaseRestorePreviewView(input, expected);
  assert.equal(view.databaseBindingId, bindingId);
  assert.equal(view.bindingRevision, 7);
  assert.equal(databaseRestorePreviewView(
    { ...input, expectedBindingRevision: 6 },
    expected,
  ), null);
  assert.equal(databaseRestorePreviewView(
    { ...input, scope: { ...input.scope, websiteId: '62345678-1234-4234-8234-123456789012' } },
    expected,
  ), null);
});

test('database drop preview keeps exact scoped impact and rejects inconsistent blockers', () => {
  const bindingId = '42345678-1234-4234-8234-123456789012';
  const websiteId = '22345678-1234-4234-8234-123456789012';
  const applicationId = '32345678-1234-4234-8234-123456789012';
  const input = {
    version: 1,
    serverId,
    databaseName: 'app_main',
    exists: true,
    binding: { id: bindingId, websiteId, applicationId, unixUser: 'yunapp-abcdef012345', revision: 2 },
    credential: {
      id: '52345678-1234-4234-8234-123456789012',
      username: 'ydb_abcdef012345abcdef012345',
      revision: 3,
      ciphertext: 'private',
    },
    latestBackup: {
      backupId: '62345678-1234-4234-8234-123456789012',
      engine: 'mariadb',
      databaseVersion: '10.11.13-MariaDB',
      dumpSha256: 'a'.repeat(64),
      dumpBytes: 4096,
      createdAt: '2026-09-17T12:00:00.000Z',
      dumpPath: '/private/ignored.sql',
    },
    activeJobs: [],
    blockers: ['database_credential_exists', 'database_binding_exists', 'database_delete_safety_chain_pending'],
    readyToDrop: false,
    previewDigest: 'b'.repeat(64),
    sideEffects: false,
  };
  const expected = { serverId, databaseName: 'app_main', bindingId, websiteId, applicationId };
  const view = databaseDropPreviewView(input, expected);
  assert.equal(view.binding.id, bindingId);
  assert.equal(view.latestBackup.backupId, input.latestBackup.backupId);
  assert.equal(JSON.stringify(view).includes('private'), false);
  assert.equal(databaseDropPreviewView({ ...input, binding: { ...input.binding, websiteId: '72345678-1234-4234-8234-123456789012' } }, expected), null);
  assert.equal(databaseDropPreviewView({ ...input, blockers: ['database_binding_exists', 'database_delete_safety_chain_pending'] }, expected), null);
});
