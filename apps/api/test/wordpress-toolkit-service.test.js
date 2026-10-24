import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createJobRegistry } from '../src/job-registry.js';
import { executeSiteFileOperation } from '../src/site-file-worker.js';
import { createOperationSecretStore } from '../src/operation-secret-store.js';
import { createWordPressToolkitService, normalizeWordPressActionOptions } from '../src/wordpress-toolkit-service.js';
import { managedFilesystemDependencies } from './fixtures/managed-filesystem.js';

const websiteId = '11111111-1111-4111-8111-111111111111';
const applicationId = '22222222-2222-4222-8222-222222222222';
const serverId = '33333333-3333-4333-8333-333333333333';
const bindingId = '44444444-4444-4444-8444-444444444444';
const requestId = '55555555-5555-4555-8555-555555555555';
const actor = { userId: '66666666-6666-4666-8666-666666666666', sessionId: '77777777-7777-4777-8777-777777777777', role: 'owner' };
const options = { action: 'install', databaseBindingId: bindingId, title: 'Test site', adminUser: 'admin', adminEmail: 'admin@example.test', locale: 'tr_TR', scheme: 'https' };
const configText = host => `<?php\ndefine('DB_HOST', '${host}');\ndefine('DB_NAME', 'owned_database');\ndefine('DB_USER', 'owned_user');\n$table_prefix = 'yp_test_';\n`;

async function fixture(t, { configured = false, dbHost = 'localhost', commandFails = null, allowed = true, healthSatisfied = true } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'yp-wordpress-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'site'); await mkdir(root, { mode: 0o700 });
  const managedRoot = `/var/lib/yunpanel/apps/${applicationId}/current`;
  const fileDependencies = managedFilesystemDependencies(managedRoot, root);
  await writeFile(path.join(root, 'index.php'), 'Original site', { mode: 0o640 });
  await writeFile(path.join(root, 'unrelated.txt'), 'Keep this file', { mode: 0o640 });
  if (configured) await writeFile(path.join(root, 'wp-config.php'), configText(dbHost), { mode: 0o640 });
  const website = { id: websiteId, applicationId, serverId, unixUser: 'yunapp-abcdef123456', name: 'Owned site display name', documentRoot: root, revision: 1 };
  const jobRegistry = createJobRegistry(); await jobRegistry.init();
  const calls = [], backupCalls = [], restoreCalls = [], healthCalls = [], snapshots = new Map();
  const binding = { id: bindingId, websiteId, applicationId, serverId, unixUser: website.unixUser, databaseName: 'owned_database' };
  const credential = { id: bindingId, username: 'owned_user', revision: 1 };
  const tools = {
    resolveWebsitePhpContext: async id => { assert.equal(id, websiteId); return { website, application: { id: applicationId }, unixUser: website.unixUser, cwd: root }; },
    getWpCliAvailability: async () => ({ available: true, version: '2.12.0' }),
    getWpCliStatus: async () => ({ available: true, installed: true, coreVersion: '6.9.1', plugins: [], themes: [], checks: { installation: 'ready', plugins: 'ready', themes: 'ready' } }),
    runWpCli: async (id, input) => {
      assert.equal(id, websiteId); calls.push(structuredClone(input));
      if (commandFails === `${input.command}.${input.args[0]}`) return { success: false, exitCode: 1 };
      if (input.command === 'core' && input.args[0] === 'download') {
        await mkdir(path.join(root, 'wp-admin')); await writeFile(path.join(root, 'wp-load.php'), 'Downloaded core'); await writeFile(path.join(root, 'index.php'), 'WordPress front controller');
      }
      if (input.command === 'config' && input.args[0] === 'create') await writeFile(path.join(root, 'wp-config.php'), configText('localhost'), { mode: 0o640 });
      if (input.command === 'core' && input.args[0] === 'update') await writeFile(path.join(root, 'index.php'), 'Updated front controller', { mode: 0o640 });
      return { success: true, exitCode: 0, stdout: input.command === 'user' && input.args[0] === 'list' ? '[{"user_login":"admin"}]'
        : input.command === 'option' ? 'https://site.example.test' : input.command === 'eval' ? 'Success: verified' : input.command === 'plugin' || input.command === 'theme' ? '[]' : 'Success' };
    },
  };
  const secretStore = createOperationSecretStore({ root: path.join(base, 'secrets'), masterKey: Buffer.alloc(32, 5) });
  const service = createWordPressToolkitService({ tools, jobRegistry, secretStore,
    healthInspector: { inspect: async spec => { healthCalls.push(spec); return { satisfied: healthSatisfied, statusCode: healthSatisfied ? 200 : 500 }; } },
    domainRegistry: { listDomains: async () => [{ id: '88888888-8888-4888-8888-888888888888', websiteId, serverId, primaryDomain: 'site.example.test', httpsMode: 'managed', certificateId: requestId }] },
    authorizeActor: async input => allowed ? input : null, siteMutationLock: { withSiteLock: async (_identity, action) => action() },
    siteFileManager: { execute: async (id, operation) => { assert.equal(id, websiteId); return executeSiteFileOperation({ ...operation, root: managedRoot }, fileDependencies); } },
    databaseBindingRegistry: { getBinding: async id => id === bindingId ? binding : null, getByDatabase: async ({ databaseName }) => databaseName === binding.databaseName ? binding : null, listBindings: async () => [binding] },
    databaseCredentialRegistry: { getForBinding: async () => credential, materializeCredential: async () => ({ password: 'FixtureDatabaseSecret_123!' }) },
    resticRepositoryRegistry: { listRepositories: async () => [{ id: bindingId, serverId, name: `website-${websiteId}`, status: 'ready' }] },
    websiteBackupService: {
      previewBackup: async () => ({ backupSetDigest: 'a'.repeat(64), confirmation: 'backup-confirm' }),
      executeBackup: async input => {
        backupCalls.push(input); const files = new Map();
        for (const name of await readdir(root)) { try { files.set(name, await readFile(path.join(root, name), 'utf8')); } catch {} }
        snapshots.set('snapshot-before-wp', files); return { snapshot: { snapshotId: 'snapshot-before-wp' } };
      },
    },
    websiteRestoreService: { previewRestore: async input => { restoreCalls.push(input); return { previewDigest: 'b'.repeat(64), confirmation: 'restore-confirm' }; },
      executeRestore: async input => { restoreCalls.push(input); for (const [name, content] of snapshots.get(input.snapshotId)) await writeFile(path.join(root, name), content); return { status: 'succeeded' }; } },
  });
  async function queue(actionOptions = options, password = 'FixtureAdministratorSecret_123!') {
    const preview = await service.preview(websiteId, actionOptions);
    return service.queue(websiteId, { requestId, options: actionOptions, expectedWebsiteRevision: preview.websiteRevision,
      previewDigest: preview.previewDigest, confirmation: preview.confirmation, password }, actor);
  }
  async function execute() {
    const { job, envelope } = await jobRegistry.claimNext(serverId);
    const result = await service.execute(envelope.payload, { jobId: job.id, serverId, resourceId: applicationId, resourceType: 'application' });
    await jobRegistry.complete({ serverId, jobId: job.id, status: 'succeeded', result });
    return { job, payload: envelope.payload, result };
  }
  return { service, root, jobRegistry, calls, backupCalls, restoreCalls, healthCalls, queue, execute, secretStore };
}

test('WordPress install queues a secret reference, executes against the owned DB, then verifies core and password', async t => {
  const f = await fixture(t); const queued = await f.queue();
  assert.equal(queued.job.status, 'queued'); assert.equal(f.calls.length, 0);
  assert.equal(JSON.stringify(queued).includes('FixtureAdministratorSecret'), false);
  const completed = await f.execute();
  assert.equal(completed.result.completed, true); assert.equal(f.backupCalls.length, 1);
  assert.equal((await f.service.status(websiteId)).installed, true);
  assert.equal(JSON.stringify(f.calls.map(call => call.args)).includes('FixtureDatabaseSecret'), false);
  assert.equal(JSON.stringify(f.calls.map(call => call.args)).includes('FixtureAdministratorSecret'), false);
  assert.equal(f.calls.find(call => call.command === 'config').input, 'FixtureDatabaseSecret_123!\n');
  assert.equal(f.calls.find(call => call.command === 'core' && call.args[0] === 'download').args[1], 'https://wordpress.org/latest.zip', 'Official ZIP avoids the WP-CLI 2.12 PharData long-path corruption');
  assert.ok(f.calls.find(call => call.command === 'core' && call.args[0] === 'download').args.includes('--force'), 'The verified backed-up homepage must be replaced by the actual WordPress front controller');
  assert.equal(f.calls.find(call => call.command === 'core' && call.args[0] === 'install').input, 'FixtureAdministratorSecret_123!\n');
  assert.ok(f.calls.some(call => call.command === 'eval' && call.input === 'FixtureAdministratorSecret_123!\n'));
  assert.equal(await readFile(path.join(f.root, 'unrelated.txt'), 'utf8'), 'Keep this file');
  await f.service.releaseSecret(completed.payload);
  await assert.rejects(f.secretStore.read({ id: requestId, websiteId, purpose: 'wordpress.install' }));
});

test('failed installation deletes only newly added core files and restores files and DB through the existing engine', async t => {
  const f = await fixture(t, { commandFails: 'core.install' }); await f.queue();
  await assert.rejects(f.execute(), error => error.code === 'wordpress_install_failed');
  assert.deepEqual(f.restoreCalls[0].include, ['paths', 'databases']);
  assert.equal(await readFile(path.join(f.root, 'index.php'), 'utf8'), 'Original site');
  assert.equal(await readFile(path.join(f.root, 'unrelated.txt'), 'utf8'), 'Keep this file');
  assert.equal((await readdir(f.root)).includes('wp-config.php'), false);
  assert.equal((await readdir(f.root)).includes('wp-admin'), false);
});

test('CLI success with a broken actual site response restores the prior front controller and cannot complete the update', async t => {
  const f = await fixture(t, { configured: true, healthSatisfied: false });
  await f.queue({ action: 'core.update' });
  await assert.rejects(f.execute(), { code: 'wordpress_http_health_failed' });
  assert.deepEqual(f.healthCalls, [{ primaryDomain: 'site.example.test', healthPath: '/', timeoutSeconds: 30 }]);
  assert.equal(await readFile(path.join(f.root, 'index.php'), 'utf8'), 'Original site');
  assert.equal(f.restoreCalls.length, 2);
  assert.deepEqual(f.restoreCalls[0].include, ['paths', 'databases']);
});

test('an external WordPress DB host fails before WP-CLI, snapshot, or job dispatch', async t => {
  const f = await fixture(t, { configured: true, dbHost: '10.0.0.44' });
  await assert.rejects(f.service.status(websiteId), error => error.code === 'wordpress_database_host_forbidden');
  await assert.rejects(f.service.preview(websiteId, { action: 'core.update' }), error => error.code === 'wordpress_database_host_forbidden');
  assert.equal(f.calls.length, 0); assert.equal(f.backupCalls.length, 0);
});

test('a commented local host cannot hide an external WordPress database connection', async t => {
  const f = await fixture(t, { configured: true });
  await writeFile(path.join(f.root, 'wp-config.php'), "<?php\n/* define('DB_HOST', 'localhost'); */\n" + configText('10.0.0.44').replace('<?php', ''));
  await assert.rejects(f.service.status(websiteId), error => error.code === 'wordpress_database_host_forbidden');
  assert.equal(f.calls.length, 0);
});

test('replaying the same completed install returns its original job without a second snapshot or overwrite', async t => {
  const f = await fixture(t); const first = await f.queue(); const preview = await f.service.preview(websiteId, options);
  await f.execute();
  const repeat = await f.service.queue(websiteId, { requestId, options, expectedWebsiteRevision: preview.websiteRevision,
    previewDigest: preview.previewDigest, confirmation: preview.confirmation, password: 'FixtureAdministratorSecret_123!' }, actor);
  assert.equal(repeat.job.id, first.job.id); assert.equal(repeat.job.status, 'succeeded'); assert.equal(f.backupCalls.length, 1);
  assert.equal((await f.service.getRequest(websiteId, requestId, actor)).id, first.job.id);
});

test('unsupported package URLs, flags and foreign database references never reach a native command', async t => {
  for (const invalid of [{ action: 'plugin.install', package: 'https://example.test/code.zip' }, { action: 'theme.install', package: '--force' }, { action: 'password', username: '--role=owner' }]) assert.throws(() => normalizeWordPressActionOptions(invalid));
  const f = await fixture(t); await assert.rejects(f.service.preview(websiteId, { ...options, databaseBindingId: applicationId }), error => error.code === 'wordpress_database_scope_invalid');
  assert.equal(f.calls.length, 0);
});

test('an edited homepage invalidates the installation preview before backup or native file replacement', async t => {
  const f = await fixture(t); const preview = await f.service.preview(websiteId, options);
  await writeFile(path.join(f.root, 'index.php'), 'Changed after preview', {mode:0o640});
  await assert.rejects(f.service.queue(websiteId, {requestId,options,expectedWebsiteRevision:1,previewDigest:preview.previewDigest,confirmation:preview.confirmation,password:'FixtureAdministratorSecret_123!'}, actor), e=>e.code==='wordpress_preview_stale');
  assert.equal(f.calls.length,0); assert.equal(f.backupCalls.length,0);
});
