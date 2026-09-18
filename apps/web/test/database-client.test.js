import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyDatabaseCredential,
  createDatabase,
  createDatabaseBackup,
  createPhpMyAdminHandoff,
  createWebsiteDatabaseBackup,
  deleteDatabase,
  deleteWebsiteDatabase,
  finalizeWebsiteDatabaseDelete,
  finalizeDatabaseCredentialDelete,
  getDatabases,
  getDatabaseDropPreview,
  getWebsiteDatabaseDeletePreview,
  getWebsiteDatabaseResources,
  inspectDatabases,
  previewDatabaseCredentialApply,
  previewDatabaseCredentialDelete,
  previewDatabaseRestore,
  previewWebsiteDatabaseRestore,
  queueDatabaseCredentialDelete,
  restoreDatabase,
  restoreWebsiteDatabase,
  rotateDatabaseCredential,
} from '../src/api.js';
import { setSession } from '../src/session-client.js';

const ok = (data) => new Response(JSON.stringify({ data }), { status: 200 });

test('database API client uses same-origin panel routes and exact mutation confirmations', async (t) => {
  setSession({ csrfToken: 'csrf-database' });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return ok(url.endsWith('/databases') && options.method === 'GET'
      ? { engine: null, version: null, databases: null, snapshot: null }
      : { id: 'job-1', status: 'queued' });
  });

  await getDatabases('server/one');
  await getWebsiteDatabaseResources('server/one', 'website/one');
  await inspectDatabases('server/one');
  await createDatabase('server/one', 'app_main');
  await deleteDatabase('server/one', 'app_main');

  assert.deepEqual(calls.map((call) => [call.url, call.options.method]), [
    ['/api/panel/servers/server%2Fone/databases', 'GET'],
    ['/api/panel/servers/server%2Fone/websites/website%2Fone/database-resources', 'GET'],
    ['/api/panel/servers/server%2Fone/databases/inspect', 'POST'],
    ['/api/panel/servers/server%2Fone/databases', 'POST'],
    ['/api/panel/servers/server%2Fone/databases/app_main', 'DELETE'],
  ]);
  assert.deepEqual(JSON.parse(calls[3].options.body), { name: 'app_main', confirmation: 'create:app_main' });
  assert.deepEqual(JSON.parse(calls[4].options.body), { confirmation: 'delete:app_main' });
  for (const call of calls.slice(2)) assert.equal(call.options.headers['x-csrf-token'], 'csrf-database');
  setSession(null);
});


test('phpMyAdmin handoff client mints only a scoped capability request', async (t) => {
  setSession({ csrfToken: 'csrf-phpmyadmin-handoff' });
  const calls = [];
  const capability = 'A'.repeat(43);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return ok({
      capability,
      expiresAt: 50_000,
      protocol: 'yunpanel-phpmyadmin-signon-v1',
      target: {
        serverId: 'server/one',
        websiteId: 'website/one',
        databaseCredentialId: 'credential/one',
        databaseName: 'app_main',
      },
    });
  });

  const result = await createPhpMyAdminHandoff('server/one', 'website/one', 'credential/one');

  assert.equal(result.capability, capability);
  assert.deepEqual(calls.map((call) => [call.url, call.options.method]), [
    ['/api/panel/servers/server%2Fone/websites/website%2Fone/phpmyadmin-handoffs', 'POST'],
  ]);
  assert.deepEqual(JSON.parse(calls[0].options.body), { credentialId: 'credential/one' });
  assert.equal(calls[0].options.headers['x-csrf-token'], 'csrf-phpmyadmin-handoff');
  assert.doesNotMatch(calls[0].options.body, /password|capability/i);
  setSession(null);
});

test('database API client rejects missing identities before fetch', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return ok({}); });
  assert.throws(() => getDatabases(''), /serverId is required/);
  assert.throws(() => getWebsiteDatabaseResources('', 'website-1'), /serverId is required/);
  assert.throws(() => getWebsiteDatabaseResources('server-1', ''), /websiteId is required/);
  assert.throws(() => createPhpMyAdminHandoff('', 'website-1', 'credential-1'), /serverId is required/);
  assert.throws(() => createPhpMyAdminHandoff('server-1', '', 'credential-1'), /websiteId is required/);
  assert.throws(() => createPhpMyAdminHandoff('server-1', 'website-1', ''), /credentialId is required/);
  assert.throws(() => createWebsiteDatabaseBackup('', 'website-1', 'binding-1', 1), /serverId is required/);
  assert.throws(() => createWebsiteDatabaseBackup('server-1', '', 'binding-1', 1), /websiteId is required/);
  assert.throws(() => createWebsiteDatabaseBackup('server-1', 'website-1', '', 1), /bindingId is required/);
  assert.throws(() => createWebsiteDatabaseBackup('server-1', 'website-1', 'binding-1', 0), /expectedBindingRevision must be a positive integer/);
  assert.throws(() => previewWebsiteDatabaseRestore('server-1', 'website-1', 'binding-1', 1, ''), /backupId is required/);
  assert.throws(() => restoreWebsiteDatabase('server-1', 'website-1', 'binding-1', 1, null), /database restore preview is required/);
  assert.throws(() => deleteWebsiteDatabase('server-1', 'website-1', 'binding-1', 1, null), /database delete preview is required/);
  assert.throws(() => finalizeWebsiteDatabaseDelete('server-1', 'website-1', 'binding-1', 1, ''), /deleteJobId is required/);
  assert.throws(() => createDatabase('server-1', ''), /database name is required/);
  assert.throws(() => createDatabaseBackup('server-1', ''), /database name is required/);
  assert.throws(() => getDatabaseDropPreview('server-1', ''), /database name is required/);
  assert.throws(() => previewDatabaseRestore('server-1', 'app_main', ''), /backupId is required/);
  assert.throws(() => restoreDatabase('server-1', 'app_main', null), /database restore preview is required/);
  assert.throws(() => deleteDatabase('server-1', ''), /database name is required/);
  assert.throws(() => rotateDatabaseCredential('server-1', '', 1), /credentialId is required/);
  assert.throws(() => rotateDatabaseCredential('server-1', 'credential-1', 0), /expectedRevision must be a positive integer/);
  assert.throws(() => applyDatabaseCredential('server-1', 'credential-1', null), /credential apply preview is required/);
  assert.throws(() => queueDatabaseCredentialDelete('server-1', 'credential-1', null), /credential delete preview is required/);
  assert.throws(() => finalizeDatabaseCredentialDelete('server-1', 'credential-1', 1, ''), /deleteJobId is required/);
  assert.equal(calls, 0);
});

test('database backup client queues only the encoded schema with exact confirmation', async (t) => {
  setSession({ csrfToken: 'csrf-database-backup' });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return ok({ id: 'backup-job', operation: 'database.backup', status: 'queued' });
  });

  await createDatabaseBackup('server/one', 'app_main');

  assert.deepEqual(calls.map((call) => [call.url, call.options.method]), [
    ['/api/panel/servers/server%2Fone/databases/app_main/backup', 'POST'],
  ]);
  assert.deepEqual(JSON.parse(calls[0].options.body), { confirmation: 'backup:app_main' });
  assert.equal(calls[0].options.headers['x-csrf-token'], 'csrf-database-backup');
  setSession(null);
});

test('Website database backup and restore clients pin the binding revision without caller-selected schema names', async (t) => {
  setSession({ csrfToken: 'csrf-website-database-data' });
  const calls = [];
  const preview = {
    backupId: 'backup/job-one',
    previewDigest: 'c'.repeat(64),
    backupSha256: 'd'.repeat(64),
    confirmation: `restore-database:app_main:${'c'.repeat(64)}`,
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return ok(url.endsWith('/restore-preview')
      ? preview
      : url.endsWith('/backup')
        ? { scope: { databaseBindingId: 'binding/one' }, job: { id: 'backup-job', status: 'queued' } }
        : { scope: { databaseBindingId: 'binding/one' }, job: { id: 'restore-job', status: 'queued' } });
  });

  await createWebsiteDatabaseBackup('server/one', 'website/one', 'binding/one', 7);
  const currentPreview = await previewWebsiteDatabaseRestore(
    'server/one',
    'website/one',
    'binding/one',
    7,
    'backup/job-one',
  );
  await restoreWebsiteDatabase('server/one', 'website/one', 'binding/one', 7, currentPreview);

  const prefix = '/api/panel/servers/server%2Fone/websites/website%2Fone/database-bindings/binding%2Fone';
  assert.deepEqual(calls.map((call) => [call.url, call.options.method]), [
    [`${prefix}/backup`, 'POST'],
    [`${prefix}/restore-preview`, 'POST'],
    [`${prefix}/restore`, 'POST'],
  ]);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    expectedBindingRevision: 7,
    confirmation: 'backup-website-database:binding/one:7',
  });
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    backupId: 'backup/job-one',
    expectedBindingRevision: 7,
  });
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    backupId: 'backup/job-one',
    expectedBindingRevision: 7,
    expectedPreviewDigest: 'c'.repeat(64),
    expectedBackupSha256: 'd'.repeat(64),
    confirmation: `restore-database:app_main:${'c'.repeat(64)}`,
  });
  for (const call of calls) {
    assert.equal(call.options.headers['x-csrf-token'], 'csrf-website-database-data');
    assert.doesNotMatch(call.options.body, /databaseName|password|dumpPath|sql/i);
  }
  setSession(null);
});

test('Website database delete client pins preview, DROP and finalization to the binding revision', async (t) => {
  setSession({ csrfToken: 'csrf-website-database-delete' });
  const calls = [];
  const preview = {
    previewDigest: 'e'.repeat(64),
    confirmation: `delete-website-database:binding/one:7:${'e'.repeat(64)}`,
    backup: {
      backupId: 'backup/job-one',
      dumpSha256: 'f'.repeat(64),
    },
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return ok(url.endsWith('/delete-preview')
      ? preview
      : url.endsWith('/delete-finalize')
        ? { id: 'binding/one', databaseName: 'app_main', unbound: true, finalizedFromJobId: 'delete/job-one' }
        : { job: { id: 'delete/job-one', status: 'queued' } });
  });

  const current = await getWebsiteDatabaseDeletePreview('server/one', 'website/one', 'binding/one');
  await deleteWebsiteDatabase('server/one', 'website/one', 'binding/one', 7, current);
  await finalizeWebsiteDatabaseDelete('server/one', 'website/one', 'binding/one', 7, 'delete/job-one');

  const prefix = '/api/panel/servers/server%2Fone/websites/website%2Fone/database-bindings/binding%2Fone';
  assert.deepEqual(calls.map((call) => [call.url, call.options.method]), [
    [`${prefix}/delete-preview`, 'GET'],
    [`${prefix}/delete`, 'POST'],
    [`${prefix}/delete-finalize`, 'POST'],
  ]);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    expectedBindingRevision: 7,
    expectedPreviewDigest: 'e'.repeat(64),
    expectedBackupId: 'backup/job-one',
    expectedBackupSha256: 'f'.repeat(64),
    confirmation: `delete-website-database:binding/one:7:${'e'.repeat(64)}`,
  });
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    expectedBindingRevision: 7,
    deleteJobId: 'delete/job-one',
    confirmation: 'finalize-website-database-delete:binding/one:7:delete/job-one',
  });
  assert.equal(calls[1].options.headers['x-csrf-token'], 'csrf-website-database-delete');
  assert.equal(calls[2].options.headers['x-csrf-token'], 'csrf-website-database-delete');
  assert.doesNotMatch(calls.slice(1).map((call) => call.options.body).join('\n'), /databaseName|password|sql|dumpPath/i);
  setSession(null);
});

test('database drop preview client uses a read-only same-origin schema route', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return ok({ version: 1, readyToDrop: false, sideEffects: false });
  });

  await getDatabaseDropPreview('server/one', 'app_main');

  assert.deepEqual(calls.map((call) => [call.url, call.options.method, call.options.body]), [
    ['/api/panel/servers/server%2Fone/databases/app_main/drop-preview', 'GET', undefined],
  ]);
});

test('database restore client applies only the selected backend preview identity and checksum', async (t) => {
  setSession({ csrfToken: 'csrf-database-restore' });
  const calls = [];
  const preview = {
    backupId: 'backup/job-one',
    previewDigest: 'c'.repeat(64),
    backupSha256: 'd'.repeat(64),
    confirmation: `restore-database:app_main:${'c'.repeat(64)}`,
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return ok(url.endsWith('/restore-preview') ? preview : { job: { id: 'restore-job', status: 'queued' } });
  });

  const currentPreview = await previewDatabaseRestore('server/one', 'app_main', 'backup/job-one');
  await restoreDatabase('server/one', 'app_main', currentPreview);

  assert.deepEqual(calls.map((call) => [call.url, call.options.method]), [
    ['/api/panel/servers/server%2Fone/databases/app_main/restore-preview', 'POST'],
    ['/api/panel/servers/server%2Fone/databases/app_main/restore', 'POST'],
  ]);
  assert.deepEqual(JSON.parse(calls[0].options.body), { backupId: 'backup/job-one' });
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    backupId: 'backup/job-one',
    expectedPreviewDigest: 'c'.repeat(64),
    expectedBackupSha256: 'd'.repeat(64),
    confirmation: `restore-database:app_main:${'c'.repeat(64)}`,
  });
  assert.equal(calls[0].options.headers['x-csrf-token'], 'csrf-database-restore');
  assert.equal(calls[1].options.headers['x-csrf-token'], 'csrf-database-restore');
  setSession(null);
});

test('database credential client pins rotate and apply to exact revisions and preview digest', async (t) => {
  setSession({ csrfToken: 'csrf-credential' });
  const calls = [];
  const digest = 'a'.repeat(64);
  const preview = {
    expectedCredentialRevision: 4,
    expectedBindingRevision: 2,
    desiredStateSha256: digest,
    confirmation: `apply-database-credential:credential/one:${digest}`,
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return ok(url.endsWith('/apply-preview') ? preview : { id: 'safe-public-metadata' });
  });

  await rotateDatabaseCredential('server/one', 'credential/one', 3);
  const currentPreview = await previewDatabaseCredentialApply('server/one', 'credential/one');
  await applyDatabaseCredential('server/one', 'credential/one', currentPreview);

  assert.deepEqual(calls.map((call) => [call.url, call.options.method]), [
    ['/api/panel/servers/server%2Fone/database-credentials/credential%2Fone/password/rotate', 'POST'],
    ['/api/panel/servers/server%2Fone/database-credentials/credential%2Fone/apply-preview', 'GET'],
    ['/api/panel/servers/server%2Fone/database-credentials/credential%2Fone/apply', 'POST'],
  ]);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    expectedRevision: 3,
    confirmation: 'rotate-database-password:credential/one:3',
  });
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    expectedCredentialRevision: 4,
    expectedBindingRevision: 2,
    expectedDesiredStateSha256: digest,
    confirmation: `apply-database-credential:credential/one:${digest}`,
  });
  assert.equal(calls[0].options.headers['x-csrf-token'], 'csrf-credential');
  assert.equal(calls[2].options.headers['x-csrf-token'], 'csrf-credential');
  assert.doesNotMatch(calls.map((call) => call.options.body ?? '').join('\n'), /"password"\s*:/i);
  setSession(null);
});

test('database credential delete client queues exact preview and finalizes only from job evidence', async (t) => {
  setSession({ csrfToken: 'csrf-credential-delete' });
  const calls = [];
  const digest = 'b'.repeat(64);
  const preview = {
    expectedCredentialRevision: 5,
    expectedBindingRevision: 2,
    desiredStateSha256: digest,
    confirmation: `delete-database-credential:credential/one:${digest}`,
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return ok(url.endsWith('/delete-preview') ? preview : { id: 'safe-public-metadata' });
  });

  const currentPreview = await previewDatabaseCredentialDelete('server/one', 'credential/one');
  await queueDatabaseCredentialDelete('server/one', 'credential/one', currentPreview);
  await finalizeDatabaseCredentialDelete('server/one', 'credential/one', 5, 'job/one');

  assert.deepEqual(calls.map((call) => [call.url, call.options.method]), [
    ['/api/panel/servers/server%2Fone/database-credentials/credential%2Fone/delete-preview', 'GET'],
    ['/api/panel/servers/server%2Fone/database-credentials/credential%2Fone/delete', 'POST'],
    ['/api/panel/servers/server%2Fone/database-credentials/credential%2Fone', 'DELETE'],
  ]);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    expectedCredentialRevision: 5,
    expectedBindingRevision: 2,
    expectedDesiredStateSha256: digest,
    confirmation: `delete-database-credential:credential/one:${digest}`,
  });
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    expectedRevision: 5,
    deleteJobId: 'job/one',
    confirmation: 'finalize-database-credential-delete:credential/one:5:job/one',
  });
  assert.equal(calls[1].options.headers['x-csrf-token'], 'csrf-credential-delete');
  assert.equal(calls[2].options.headers['x-csrf-token'], 'csrf-credential-delete');
  assert.doesNotMatch(calls.map((call) => call.options.body ?? '').join('\n'), /"password"\s*:/i);
  setSession(null);
});
