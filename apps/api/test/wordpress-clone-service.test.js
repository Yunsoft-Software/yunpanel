import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWordPressCloneService } from '../src/wordpress-clone-service.js';
import { normalizeWordPressActionOptions } from '../src/wordpress-toolkit-service.js';
import { executeSiteFileOperation } from '../src/site-file-worker.js';
import { managedFilesystemDependencies } from './fixtures/managed-filesystem.js';

const sourceId = '11111111-1111-4111-8111-111111111111', targetId = '22222222-2222-4222-8222-222222222222';
const bindingId = '33333333-3333-4333-8333-333333333333', serverId = '44444444-4444-4444-8444-444444444444';
const options = { action: 'staging', targetWebsiteId: targetId, databaseBindingId: bindingId, scheme: 'http' };
async function fixture(t, { denied = false, populated = false, health = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yp-wp-clone-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const roots = { [sourceId]: path.join(root, 'source'), [targetId]: path.join(root, 'target') };
  for (const directory of Object.values(roots)) await mkdir(directory);
  await mkdir(path.join(roots[sourceId], 'wp-content'));
  await writeFile(path.join(roots[sourceId], 'wp-content', 'marker.bin'), Buffer.from([0, 255, 128, 9]));
  await writeFile(path.join(roots[sourceId], 'index.php'), '<?php echo "source";');
  await writeFile(path.join(roots[sourceId], 'wp-config.php'), 'SOURCE_PRIVATE_CREDENTIAL');
  if (populated) await writeFile(path.join(roots[targetId], 'existing.txt'), 'keep');
  const calls = [], writes = [], credentials = [];
  let imported = false, revoked = denied;
  const destinationOptions = new Map();
  const contexts = Object.fromEntries(Object.keys(roots).map(id => [id, { website: { id, revision: 1, serverId }, application: { id }, unixUser: id === sourceId ? 'yunapp-aaaaaaaaaaaa' : 'yunapp-bbbbbbbbbbbb', primaryDomain: id === sourceId ? 'source.example.test' : 'target.example.test', domain: { id, desiredRevision: 1, httpsMode: 'off', certificateId: null }, domains: [{ primaryDomain: id === sourceId ? 'source.example.test' : 'target.example.test' }] }]));
  const binding = { id: bindingId, revision: 1, websiteId: targetId, applicationId: targetId, unixUser: contexts[targetId].unixUser, serverId, databaseName: 'destination_db' };
  const credential = { id: bindingId, revision: 1, username: 'destination_user' };
  const fileManager = { execute: async (id, operation) => {
    if (['upload', 'mkdir', 'delete'].includes(operation.operation)) writes.push({ id, ...operation });
    const managed = `/var/lib/yunpanel/apps/${id}/current`;
    return executeSiteFileOperation({ root: managed, ...operation }, managedFilesystemDependencies(managed, roots[id]));
  } };
  const service = createWordPressCloneService({
    context: async id => contexts[id],
    config: async current => ({ present: current.website.id === sourceId || (await readdir(roots[targetId])).includes('wp-config.php'),
      entries: (await fileManager.execute(current.website.id, { operation: 'list', path: '' })).entries,
      binding: current.website.id === sourceId ? { databaseName: 'source_db' } : binding,
      credential: current.website.id === sourceId ? { username: 'source_user' } : credential,
      prefix: 'wp_', configSha256: 'a'.repeat(64) }),
    run: async (id, command, args, input) => {
      calls.push({ id, command, args, input });
      if (command === 'config') {
        credentials.push(input);
        if (args[0] === 'create') await writeFile(path.join(roots[targetId], 'wp-config.php'), 'DESTINATION_PRIVATE_CREDENTIAL');
      }
      if (command === 'db' && args[0] === 'import') imported = true;
      if (command === 'option' && args[0] === 'update') destinationOptions.set(args[1], args[2]);
      return { stdout: command === 'option' && args[0] === 'get' ? id === sourceId ? 'http://source.example.test' : destinationOptions.get(args[1]) : command === 'db' && args[0] === 'export' ? '-- private SQL\nCREATE TABLE wp_options (id int);\n' : 'Success' };
    },
    actor: async (_owner, id) => { if (revoked && id === targetId) throw Object.assign(new Error('forbidden'), { code: 'forbidden', status: 403 }); },
    siteFileManager: fileManager, databaseBindingRegistry: { getBinding: async id => id === bindingId ? binding : null },
    databaseCredentialRegistry: { getForBinding: async () => credential, materializeCredential: async () => ({ password: 'DESTINATION_PRIVATE_CREDENTIAL' }) },
    databaseManager: { inspectDatabaseTables: async databaseName => ({ databaseName, tables: databaseName === 'source_db' ? [{ name: 'wp_options', type: 'BASE TABLE' }, { name: 'unrelated', type: 'BASE TABLE' }] : imported ? [{ name: 'wp_options', type: 'BASE TABLE' }] : [] }) },
    healthInspector: { inspect: async () => ({ satisfied: health }) },
    siteMutationLock: { withSiteLock: async (_scope, action) => action() }, jobRegistry: { listJobs: async () => [] },
  });
  return { service, roots, calls, writes, credentials, revoke: () => { revoked = true; } };
}
const owner = { userId: sourceId, sessionId: targetId, role: 'owner' };
const execution = { jobId: bindingId, serverId };
test('staging copies binary files under the destination worker and imports only WordPress tables with a new credential', async t => {
  const f = await fixture(t), plan = await f.service.preview(sourceId, options, owner);
  assert.deepEqual(plan.tables, ['wp_options']);
  await f.service.execute(sourceId, options, owner, plan, execution);
  assert.deepEqual(await readFile(path.join(f.roots[targetId], 'wp-content/marker.bin')), Buffer.from([0, 255, 128, 9]));
  assert.equal(await readFile(path.join(f.roots[sourceId], 'wp-config.php'), 'utf8'), 'SOURCE_PRIVATE_CREDENTIAL');
  assert.equal(await readFile(path.join(f.roots[targetId], 'wp-config.php'), 'utf8'), 'DESTINATION_PRIVATE_CREDENTIAL');
  assert.ok(f.writes.every(write => write.id === targetId));
  assert.ok(f.credentials.includes('DESTINATION_PRIVATE_CREDENTIAL\n'));
  assert.ok(f.calls.find(call => call.command === 'db' && call.args[0] === 'export').args.includes('--tables=wp_options'));
  assert.ok(f.calls.some(call => call.command === 'search-replace' && call.args.includes('--precise')));
  assert.ok(f.calls.some(call => call.command === 'config' && call.args.includes('WP_ENVIRONMENT_TYPE')));
  assert.ok(f.calls.some(call => call.command === 'config' && call.args.includes('DISABLE_WP_CRON')));
});
test('a foreign destination is rejected before copying files or database contents', async t => {
  const f = await fixture(t, { denied: true });
  await assert.rejects(f.service.preview(sourceId, options, owner), { code: 'forbidden' });
  assert.equal(f.writes.length, 0); assert.equal(f.calls.length, 0);
});
test('existing destination content is preserved and prevents clone', async t => {
  const f = await fixture(t, { populated: true });
  await assert.rejects(f.service.preview(sourceId, options, owner), { code: 'wordpress_clone_target_not_empty' });
  assert.equal(await readFile(path.join(f.roots[targetId], 'existing.txt'), 'utf8'), 'keep');
  assert.equal(f.writes.length, 0);
});
test('a source edit between preview and execution prevents all destination mutations', async t => {
  const f = await fixture(t), plan = await f.service.preview(sourceId, options, owner);
  await writeFile(path.join(f.roots[sourceId], 'index.php'), 'changed');
  await assert.rejects(f.service.execute(sourceId, options, owner, plan, execution), { code: 'wordpress_clone_preview_stale' });
  assert.equal(f.writes.length, 0);
});
test('revoked destination access prevents execution of an already previewed clone', async t => {
  const f = await fixture(t), plan = await f.service.preview(sourceId, options, owner); f.revoke();
  await assert.rejects(f.service.execute(sourceId, options, owner, plan, execution), { code: 'forbidden' });
  assert.equal(f.writes.length, 0);
});
test('failed HTTP health preserves source and partial destination instead of destructive rollback or import replay', async t => {
  const f = await fixture(t, { health: false }), plan = await f.service.preview(sourceId, options, owner);
  await assert.rejects(f.service.execute(sourceId, options, owner, plan, execution), { code: 'wordpress_clone_http_failed' });
  assert.equal(await readFile(path.join(f.roots[sourceId], 'wp-config.php'), 'utf8'), 'SOURCE_PRIVATE_CREDENTIAL');
  assert.equal(f.calls.filter(call => call.command === 'db' && call.args[0] === 'import').length, 1);
  assert.equal(f.writes.some(write => write.operation === 'delete'), false);
  await assert.rejects(f.service.execute(sourceId, options, owner, plan, execution), { code: 'wordpress_clone_target_not_empty' });
});
test('clone options reject malformed and extra scope fields', () => {
  assert.deepEqual(normalizeWordPressActionOptions(options), options);
  for (const value of [{ ...options, targetWebsiteId: 'other' }, { ...options, scheme: 'file' }, { ...options, unixUser: 'root' }]) assert.throws(() => normalizeWordPressActionOptions(value));
});
