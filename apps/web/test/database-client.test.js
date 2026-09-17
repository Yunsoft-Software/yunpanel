import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyDatabaseCredential,
  createDatabase,
  deleteDatabase,
  finalizeDatabaseCredentialDelete,
  getDatabases,
  getWebsiteDatabaseResources,
  inspectDatabases,
  previewDatabaseCredentialApply,
  previewDatabaseCredentialDelete,
  queueDatabaseCredentialDelete,
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

test('database API client rejects missing identities before fetch', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return ok({}); });
  assert.throws(() => getDatabases(''), /serverId is required/);
  assert.throws(() => getWebsiteDatabaseResources('', 'website-1'), /serverId is required/);
  assert.throws(() => getWebsiteDatabaseResources('server-1', ''), /websiteId is required/);
  assert.throws(() => createDatabase('server-1', ''), /database name is required/);
  assert.throws(() => deleteDatabase('server-1', ''), /database name is required/);
  assert.throws(() => rotateDatabaseCredential('server-1', '', 1), /credentialId is required/);
  assert.throws(() => rotateDatabaseCredential('server-1', 'credential-1', 0), /expectedRevision must be a positive integer/);
  assert.throws(() => applyDatabaseCredential('server-1', 'credential-1', null), /credential apply preview is required/);
  assert.throws(() => queueDatabaseCredentialDelete('server-1', 'credential-1', null), /credential delete preview is required/);
  assert.throws(() => finalizeDatabaseCredentialDelete('server-1', 'credential-1', 1, ''), /deleteJobId is required/);
  assert.equal(calls, 0);
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
