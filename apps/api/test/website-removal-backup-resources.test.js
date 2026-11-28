import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWebsiteRemovalCleanupAdapters } from '../src/websites/website-removal-cleanup-adapters.js';
import { createWebsiteBackupSetProvider } from '../src/backup/website-backup-set.js';

// T971: website backup/restore staging writes <resources>/website/<websiteId>/
// (database dumps, pre-restore dumps, .database-transactions, env metadata,
// mail virtual maps and mail data). Removing the Website must remove exactly
// that folder; Restic repositories, other Websites and shared receipts stay.

const websiteId = '11111111-1111-4111-8111-111111111111';
const otherWebsiteId = '44444444-4444-4444-8444-444444444444';
const applicationId = '22222222-2222-4222-8222-222222222222';
const serverId = '33333333-3333-4333-8333-333333333333';
const systemUser = 'yunapp-123456789abc';

async function exists(target) {
  try { await lstat(target); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function tempRoot(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'yp-t971-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// Stage the exact layout left behind on the test server after backup/restore.
async function stageLeftover(resourceRoot, id = websiteId) {
  const staged = path.join(resourceRoot, 'website', id);
  await mkdir(path.join(staged, 'databases', 'website-55555555-5555-4555-8555-555555555555'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(staged, 'databases', 'website-55555555-5555-4555-8555-555555555555', 'dump.sql'), '-- dump\n', { mode: 0o600 });
  await mkdir(path.join(staged, 'databases', 'pre-restore:66666666-6666-4666-8666-666666666666'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(staged, 'databases', 'pre-restore:66666666-6666-4666-8666-666666666666', 'dump.sql'), '-- pre\n', { mode: 0o600 });
  await mkdir(path.join(staged, '.database-transactions', 'tx-1'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(staged, 'env-metadata.json'), '{}\n', { mode: 0o600 });
  await mkdir(path.join(staged, 'mail'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(staged, 'mail', 'agent4-t971.example-virtual.json'), '{}\n', { mode: 0o600 });
  await mkdir(path.join(staged, 'mail-data', 'website-77777777-7777-4777-8777-777777777777'), { recursive: true, mode: 0o700 });
  return staged;
}

function adaptersFor({ resourceRoot, scratch, applicationBound = true }) {
  const removed = [];
  const retirement = { satisfied: true, poolRemoved: true, socketRemoved: true, websiteId, applicationId, unixUser: systemUser };
  const website = applicationBound
    ? { id: websiteId, serverId, applicationId, unixUser: systemUser }
    : { id: websiteId, serverId, applicationId: null, runtimeType: 'proxy', documentRoot: null };
  const adapters = createWebsiteRemovalCleanupAdapters({
    websiteRegistry: {
      getWebsite: async () => website,
      listWebsites: async () => [{ id: websiteId, applicationId: website.applicationId }],
    },
    applicationRegistry: { getApplication: async () => ({ id: applicationId, type: 'static', serverId }) },
    websiteProvisioningRuntime: {
      registry: { listForWebsite: async () => [{ operationId: '55555555-5555-4555-8555-555555555555', steps: [
        { kind: 'unix_identity', state: 'succeeded', intent: { websiteId, applicationId, unixUser: systemUser,
          homeDirectory: '/var/lib/yunpanel/data/' + applicationId }, evidence: { owned: true } },
        { kind: 'elfinder', state: 'succeeded', intent: { adapter: 'elfinder-fpm', websiteId, applicationId, unixUser: systemUser } },
      ] }] },
      handlers: {
        elfinder: { retire: async () => retirement, inspectRetirement: async () => retirement },
        sftp: { retire: async () => {}, inspectRetirement: async () => ({ satisfied: true, sshdConfigRemoved: true,
          mountUnitRemoved: true, chrootRemoved: true, websiteId, applicationId, unixUser: systemUser }) },
        php_runtime: { retire: async () => retirement, inspectRetirement: async () => retirement },
        unix_identity: { compensate: async () => ({}), inspectCompensation: async () => ({}),
          inspect: async () => ({ satisfied: false, reason: 'website_identity_user_missing' }) },
      },
    },
    backupResourceRoot: resourceRoot,
    lstatFn: lstat,
    // Never let the test delete anything outside its own temporary directory.
    rmFn: async (target, options) => {
      if (!target.startsWith(scratch + path.sep)) throw new Error(`test refused to delete ${target}`);
      removed.push(target);
      return rm(target, options);
    },
  });
  return { adapters, removed };
}

test('website removal deletes exactly the Website backup resource folder and keeps Restic, siblings and symlink targets', async (t) => {
  const scratch = await tempRoot(t);
  const resourceRoot = path.join(scratch, 'backups', 'resources');
  const staged = await stageLeftover(resourceRoot);
  const sibling = await stageLeftover(resourceRoot, otherWebsiteId);
  const receipts = path.join(resourceRoot, 'website', '.database-restore-receipts');
  await mkdir(receipts, { recursive: true });
  await writeFile(path.join(receipts, 'receipt.json'), '{}\n');
  const restic = path.join(scratch, 'backups', 'restic', 'repos', 'repo-1');
  await mkdir(restic, { recursive: true });
  await writeFile(path.join(restic, 'config'), 'restic\n');
  const outside = path.join(scratch, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'keep.txt'), 'keep\n');
  await symlink(outside, path.join(staged, 'mail-data', 'escape'));

  // The folder is the one the backup set stages for this Website.
  const provider = createWebsiteBackupSetProvider({
    websiteRegistry: { getWebsite: async () => ({ id: websiteId, serverId, name: 'agent4-t971.example', runtimeType: 'proxy', revision: 1 }) },
    domainRegistry: { listDomains: async () => [] },
    databaseBindingRegistry: { listBindings: async () => [] },
    mailDomainRegistry: { listMailDomains: async () => [] },
    backupResourceRoot: resourceRoot,
  });
  assert.equal((await provider.getWebsiteBackupSet({ websiteId })).stagedRoot, staged);

  const { adapters, removed } = adaptersFor({ resourceRoot, scratch });
  const result = await adapters.fileCleanupHandler({ websiteId, applicationId, retainedBackups: ['backup-a'] });
  assert.equal(result.filesCleaned, true);
  assert.deepEqual(result.retainedBackups, ['backup-a']);
  assert.equal(await exists(staged), false, 'the removed Website backup resource folder must not remain');
  assert.deepEqual(removed, [staged]);
  assert.equal(await exists(path.join(sibling, 'env-metadata.json')), true);
  assert.equal(await readFile(path.join(receipts, 'receipt.json'), 'utf8'), '{}\n');
  assert.equal(await readFile(path.join(restic, 'config'), 'utf8'), 'restic\n');
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep\n');

  // Explicit continuation after a crash sees the folder already gone.
  const again = await adapters.fileCleanupHandler({ websiteId, applicationId, retainedBackups: ['backup-a'] });
  assert.equal(again.filesCleaned, true);
});

test('external proxy removal without an Application also deletes its backup resource folder', async (t) => {
  const scratch = await tempRoot(t);
  const resourceRoot = path.join(scratch, 'backups', 'resources');
  const staged = await stageLeftover(resourceRoot);
  const { adapters } = adaptersFor({ resourceRoot, scratch, applicationBound: false });
  const result = await adapters.fileCleanupHandler({ websiteId, applicationId: null });
  assert.equal(result.filesCleaned, true);
  assert.equal(await exists(staged), false);
});

test('backup resource cleanup fails closed on a symlinked, non-directory or redirected folder', async (t) => {
  const cases = {
    'symlinked Website folder': async (resourceRoot, outside) => {
      await mkdir(path.join(resourceRoot, 'website'), { recursive: true });
      await symlink(outside, path.join(resourceRoot, 'website', websiteId));
    },
    'regular file instead of folder': async (resourceRoot) => {
      await mkdir(path.join(resourceRoot, 'website'), { recursive: true });
      await writeFile(path.join(resourceRoot, 'website', websiteId), 'not a directory\n');
    },
    'symlinked website parent': async (resourceRoot, outside) => {
      await mkdir(path.join(outside, websiteId), { recursive: true });
      await mkdir(resourceRoot, { recursive: true });
      await symlink(outside, path.join(resourceRoot, 'website'));
    },
  };
  for (const [name, arrange] of Object.entries(cases)) {
    const scratch = await tempRoot(t);
    const resourceRoot = path.join(scratch, 'backups', 'resources');
    const outside = path.join(scratch, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'keep.txt'), 'keep\n');
    await arrange(resourceRoot, outside);
    const { adapters, removed } = adaptersFor({ resourceRoot, scratch });
    await assert.rejects(adapters.inspectFileCleanup({ websiteId, applicationId }), { code: 'website_cleanup_path_unsafe' }, name);
    await assert.rejects(adapters.fileCleanupHandler({ websiteId, applicationId }), { code: 'website_cleanup_path_unsafe' }, name);
    assert.deepEqual(removed, [], name);
    assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep\n', name);
  }
});

test('an absent backup resource root is not an error', async (t) => {
  const scratch = await tempRoot(t);
  const { adapters, removed } = adaptersFor({ resourceRoot: path.join(scratch, 'missing', 'resources'), scratch });
  assert.equal((await adapters.fileCleanupHandler({ websiteId, applicationId })).filesCleaned, true);
  assert.deepEqual(removed, []);
});

test('the backup resource root must be an absolute normalized path', () => {
  for (const backupResourceRoot of ['relative/resources', '/var/lib/yunpanel/../resources', '/', '']) {
    assert.throws(() => adaptersFor({ resourceRoot: backupResourceRoot, scratch: '/nonexistent' }),
      { code: 'website_removal_cleanup_dependencies_invalid' }, backupResourceRoot);
  }
});

test('removal targets the same default resource root that backup staging writes', async () => {
  const provider = createWebsiteBackupSetProvider({
    websiteRegistry: { getWebsite: async () => ({ id: websiteId, serverId, name: 'agent4-t971.example', runtimeType: 'proxy', revision: 1 }) },
    domainRegistry: { listDomains: async () => [] },
    databaseBindingRegistry: { listBindings: async () => [] },
    mailDomainRegistry: { listMailDomains: async () => [] },
  });
  const expected = (await provider.getWebsiteBackupSet({ websiteId })).stagedRoot;
  assert.equal(expected, '/var/lib/yunpanel/backups/resources/website/' + websiteId);
  const seen = [];
  const adapters = createWebsiteRemovalCleanupAdapters({
    websiteRegistry: { getWebsite: async () => ({ id: websiteId, serverId, applicationId: null, runtimeType: 'proxy', documentRoot: null }),
      listWebsites: async () => [] },
    applicationRegistry: { getApplication: async () => null },
    websiteProvisioningRuntime: { registry: { listForWebsite: async () => [] },
      handlers: { unix_identity: { compensate: async () => ({}), inspectCompensation: async () => ({}) } } },
    lstatFn: async (target) => { seen.push(target); throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    rmFn: async () => { throw new Error('nothing may be deleted'); },
  });
  await adapters.fileCleanupHandler({ websiteId, applicationId: null });
  assert.equal(seen[0], path.posix.dirname(path.posix.dirname(expected)));
});
