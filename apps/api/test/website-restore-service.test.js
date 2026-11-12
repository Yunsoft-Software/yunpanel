import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WebsiteRestoreError,
  createWebsiteRestoreService,
} from '../src/website-restore-service.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const otherServerId = 'd0bc7f95-bdbd-4375-904f-50c532fc3faa';
const websiteId = '2c387b02-8747-458a-b509-8f531d4d149e';
const notFoundWebsiteId = '00000000-0000-4000-8000-000000000000';
const repositoryId = '91a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c';
const notFoundRepoId = '11111111-2222-4333-8444-555555555555';
const snapshotId = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d';
const preRestoreSnapshotId = '9z8y7x6w5v4u3t2s1r0q9p8o7n6m5l4k';

function fixture({
  healthSatisfied = true,
  healthThrows = false,
  preRestoreFails = false,
  restoreExecutionFails = false,
  activeJobs = [],
} = {}) {
  const calls = {
    listSnapshots: [],
    createSnapshot: [],
    restore: [],
    healthInspect: [],
  };

  const website = {
    id: websiteId,
    serverId,
    name: 'TestApp',
    primaryDomain: 'example.com',
    runtimeType: 'node',
    revision: 3,
  };

  const repository = {
    id: repositoryId,
    serverId,
    name: 'default_repo',
    target: '/var/lib/yunpanel/backups/restic/repos/default_repo',
  };

  const snapshots = [
    {
      id: snapshotId,
      time: '2026-09-20T03:00:00.000Z',
      tags: [`website:${websiteId}`, 'env:production'],
      paths: ['/var/lib/yunpanel/apps/test/current', '/var/lib/yunpanel/data/test'],
    },
  ];

  const backupSet = {
    targetPaths: ['/var/lib/yunpanel/apps/test/current', '/var/lib/yunpanel/data/test'],
    excludePatterns: ['**/tmp/**'],
    tags: [`website:${websiteId}`, `server:${serverId}`],
  };

  const receipts = new Map();
  const receiptStore = {
    async read(id) {
      return receipts.get(id) ?? null;
    },
    async write(val) {
      const copy = { ...val, committedAt: new Date().toISOString() };
      receipts.set(val.transactionId, copy);
      return copy;
    },
  };

  const service = createWebsiteRestoreService({
    websiteRegistry: {
      async getWebsite(id) {
        return id === websiteId ? website : null;
      },
    },
    resticRepositoryRegistry: {
      async getRepository(id) {
        return id === repositoryId ? repository : null;
      },
      async revealPassword(id) {
        return id === repositoryId ? 'super_secret_password' : null;
      },
    },
    resticManager: {
      async listSnapshots(args) {
        calls.listSnapshots.push(args);
        return snapshots;
      },
      async createSnapshot(args) {
        calls.createSnapshot.push(args);
        if (preRestoreFails) {
          throw new Error('Disk full during pre-restore snapshot');
        }
        return { snapshotId: preRestoreSnapshotId };
      },
      async listSnapshotFiles() { return [{ type: 'file', path: '/var/lib/yunpanel/apps/test/current/marker.txt' }, { type: 'file', path: '/var/lib/yunpanel/data/test/marker.txt' }]; },
      async restore(args) {
        calls.restore.push(args);
        if (restoreExecutionFails && args.snapshotId === snapshotId) {
          throw new Error('Restic restore failed on corrupted pack file');
        }
        return { stdout: 'restored' };
      },
    },
    websiteBackupSetProvider: {
      async getWebsiteBackupSet({ websiteId: requestedWebsiteId }) {
        assert.equal(requestedWebsiteId, websiteId);
        return backupSet;
      },
    },
    healthInspector: {
      async inspect(args) {
        calls.healthInspect.push(args);
        if (healthThrows) {
          throw new Error('Connection refused to health endpoint');
        }
        return {
          satisfied: healthSatisfied,
          statusCode: healthSatisfied ? 200 : 502,
          attempts: healthSatisfied ? 1 : 3,
          error: healthSatisfied ? null : 'HTTP 502 Bad Gateway',
        };
      },
    },
    localServerId: serverId,
    jobRegistry: {
      async listJobs() {
        return activeJobs;
      },
    },
    receiptStore,
  });

  return { service, calls, website, repository, snapshots, backupSet, receipts, activeJobs };
}

test('previewRestore generates valid preview, digest, and confirmation for website snapshot', async () => {
  const { service, calls, repository } = fixture();

  const preview = await service.previewRestore({
    websiteId,
    repositoryId,
    snapshotId,
  });

  assert.equal(preview.websiteId, websiteId);
  assert.equal(preview.websiteRevision, 3);
  assert.equal(preview.repositoryId, repositoryId);
  assert.equal(preview.snapshotId, snapshotId);
  assert.deepEqual(preview.healthSpec, {
    primaryDomain: 'example.com',
    healthPath: '/',
    timeoutSeconds: 30,
  });
  assert.equal(typeof preview.previewDigest, 'string');
  assert.equal(preview.previewDigest.length, 64);
  assert.equal(preview.confirmation, `restore:${websiteId}:${snapshotId}:${preview.previewDigest}`);
  assert.deepEqual(calls.listSnapshots[0], {
    repository: repository.target,
    password: 'super_secret_password',
    tags: [`website:${websiteId}`],
  });
});

test('previewRestore errors: missing website, missing repo, missing snapshot, invalid UUID', async () => {
  const { service } = fixture();

  await assert.rejects(
    () => service.previewRestore({ websiteId: notFoundWebsiteId, repositoryId, snapshotId }),
    (err) => err instanceof WebsiteRestoreError && err.code === 'website_not_found' && err.status === 404,
  );

  await assert.rejects(
    () => service.previewRestore({ websiteId, repositoryId: notFoundRepoId, snapshotId }),
    (err) => err instanceof WebsiteRestoreError && err.code === 'repository_not_found' && err.status === 404,
  );

  await assert.rejects(
    () => service.previewRestore({ websiteId, repositoryId, snapshotId: 'nonexistent-snapshot-id' }),
    (err) => err instanceof WebsiteRestoreError && err.code === 'snapshot_not_found' && err.status === 404,
  );

  await assert.rejects(
    () => service.previewRestore({ websiteId: 'invalid-uuid', repositoryId, snapshotId }),
    (err) => err instanceof WebsiteRestoreError && err.code === 'invalid_website_id' && err.status === 400,
  );
});

test('previewRestore and executeRestore reject when an active job exists on the website (resource locking)', async () => {
  const activeJobs = [
    {
      id: 'job-1',
      status: 'running',
      resourceType: 'website',
      resourceId: websiteId,
      operation: 'app.node.deploy',
    },
  ];
  const { service } = fixture({ activeJobs });

  await assert.rejects(
    () => service.previewRestore({ websiteId, repositoryId, snapshotId }),
    (err) => err instanceof WebsiteRestoreError && err.code === 'website_job_conflict' && err.status === 409,
  );
});

test('executeRestore takes pre-restore snapshot, restores, checks health, and succeeds', async () => {
  const { service, calls, repository, backupSet, receipts } = fixture({ healthSatisfied: true });

  const preview = await service.previewRestore({ websiteId, repositoryId, snapshotId });

  const result = await service.executeRestore({
    websiteId,
    repositoryId,
    snapshotId,
    expectedPreviewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.websiteId, websiteId);
  assert.equal(result.snapshotId, snapshotId);
  assert.equal(result.preRestoreSnapshotId, preRestoreSnapshotId);
  assert.equal(result.healthCheck.satisfied, true);
  assert.equal(result.healthCheck.statusCode, 200);

  // Verify pre-restore snapshot was taken before restore
  assert.equal(calls.createSnapshot.length, 1);
  assert.ok(calls.createSnapshot[0].tags.includes('pre-restore'));
  assert.ok(calls.createSnapshot[0].tags.includes(`restore-of:${snapshotId}`));
  assert.equal(calls.createSnapshot[0].repository, repository.target);
  assert.deepEqual(calls.createSnapshot[0].paths, backupSet.targetPaths);
  assert.deepEqual(calls.createSnapshot[0].excludes, backupSet.excludePatterns);

  // Verify restore was called with target snapshot
  assert.equal(calls.restore.length, 1);
  assert.equal(calls.restore[0].snapshotId, snapshotId);
  assert.equal(calls.restore[0].repository, repository.target);

  // Verify health check was performed
  assert.equal(calls.healthInspect.length, 1);
  assert.equal(calls.healthInspect[0].primaryDomain, 'example.com');

  // Verify receipt was persisted with succeeded status
  assert.equal(receipts.size, 1);
  const [receipt] = receipts.values();
  assert.equal(receipt.status, 'succeeded');
  assert.equal(receipt.websiteRevision, 3);

  // Verify idempotent replay
  const replayResult = await service.executeRestore({
    websiteId,
    repositoryId,
    snapshotId,
    expectedPreviewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.equal(replayResult.status, 'succeeded');
  assert.equal(replayResult.idempotent, true);
  // calls to restore and createSnapshot must NOT have increased
  assert.equal(calls.restore.length, 1);
  assert.equal(calls.createSnapshot.length, 1);
});

test('two new restores of the same snapshot run independently while retries reuse only their own receipt', async () => {
  const { service, calls, receipts } = fixture();
  const preview = await service.previewRestore({ websiteId, repositoryId, snapshotId });
  const input = { websiteId, repositoryId, snapshotId, expectedPreviewDigest: preview.previewDigest,
    confirmation: preview.confirmation };
  const firstId = '8edf95c0-72ae-4a31-bd4a-cb95d15a61f1';
  const secondId = '675f2b94-5d61-4c3b-b870-3a2c7b8491d6';
  await service.executeRestore({ ...input, operationId: firstId });
  const second = await service.executeRestore({ ...input, operationId: secondId });
  assert.equal(second.idempotent, undefined);
  assert.equal(calls.restore.length, 2);
  assert.equal(calls.createSnapshot.length, 2);
  assert.equal(receipts.size, 2);
  const retry = await service.executeRestore({ ...input, operationId: secondId });
  assert.equal(retry.idempotent, true);
  assert.equal(calls.restore.length, 2);
  assert.equal(calls.createSnapshot.length, 2);
});

test('executeRestore triggers automatic health rollback when health check fails', async () => {
  const { service, calls, receipts } = fixture({ healthSatisfied: false });

  const preview = await service.previewRestore({ websiteId, repositoryId, snapshotId });

  const result = await service.executeRestore({
    websiteId,
    repositoryId,
    snapshotId,
    expectedPreviewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });

  assert.equal(result.status, 'rolled_back');
  assert.equal(result.websiteId, websiteId);
  assert.equal(result.snapshotId, snapshotId);
  assert.equal(result.preRestoreSnapshotId, preRestoreSnapshotId);
  assert.equal(result.rollbackReason, 'health_check_failed');
  assert.equal(result.healthCheck.satisfied, false);
  assert.equal(result.healthCheck.statusCode, 502);

  // Verify restore was called twice: 1st with target snapshot, 2nd with pre-restore snapshot
  assert.equal(calls.restore.length, 2);
  assert.equal(calls.restore[0].snapshotId, snapshotId);
  assert.equal(calls.restore[1].snapshotId, preRestoreSnapshotId);

  // Verify rolled_back receipt was persisted
  const [receipt] = receipts.values();
  assert.equal(receipt.status, 'rolled_back');
  assert.equal(receipt.rollbackReason, 'health_check_failed');

  // Verify idempotent replay of rolled back state
  const replay = await service.executeRestore({
    websiteId,
    repositoryId,
    snapshotId,
    expectedPreviewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.equal(replay.status, 'rolled_back');
  assert.equal(replay.idempotent, true);
  assert.equal(calls.restore.length, 2);
});

test('executeRestore aborts before mutation if pre-restore snapshot fails', async () => {
  const { service, calls } = fixture({ preRestoreFails: true });

  const preview = await service.previewRestore({ websiteId, repositoryId, snapshotId });

  await assert.rejects(
    () => service.executeRestore({
      websiteId,
      repositoryId,
      snapshotId,
      expectedPreviewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    }),
    (err) => err instanceof WebsiteRestoreError && err.code === 'pre_restore_snapshot_failed' && err.status === 500,
  );

  // Verify that restore was NEVER executed
  assert.equal(calls.restore.length, 0);
});

test('executeRestore rejects stale preview digest or wrong confirmation', async () => {
  const { service, website } = fixture();

  const preview = await service.previewRestore({ websiteId, repositoryId, snapshotId });

  await assert.rejects(
    () => service.executeRestore({
      websiteId,
      repositoryId,
      snapshotId,
      expectedPreviewDigest: '0'.repeat(64),
      confirmation: preview.confirmation,
    }),
    (err) => err instanceof WebsiteRestoreError && err.code === 'restore_preview_stale' && err.status === 409,
  );

  await assert.rejects(
    () => service.executeRestore({
      websiteId,
      repositoryId,
      snapshotId,
      expectedPreviewDigest: preview.previewDigest,
      confirmation: 'wrong-confirmation',
    }),
    (err) => err instanceof WebsiteRestoreError && err.code === 'restore_confirmation_invalid' && err.status === 409,
  );

  // Revision change causes stale preview
  website.revision = 4;
  await assert.rejects(
    () => service.executeRestore({
      websiteId,
      repositoryId,
      snapshotId,
      expectedPreviewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    }),
    (err) => err instanceof WebsiteRestoreError && err.code === 'restore_preview_stale' && err.status === 409,
  );
});


test('a staged DNS reference cannot be mistaken for a successful live DNS restore', async () => {
 const f=fixture();const staged='/var/lib/yunpanel/backups/resources/website/metadata';
 f.backupSet.targetPaths.push(staged);f.backupSet.dns=[{stagedZonePath:staged+'/dns.json'}];
 await assert.rejects(f.service.previewRestore({websiteId,repositoryId,snapshotId}),e=>e.code==='website_restore_resource_adapter_unavailable');
 assert.equal(f.calls.restore.length,0);assert.equal(f.calls.createSnapshot.length,0);
});
test('restore health uses the resolved bound domain instead of a Website display name', async () => {
 const f=fixture();delete f.website.primaryDomain;f.website.name='Customer site display title';f.backupSet.website={id:websiteId,primaryDomain:'bound.example.com'};
 const preview=await f.service.previewRestore({websiteId,repositoryId,snapshotId});assert.equal(preview.healthSpec.primaryDomain,'bound.example.com');
});

async function createRealCompoundRestoreFixture(t, { healthStatusOverride = null } = {}) {
  const { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, rmdir, writeFile } = await import('node:fs/promises');
  const { createHash, randomBytes, randomUUID } = await import('node:crypto');
  const { DatabaseSync } = await import('node:sqlite');
  const http = await import('node:http');
  const { once } = await import('node:events');
  const os = await import('node:os');
  const path = await import('node:path');
  const {
    createDatabaseDumpManager,
    createDatabaseRestoreManager,
    createMailDataBackupManager,
    createMailDataRestoreManager,
    createResticManager,
    createWebsiteRestoreReceiptStore,
  } = await import('@yunpanel/host-runtime');
  const { createWebsiteHttpHealthInspector } = await import('@yunpanel/host-runtime/website-http-health-inspector');
  const { mailSqlTemplatePolicy } = await import('@yunpanel/config-templates');
  const { createResticRepositoryRegistry } = await import('../src/restic-repository-registry.js');
  const { createWebsiteBackupService } = await import('../src/website-backup-service.js');
  const { createWebsiteDatabaseBackupAdapter } = await import('../src/website-database-backup-adapter.js');
  const { createWebsiteMailBackupAdapter } = await import('../src/website-mail-backup-adapter.js');
  const { createWebsiteEnvironmentBackupAdapter } = await import('../src/website-environment-backup-adapter.js');
  const { createWebsiteResourceBackupCodec } = await import('../src/website-resource-backup-codec.js');
  const { createApplicationEnvironmentRegistry } = await import('../src/application-environment-registry.js');
  const { createMailboxRegistry } = await import('../src/mailbox-registry.js');
  const { createMailAliasRegistry } = await import('../src/mail-alias-registry.js');
  const { createMailboxQuotaRegistry } = await import('../src/mailbox-quota-registry.js');
  const { createMailboxForwardingRegistry } = await import('../src/mailbox-forwarding-registry.js');
  const { createMailConfigurationService } = await import('../src/mail-configuration.js');
  const { verifyMailboxPassword } = await import('../src/mailbox-password.js');
  const { createWebsiteBackupOperationRegistry } = await import('../src/website-backup-operation-registry.js');
  const { createWebsiteBackupOperationService } = await import('../src/website-backup-operation-service.js');

  const root = await mkdtemp(path.join(os.tmpdir(), 'yp-t900-compound-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const resticCliPath = path.join(root, 'real-archive-restic');
  await writeFile(
    resticCliPath,
    `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const repo = process.env.RESTIC_REPOSITORY;
const pwFile = process.env.RESTIC_PASSWORD_FILE;
const pw = fs.readFileSync(pwFile, 'utf8');
if (!repo || pw.length < 8) process.exit(2);
const args = process.argv.slice(2);
const cmd = args[0];
const snapsDir = path.join(repo, 'snapshots');

if (cmd === 'init') {
  fs.mkdirSync(snapsDir, { recursive: true, mode: 0o700 });
  const id = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(repo, 'config'), JSON.stringify({ id }), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ message_type: 'initialized', id }) + '\\n');
  process.exit(0);
}
if (cmd === 'backup') {
  const tags = [];
  const targets = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--json') continue;
    if (args[i] === '--tag') { tags.push(args[++i]); continue; }
    if (args[i] === '--exclude' || args[i] === '--parent') { i++; continue; }
    targets.push(path.resolve(args[i]));
  }
  const entries = [];
  function walk(current) {
    if (!fs.existsSync(current)) return;
    const st = fs.lstatSync(current);
    if (st.isDirectory()) {
      entries.push({ path: current, type: 'dir', mode: st.mode & 0o777, size: 0 });
      for (const name of fs.readdirSync(current).sort()) walk(path.join(current, name));
    } else if (st.isFile()) {
      const buf = fs.readFileSync(current);
      entries.push({ path: current, type: 'file', mode: st.mode & 0o777, size: buf.length, data: buf.toString('base64') });
    }
  }
  for (const target of targets) walk(target);
  const id = crypto.randomBytes(32).toString('hex');
  const snap = { id, short_id: id.slice(0, 8), time: new Date().toISOString(), paths: targets, tags, entries };
  fs.writeFileSync(path.join(snapsDir, id + '.json'), JSON.stringify(snap), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ message_type: 'summary', snapshot_id: id, total_files_processed: entries.length, total_bytes_processed: 0 }) + '\\n');
  process.exit(0);
}
if (cmd === 'snapshots') {
  const reqTags = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--tag') reqTags.push(args[++i]);
    else if (args[i] === '--path') i++;
  }
  const files = fs.existsSync(snapsDir) ? fs.readdirSync(snapsDir).filter((f) => f.endsWith('.json')) : [];
  const list = files.map((f) => JSON.parse(fs.readFileSync(path.join(snapsDir, f), 'utf8')))
    .filter((s) => reqTags.every((t) => (s.tags || []).includes(t)))
    .map(({ entries: _entries, ...meta }) => meta);
  process.stdout.write(JSON.stringify(list) + '\\n');
  process.exit(0);
}
if (cmd === 'ls') {
  const id = args[args.length - 1];
  const snap = JSON.parse(fs.readFileSync(path.join(snapsDir, id + '.json'), 'utf8'));
  for (const e of snap.entries) {
    process.stdout.write(JSON.stringify({ struct_type: 'node', path: e.path, type: e.type, size: e.size }) + '\\n');
  }
  process.exit(0);
}
if (cmd === 'restore') {
  const id = args[1];
  let targetDir = '/';
  const includes = [];
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--target') targetDir = args[++i];
    else if (args[i] === '--include') includes.push(args[++i]);
    else if (args[i] === '--exclude') i++;
  }
  const snap = JSON.parse(fs.readFileSync(path.join(snapsDir, id + '.json'), 'utf8'));
  const match = (p) => includes.length === 0 || includes.some((inc) => p === inc || p.startsWith(inc + '/') || inc.startsWith(p + '/'));
  for (const e of snap.entries) {
    if (!match(e.path)) continue;
    const outPath = targetDir === '/' ? e.path : path.join(targetDir, e.path);
    if (e.type === 'dir') {
      fs.mkdirSync(outPath, { recursive: true, mode: e.mode });
      fs.chmodSync(outPath, e.mode);
    } else if (e.type === 'file') {
      fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(outPath, Buffer.from(e.data, 'base64'), { mode: e.mode });
      fs.chmodSync(outPath, e.mode);
    }
  }
  process.exit(0);
}
process.exit(1);
`,
    { mode: 0o700 },
  );
  await chmod(resticCliPath, 0o700);

  const masterKey = randomBytes(32);
  const srvId = randomUUID();
  const appId = randomUUID();
  const siteId = randomUUID();
  const webDomId = randomUUID();
  const mailDomId = randomUUID();
  const dbBindId = randomUUID();
  const hostname = `t900-${siteId.slice(0, 8)}.example.test`;

  const documentRoot = path.join(root, 'apps', appId, 'current');
  const stagedRoot = path.join(root, 'backups', 'resources', 'website', siteId);
  await mkdir(documentRoot, { recursive: true, mode: 0o750 });

  const website = { id: siteId, serverId: srvId, applicationId: appId, name: hostname, primaryDomain: hostname, runtimeType: 'php', revision: 1 };
  const application = { id: appId, serverId: srvId, type: 'php', currentReleaseId: null };
  const webDomain = { id: webDomId, websiteId: siteId, serverId: srvId, primaryDomain: hostname, type: 'primary' };
  let mailDomain = { id: mailDomId, webDomainId: webDomId, domainName: hostname, managementMode: 'local', status: 'enabled', revision: 1 };

  const resticManager = createResticManager({ resticPath: resticCliPath });
  const resticRepositoryRegistry = createResticRepositoryRegistry({
    filePath: path.join(root, 'restic-repositories.json'),
    localRepoBase: path.join(root, 'repos'),
    masterKey,
    serverExists: async (id) => id === srvId,
    resticManager,
  });
  await resticRepositoryRegistry.init();
  const repo = await resticRepositoryRegistry.createRepository({
    serverId: srvId,
    name: `website-${siteId}`,
    backend: 'local',
    password: 't900_repo_secret_password',
  });
  await resticRepositoryRegistry.initResticRepository(repo.id);

  // Real SQLite site database + dump/restore
  const siteDbPath = path.join(root, 'site-db.sqlite3');
  const siteDb = new DatabaseSync(siteDbPath);
  t.after(() => siteDb.close());
  siteDb.exec('CREATE TABLE yp_native_proof (id INTEGER PRIMARY KEY, value TEXT NOT NULL);');
  siteDb.prepare('INSERT INTO yp_native_proof (id, value) VALUES (1, ?)').run('ORIGINAL-SQL-PROOF');

  const dumpToFile = async ({ outputPath }) => {
    const rows = siteDb.prepare('SELECT id, value FROM yp_native_proof ORDER BY id ASC').all();
    await writeFile(outputPath, JSON.stringify(rows), { mode: 0o600, flag: 'wx' });
  };
  const restoreFromFile = async ({ dumpPath }) => {
    const rows = JSON.parse(await readFile(dumpPath, 'utf8'));
    siteDb.exec('CREATE TABLE IF NOT EXISTS yp_native_proof (id INTEGER PRIMARY KEY, value TEXT NOT NULL); DELETE FROM yp_native_proof;');
    const ins = siteDb.prepare('INSERT INTO yp_native_proof (id, value) VALUES (?, ?)');
    for (const r of rows) ins.run(r.id, r.value);
  };
  const databaseBackupAdapter = createWebsiteDatabaseBackupAdapter({
    databaseManager: {
      inspect: async () => ({ engine: 'mariadb', version: '10.11', databases: [{ name: 't900_site_db' }] }),
      dropDatabase: async () => { siteDb.exec('DELETE FROM yp_native_proof;'); },
    },
    dumpManagerFactory: (opts) => createDatabaseDumpManager({ ...opts, dumpToFile }),
    restoreManagerFactory: (opts) => createDatabaseRestoreManager({ ...opts, dumpToFile, restoreFromFile }),
  });

  // Real mail SQLite + real Maildir data on disk (mapped from canonical /var/lib/yunpanel/mail/<hostname>)
  const canonicalMailBase = '/var/lib/yunpanel';
  const liveMailBase = path.join(root, 'live-vmail', 'var', 'lib', 'yunpanel');
  const canonicalDomainDir = `/var/lib/yunpanel/mail/${hostname}`;
  const mapMailPath = (value) => (value === canonicalMailBase || value.startsWith(`${canonicalMailBase}/`)
    ? path.join(liveMailBase, value.slice(canonicalMailBase.length + (value === canonicalMailBase ? 0 : 1)))
    : value);
  const liveDomainDir = mapMailPath(canonicalDomainDir);
  await mkdir(path.join(liveDomainDir, 'beta', 'Maildir', 'cur'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(liveDomainDir, 'beta', 'Maildir', 'new'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(liveDomainDir, 'beta', 'Maildir', 'tmp'), { recursive: true, mode: 0o700 });
  await chmod(mapMailPath('/var/lib/yunpanel/mail'), 0o700);
  await chmod(liveDomainDir, 0o700);
  await chmod(path.join(liveDomainDir, 'beta'), 0o700);
  await chmod(path.join(liveDomainDir, 'beta', 'Maildir'), 0o700);
  await chmod(path.join(liveDomainDir, 'beta', 'Maildir', 'cur'), 0o700);
  await chmod(path.join(liveDomainDir, 'beta', 'Maildir', 'new'), 0o700);
  await chmod(path.join(liveDomainDir, 'beta', 'Maildir', 'tmp'), 0o700);

  const rfc822Path = path.join(liveDomainDir, 'beta', 'Maildir', 'cur', '1794500027.M829822P3213862.test,S=120:2,');
  const rfc822Content = `From: sender@example.test\r\nTo: beta@${hostname}\r\nSubject: OWNED-NATIVE-T900\r\n\r\nUnique RFC822 message body ${siteId}\r\n`;
  await writeFile(rfc822Path, rfc822Content, { mode: 0o600 });
  const rfc822Sha256 = createHash('sha256').update(rfc822Content).digest('hex');

  const currentUid = process.getuid?.() ?? 5000;
  const currentGid = process.getgid?.() ?? 5000;
  const vmailUid = currentUid === 0 ? 5000 : currentUid;
  const vmailGid = currentGid === 0 ? 5000 : currentGid;

  const mappedFs = {
    chmodFn: (v, m) => chmod(mapMailPath(v), m),
    chownFn: async () => {},
    lstatFn: async (v) => {
      const md = await lstat(mapMailPath(v));
      if (v === '/var/lib/yunpanel/mail' || v.startsWith('/var/lib/yunpanel/mail/')) {
        return {
          ...md,
          uid: vmailUid,
          gid: vmailGid,
          isDirectory: () => md.isDirectory(),
          isFile: () => md.isFile(),
          isSymbolicLink: () => md.isSymbolicLink(),
        };
      }
      return md;
    },
    mkdirFn: (v, opts) => mkdir(mapMailPath(v), opts),
    openFn: (v, flags, mode) => open(mapMailPath(v), flags, mode),
    readdirFn: (v, opts) => readdir(mapMailPath(v), opts),
    renameFn: (src, dst) => rename(mapMailPath(src), mapMailPath(dst)),
    rmFn: (v, opts) => rm(mapMailPath(v), opts),
    rmdirFn: (v) => rmdir(mapMailPath(v)),
  };

  async function computeLiveDomainSnapshot(targetDir) {
    const hash = createHash('sha256');
    let bytes = 0;
    async function walk(cur, rel) {
      const md = await lstat(cur);
      if (md.isDirectory()) {
        hash.update(`d:${rel}\n`);
        const entries = await readdir(cur, { withFileTypes: true });
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) await walk(path.join(cur, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
      } else if (md.isFile()) {
        const buf = await readFile(cur);
        bytes += buf.length;
        hash.update(`f:${rel}:${buf.length}:${createHash('sha256').update(buf).digest('hex')}\n`);
      }
    }
    try {
      await walk(targetDir, '');
      return { present: true, bytes, snapshotSha256: hash.digest('hex') };
    } catch (err) {
      if (err?.code === 'ENOENT') return { present: false, bytes: 0, snapshotSha256: '0'.repeat(64) };
      throw err;
    }
  }

  const mailDataInspector = {
    async inspectDomain(domainName) {
      assert.equal(domainName, hostname);
      const snap = await computeLiveDomainSnapshot(liveDomainDir);
      return { version: 1, scope: 'domain', identity: domainName, dataPath: canonicalDomainDir, ...snap, sideEffects: false };
    },
    async inspectMailbox(address) {
      const localPart = String(address).split('@')[0];
      const snap = await computeLiveDomainSnapshot(path.join(liveDomainDir, localPart));
      return { version: 1, scope: 'mailbox', identity: address, dataPath: `${canonicalDomainDir}/${localPart}`, ...snap, sideEffects: false };
    },
  };

  const mailDomainRegistry = {
    getMailDomain: async (id) => (id === mailDomId ? { ...mailDomain } : null),
    listMailDomains: async () => [{ ...mailDomain }],
    transitionLocalStatus: async (id, { expectedRevision, status }) => {
      assert.equal(id, mailDomId);
      assert.equal(expectedRevision, mailDomain.revision);
      mailDomain = { ...mailDomain, status, revision: mailDomain.revision + 1 };
      return { ...mailDomain };
    },
  };
  const mailboxRegistry = createMailboxRegistry({
    filePath: path.join(root, 'mailboxes.json'),
    masterKey,
    getMailDomain: mailDomainRegistry.getMailDomain,
  });
  await mailboxRegistry.init();
  const betaMailbox = await mailboxRegistry.createMailbox({
    mailDomainId: mailDomId,
    address: `beta@${hostname}`,
    password: 'original_beta_imap_password_123',
  });
  const mailboxQuotaRegistry = createMailboxQuotaRegistry({ getMailbox: mailboxRegistry.getMailbox });
  const mailboxForwardingRegistry = createMailboxForwardingRegistry({ getMailbox: mailboxRegistry.getMailbox });
  const mailAliasRegistry = createMailAliasRegistry({ getMailDomain: mailDomainRegistry.getMailDomain, listMailboxes: mailboxRegistry.listMailboxes });
  const mailConfigurationService = createMailConfigurationService({
    mailDomainRegistry,
    mailboxRegistry,
    mailAliasRegistry,
    mailboxQuotaRegistry,
    mailboxForwardingRegistry,
  });
  const virtualMailSqlPath = path.join(root, 'virtual-mail.sqlite3');
  const virtualMailDb = new DatabaseSync(virtualMailSqlPath);
  t.after(() => virtualMailDb.close());
  await chmod(virtualMailSqlPath, 0o600);

  async function syncVirtualMailSql() {
    const input = { mailDomainId: mailDomId, expectedRevision: mailDomain.revision, status: mailDomain.status };
    const preview = await mailConfigurationService.previewCurrent(input);
    const bundle = await mailConfigurationService.materializeCurrent(input, { expectedConfigurationSha256: preview.configurationSha256 });
    virtualMailDb.exec(bundle.sensitiveArtifacts.find((item) => item.path === mailSqlTemplatePolicy.seedPath).content);
  }
  await syncVirtualMailSql();

  let stagedMailBundle = null;
  const mailBackupAdapter = createWebsiteMailBackupAdapter({
    domainRegistry: { getDomain: async (id) => (id === webDomId ? webDomain : null) },
    mailDomainRegistry,
    mailboxRegistry,
    mailAliasRegistry,
    mailboxQuotaRegistry,
    mailboxForwardingRegistry,
    mailConfigurationService,
    codec: createWebsiteResourceBackupCodec({ masterKey }),
    sqlPath: virtualMailSqlPath,
    mailDataInspector,
    dataBackupFactory: ({ backupRoot, mailDataInspector: inspectorRef }) => createMailDataBackupManager({
      backupRoot,
      mailDataInspector: inspectorRef,
      lstatFn: mappedFs.lstatFn,
      openFn: mappedFs.openFn,
      readdirFn: mappedFs.readdirFn,
    }),
    dataRestoreFactory: ({ backupManager, mailDataInspector: inspectorRef }) => createMailDataRestoreManager({
      backupManager,
      mailDataInspector: inspectorRef,
      receiptDirectory: path.join(root, 'mail-restore-receipts'),
      run: async () => ({ stdout: `vmail:x:${vmailUid}:${vmailGid}::/var/lib/yunpanel/mail:/usr/sbin/nologin\n`, stderr: '' }),
      ...mappedFs,
    }),
    accessGuard: { quiesce: async () => ({ accessDisabled: true, sessionsCleared: true }) },
    configManager: { stageConfiguration: async (_preview, options) => { stagedMailBundle = options; } },
    backupManager: { backupConfiguration: async () => ({ planSha256: 'plan-ok' }) },
    activator: {
      activateConfiguration: async (preview) => {
        virtualMailDb.exec(stagedMailBundle.sensitiveArtifacts.find((item) => item.path === mailSqlTemplatePolicy.seedPath).content);
        return { applied: true, sideEffects: true, previewSha256: preview.sha256, planSha256: 'plan-ok' };
      },
    },
  });

  // Real Application Environment Registry with protected webhook secret
  const applicationEnvironmentRegistry = createApplicationEnvironmentRegistry({
    filePath: path.join(root, 'app-env.json'),
    masterKey,
    applicationExists: async (id) => id === appId,
  });
  const environmentBackupAdapter = createWebsiteEnvironmentBackupAdapter({
    applicationRegistry: { getApplication: async (id) => (id === appId ? application : null) },
    applicationEnvironmentRegistry,
    codec: createWebsiteResourceBackupCodec({ masterKey }),
  });

  // Real HTTP server serving documentRoot + real WebsiteHttpHealthInspector
  const siteHttpServer = http.createServer(async (req, res) => {
    if (healthStatusOverride !== null) {
      res.writeHead(healthStatusOverride, { 'content-type': 'text/plain' });
      res.end('unhealthy');
      return;
    }
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const targetFile = path.join(documentRoot, path.posix.normalize(reqUrl.pathname).replace(/^\/+/, ''));
    try {
      const content = await readFile(targetFile, 'utf8');
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(content);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise((resolve) => siteHttpServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    siteHttpServer.closeAllConnections();
    siteHttpServer.close();
    await once(siteHttpServer, 'close');
  });
  const sitePort = siteHttpServer.address().port;
  const healthInspector = createWebsiteHttpHealthInspector({
    retryDelayMs: 50,
    requestTimeoutMs: 500,
    request: ({ primaryDomain, healthPath, timeoutMs }) => new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: sitePort, path: healthPath, method: 'GET', timeout: timeoutMs, headers: { host: primaryDomain, connection: 'close' } },
        (res) => {
          res.resume();
          const code = res.statusCode ?? 0;
          resolve({ reachable: true, healthy: code >= 200 && code < 300, statusCode: code });
        },
      );
      req.on('timeout', () => { req.destroy(); resolve({ reachable: false, healthy: false, statusCode: null }); });
      req.on('error', () => resolve({ reachable: false, healthy: false, statusCode: null }));
      req.end();
    }),
  });

  const dbBackupDir = path.join(stagedRoot, 'databases', `website-${dbBindId}`);
  const mailDataStagedDir = path.join(stagedRoot, 'mail-data', `website-${mailDomId}`);
  const mailVirtualSnapshot = path.join(stagedRoot, 'mail', `${hostname}-virtual.json`);
  const envMetadataPath = path.join(stagedRoot, 'env-metadata.json');

  const buildBackupSet = () => {
    const payload = {
      website: { id: siteId, serverId: srvId, applicationId: appId, name: hostname, primaryDomain: hostname },
      stagedRoot,
      files: { targetPaths: [documentRoot] },
      targetPaths: [documentRoot, stagedRoot],
      excludePatterns: [],
      tags: [`website:${siteId}`, `server:${srvId}`],
      databases: [{
        bindingId: dbBindId,
        databaseName: 't900_site_db',
        dumpHook: { stagedBackupDirectory: dbBackupDir, stagedDumpPath: path.join(dbBackupDir, 'dump.sql') },
      }],
      mail: [{
        mailDomainId: mailDomId,
        domainName: hostname,
        webDomainId: webDomId,
        managementMode: 'local',
        storagePath: canonicalDomainDir,
        virtualMailDbSnapshot: mailVirtualSnapshot,
        stagedDataDirectory: mailDataStagedDir,
      }],
      env: { stagedMetadataPath: envMetadataPath },
    };
    const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return { ...payload, digest };
  };

  const websiteRegistry = { getWebsite: async (id) => (id === siteId ? { ...website } : null) };
  const websiteBackupSetProvider = { getWebsiteBackupSet: async () => buildBackupSet() };

  const websiteBackupService = createWebsiteBackupService({
    websiteRegistry,
    resticRepositoryRegistry,
    resticManager,
    websiteBackupSetProvider,
    localServerId: srvId,
    databaseBackupAdapter,
    mailBackupAdapter,
    environmentBackupAdapter,
  });

  const receiptStore = createWebsiteRestoreReceiptStore({ root: path.join(root, 'restore-receipts') });
  const websiteRestoreService = createWebsiteRestoreService({
    websiteRegistry,
    resticRepositoryRegistry,
    resticManager,
    websiteBackupSetProvider,
    healthInspector,
    localServerId: srvId,
    receiptStore,
    websiteBackupService,
    databaseBackupAdapter,
    mailBackupAdapter,
    environmentBackupAdapter,
  });

  const operationRegistry = createWebsiteBackupOperationRegistry({ filePath: path.join(root, 'backup-operations.json') });
  const operationService = createWebsiteBackupOperationService({
    registry: operationRegistry,
    websiteBackupService,
    websiteRestoreService,
    resticRepositoryRegistry,
    resticManager,
    websiteRegistry,
    websiteBackupSetProvider,
    siteMutationLock: { withSiteLock: async (_scope, fn) => fn() },
    jobRegistry: {
      listJobs: async () => [],
      enqueue: async (job) => ({ id: randomUUID(), ...job, status: 'queued' }),
      getJob: async () => ({ status: 'running' }),
    },
    durableJobRegistry: {},
    localServerId: srvId,
    authorizeActor: async (actor) => actor,
  });

  return {
    root,
    srvId,
    siteId,
    appId,
    repo,
    hostname,
    documentRoot,
    stagedRoot,
    siteDb,
    virtualMailDb,
    mailboxRegistry,
    betaMailbox,
    syncVirtualMailSql,
    verifyMailboxPassword,
    rfc822Path,
    rfc822Content,
    rfc822Sha256,
    applicationEnvironmentRegistry,
    websiteBackupService,
    websiteRestoreService,
    operationRegistry,
    operationService,
    setHealthStatusOverride: (val) => { healthStatusOverride = val; },
  };
}

test('compound backup & restore restores files, SQLite rows, unique RFC822 mail message SHA256/bytes, mailbox auth, and protected webhook secret across two independent owned fixtures (T900)', async (t) => {
  const { createHash } = await import('node:crypto');
  const { readFile, rm, stat, writeFile } = await import('node:fs/promises');
  const path = await import('node:path');

  for (let runIndex = 0; runIndex < 2; runIndex += 1) {
    const fx = await createRealCompoundRestoreFixture(t);
    const markerName = `native-restore-proof-run-${runIndex}.txt`;
    const markerPath = path.join(fx.documentRoot, markerName);
    const originalFileContent = `NATIVE-RESTORE-ORIGINAL-${runIndex}`;
    await writeFile(markerPath, originalFileContent, { mode: 0o640 });

    const webhookBeforeSecret = `whsec_before_${runIndex}_1234567890abcdefghijklmnop`;
    const webhookAfterSecret = `whsec_after_${runIndex}_9876543210zyxwvutsrqponmlkj`;
    await fx.applicationEnvironmentRegistry.setWebhookSecret({ applicationId: fx.appId, secret: webhookBeforeSecret });
    const envBefore = await fx.applicationEnvironmentRegistry.webhookSecret(fx.appId);

    const backupPreview = await fx.websiteBackupService.previewBackup({ websiteId: fx.siteId, repositoryId: fx.repo.id });
    const backupRes = await fx.websiteBackupService.executeBackup({
      websiteId: fx.siteId,
      repositoryId: fx.repo.id,
      expectedPreviewDigest: backupPreview.backupSetDigest,
      confirmation: backupPreview.confirmation,
    });
    assert.equal(backupRes.status, 'succeeded');
    const snapId = backupRes.snapshot.snapshotId;

    // Mutate all 4 domains after Snapshot 1 (identical to 13-native-source-mutation.spec.js)
    await rm(fx.rfc822Path, { force: true });
    await writeFile(markerPath, `CHANGED-FILE-${runIndex}`, { mode: 0o640 });
    fx.siteDb.prepare('UPDATE yp_native_proof SET value = ? WHERE id = 1').run(`CHANGED-SQL-${runIndex}`);
    const rotated = await fx.mailboxRegistry.rotatePassword(fx.betaMailbox.id, {
      expectedRevision: fx.betaMailbox.revision,
      password: 'changed_beta_imap_password_999',
    });
    assert.ok(rotated.revision > fx.betaMailbox.revision);
    await fx.syncVirtualMailSql();
    await fx.applicationEnvironmentRegistry.setWebhookSecret({ applicationId: fx.appId, secret: webhookAfterSecret });

    // Execute compound restore
    const include = ['paths', 'databases', 'mail', 'environment'];
    const restorePreview = await fx.websiteRestoreService.previewRestore({
      websiteId: fx.siteId,
      repositoryId: fx.repo.id,
      snapshotId: snapId,
      healthPath: `/${markerName}`,
      timeoutSeconds: 5,
      include,
    });
    const restoreRes = await fx.websiteRestoreService.executeRestore({
      websiteId: fx.siteId,
      repositoryId: fx.repo.id,
      snapshotId: snapId,
      expectedPreviewDigest: restorePreview.previewDigest,
      confirmation: restorePreview.confirmation,
      healthPath: `/${markerName}`,
      timeoutSeconds: 5,
      include,
      operationId: fx.siteId,
    });

    assert.equal(restoreRes.status, 'succeeded');
    assert.equal(await readFile(markerPath, 'utf8'), originalFileContent);
    assert.equal(fx.siteDb.prepare('SELECT value FROM yp_native_proof WHERE id = 1').get().value, 'ORIGINAL-SQL-PROOF');

    const restoredMsg = await readFile(fx.rfc822Path);
    assert.equal(restoredMsg.length, Buffer.byteLength(fx.rfc822Content));
    assert.equal(createHash('sha256').update(restoredMsg).digest('hex'), fx.rfc822Sha256);

    const livePwHash = fx.virtualMailDb.prepare('SELECT password FROM virtual_mailboxes WHERE address = ?').get(fx.betaMailbox.address).password;
    assert.equal(await fx.verifyMailboxPassword('original_beta_imap_password_123', livePwHash.replace(/^\{ARGON2ID\}/, '')), true);
    assert.equal(await fx.verifyMailboxPassword('changed_beta_imap_password_999', livePwHash.replace(/^\{ARGON2ID\}/, '')), false);

    assert.equal(await fx.applicationEnvironmentRegistry.materializeWebhookSecret(fx.appId), webhookBeforeSecret);
    assert.deepEqual(await fx.applicationEnvironmentRegistry.webhookSecret(fx.appId), envBefore);

    // Staged root must be cleaned after restore so no residual Maildir/SQL/env artifacts remain
    await assert.rejects(stat(fx.stagedRoot), { code: 'ENOENT' });
  }
});

test('compound restore rollback cleans stagedRoot so deleted-message pre-restore never hits mail_data_backup_corrupt, and operation error exposes only safe phase/sub-error codes without secret or cause leaks (T900)', async (t) => {
  const { randomUUID } = await import('node:crypto');
  const { lstat, readFile, rm, writeFile } = await import('node:fs/promises');
  const path = await import('node:path');

  const fx = await createRealCompoundRestoreFixture(t);
  const markerName = 'native-rollback-proof.txt';
  const markerPath = path.join(fx.documentRoot, markerName);
  await writeFile(markerPath, 'ORIGINAL-BEFORE-SNAPSHOT', { mode: 0o640 });
  const webhookBeforeSecret = 'whsec_rollback_before_1234567890abcdef';
  const webhookAfterSecret = 'whsec_rollback_after_9876543210fedcba';
  await fx.applicationEnvironmentRegistry.setWebhookSecret({ applicationId: fx.appId, secret: webhookBeforeSecret });

  const backupPreview = await fx.websiteBackupService.previewBackup({ websiteId: fx.siteId, repositoryId: fx.repo.id });
  const backupRes = await fx.websiteBackupService.executeBackup({
    websiteId: fx.siteId,
    repositoryId: fx.repo.id,
    expectedPreviewDigest: backupPreview.backupSetDigest,
    confirmation: backupPreview.confirmation,
  });
  const snapId = backupRes.snapshot.snapshotId;

  // Live state after Snapshot 1: message deleted, file/SQL/password/webhook mutated
  await rm(fx.rfc822Path, { force: true });
  await writeFile(markerPath, 'LIVE-POST-BACKUP-CONTENT', { mode: 0o640 });
  fx.siteDb.prepare('UPDATE yp_native_proof SET value = ? WHERE id = 1').run('LIVE-POST-BACKUP-SQL');
  await fx.mailboxRegistry.rotatePassword(fx.betaMailbox.id, {
    expectedRevision: fx.betaMailbox.revision,
    password: 'live_post_backup_password_456',
  });
  await fx.syncVirtualMailSql();
  await fx.applicationEnvironmentRegistry.setWebhookSecret({ applicationId: fx.appId, secret: webhookAfterSecret });

  // Force health check to return 502 so forward restore extracts 1-message snapshot into stagedRoot and then enters rollback()
  fx.setHealthStatusOverride(502);
  const include = ['paths', 'databases', 'mail', 'environment'];
  const restorePreview = await fx.websiteRestoreService.previewRestore({
    websiteId: fx.siteId,
    repositoryId: fx.repo.id,
    snapshotId: snapId,
    healthPath: `/${markerName}`,
    timeoutSeconds: 5,
    include,
  });

  const actor = { userId: randomUUID(), sessionId: randomUUID(), role: 'owner' };
  const queuedOp = await fx.operationService.queueRestore({
    websiteId: fx.siteId,
    repositoryId: fx.repo.id,
    snapshotId: snapId,
    expectedPreviewDigest: restorePreview.previewDigest,
    confirmation: restorePreview.confirmation,
    healthPath: `/${markerName}`,
    timeoutSeconds: 5,
    include,
    actor,
  });
  await fx.operationService.execute(
    {
      operationId: queuedOp.id,
      websiteId: fx.siteId,
      actorSessionId: actor.sessionId,
      actorUserId: actor.userId,
      actorRole: actor.role,
    },
    { serverId: fx.srvId, resourceType: 'backup', resourceId: queuedOp.id, jobId: queuedOp.jobId },
  );

  const rolledBackOp = await fx.operationService.getOperation(queuedOp.id);
  assert.equal(rolledBackOp.status, 'rolled_back');
  assert.equal(rolledBackOp.result.rollbackReason, 'health_check_failed');
  assert.equal(rolledBackOp.result.failurePhase, 'health_check');

  // Verify live post-backup state was cleanly restored by rollback (0 messages, post-backup file/SQL/password/webhook)
  await assert.rejects(lstat(fx.rfc822Path), { code: 'ENOENT' });
  assert.equal(await readFile(markerPath, 'utf8'), 'LIVE-POST-BACKUP-CONTENT');
  assert.equal(fx.siteDb.prepare('SELECT value FROM yp_native_proof WHERE id = 1').get().value, 'LIVE-POST-BACKUP-SQL');
  const livePwHash = fx.virtualMailDb.prepare('SELECT password FROM virtual_mailboxes WHERE address = ?').get(fx.betaMailbox.address).password;
  assert.equal(await fx.verifyMailboxPassword('live_post_backup_password_456', livePwHash.replace(/^\{ARGON2ID\}/, '')), true);
  assert.equal(await fx.applicationEnvironmentRegistry.materializeWebhookSecret(fx.appId), webhookAfterSecret);
});

test('restore_rollback_failed separates safe phase and sub-error codes while never leaking secrets, paths, or raw error.cause (T900)', async (t) => {
  const { randomUUID } = await import('node:crypto');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createWebsiteBackupOperationRegistry } = await import('../src/website-backup-operation-registry.js');
  const { createWebsiteBackupOperationService } = await import('../src/website-backup-operation-service.js');

  const root = await mkdtemp(path.join(os.tmpdir(), 'yp-t900-safe-codes-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const f = fixture();
  f.backupSet.stagedRoot = path.join(root, 'staged');
  f.backupSet.targetPaths.push(f.backupSet.stagedRoot);
  f.backupSet.env = { stagedMetadataPath: path.join(f.backupSet.stagedRoot, 'env-metadata.json') };
  f.backupSet.mail = [{
    mailDomainId: randomUUID(),
    domainName: 'example.com',
    webDomainId: randomUUID(),
    managementMode: 'local',
    storagePath: '/var/lib/yunpanel/mail/example.com',
    virtualMailDbSnapshot: path.join(f.backupSet.stagedRoot, 'mail', 'example.com-virtual.json'),
    stagedDataDirectory: path.join(f.backupSet.stagedRoot, 'mail-data', 'website-mail'),
  }];
  f.snapshots[0].paths = [...f.backupSet.targetPaths];

  const leakedSecret = 'SUPER_PRIVATE_SECRET_DO_NOT_LEAK_778899';
  const leakedPath = '/var/lib/yunpanel/private-secret-path/credentials.json';

  const service = createWebsiteRestoreService({
    websiteRegistry: { async getWebsite(id) { return id === websiteId ? f.website : null; } },
    resticRepositoryRegistry: {
      async getRepository(id) { return id === repositoryId ? f.repository : null; },
      async revealPassword() { return 'super_secret_password'; },
    },
    resticManager: {
      async listSnapshots() { return f.snapshots; },
      async createSnapshot() { return { snapshotId: preRestoreSnapshotId }; },
      async listSnapshotFiles() {
        return [
          { type: 'file', path: '/var/lib/yunpanel/apps/test/current/marker.txt', size: 4 },
          { type: 'file', path: '/var/lib/yunpanel/data/test/marker.txt', size: 4 },
          { type: 'file', path: f.backupSet.env.stagedMetadataPath, size: 12 },
          { type: 'file', path: f.backupSet.mail[0].virtualMailDbSnapshot, size: 12 },
          { type: 'dir', path: f.backupSet.mail[0].stagedDataDirectory, size: 0 },
          { type: 'file', path: path.posix.join(f.backupSet.mail[0].stagedDataDirectory, 'manifest.json'), size: 12 },
        ];
      },
      async restore() { return { stdout: 'restored' }; },
    },
    websiteBackupSetProvider: { async getWebsiteBackupSet() { return f.backupSet; } },
    healthInspector: { async inspect() { return { satisfied: true, statusCode: 200, attempts: 1 }; } },
    localServerId: serverId,
    receiptStore: {
      async read() { return null; },
      async write(val) { return val; },
    },
    mailBackupAdapter: {
      async restore({ rollback = false }) {
        if (rollback) {
          throw Object.assign(
            new Error(`Rollback failed at ${leakedPath} with ${leakedSecret}`),
            { code: 'mail_data_backup_corrupt', cause: new Error(leakedSecret) },
          );
        }
        return [];
      },
    },
    environmentBackupAdapter: {
      async assertSupported() {},
      async restore({ rollback = false }) {
        if (!rollback) {
          throw Object.assign(
            new Error(`Env decode failed at ${leakedPath} with ${leakedSecret}`),
            { code: 'environment_backup_invalid', cause: new Error(leakedSecret) },
          );
        }
        return [];
      },
    },
  });

  const opRegistry = createWebsiteBackupOperationRegistry({ filePath: path.join(root, 'ops.json') });
  const opService = createWebsiteBackupOperationService({
    registry: opRegistry,
    websiteBackupService: { previewBackup: async () => ({}) },
    websiteRestoreService: service,
    resticRepositoryRegistry: { getRepository: async () => f.repository },
    resticManager: {},
    websiteRegistry: { getWebsite: async () => f.website },
    websiteBackupSetProvider: { getWebsiteBackupSet: async () => f.backupSet },
    siteMutationLock: { withSiteLock: async (_scope, fn) => fn() },
    jobRegistry: {
      listJobs: async () => [],
      enqueue: async (job) => ({ id: randomUUID(), ...job, status: 'queued' }),
      getJob: async () => ({ status: 'running' }),
    },
    durableJobRegistry: {},
    localServerId: serverId,
    authorizeActor: async (actor) => actor,
  });

  const preview = await service.previewRestore({ websiteId, repositoryId, snapshotId });
  const actor = { userId: randomUUID(), sessionId: randomUUID(), role: 'owner' };
  const queued = await opService.queueRestore({
    websiteId,
    repositoryId,
    snapshotId,
    expectedPreviewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
    actor,
  });

  let thrown = null;
  await assert.rejects(
    async () => {
      try {
        await opService.execute(
          {
            operationId: queued.id,
            websiteId,
            actorSessionId: actor.sessionId,
            actorUserId: actor.userId,
            actorRole: actor.role,
          },
          { serverId, resourceType: 'backup', resourceId: queued.id, jobId: queued.jobId },
        );
      } catch (err) {
        thrown = err;
        throw err;
      }
    },
    { code: 'restore_rollback_failed' },
  );

  assert.equal(thrown.cause, undefined);
  assert.equal(thrown.details?.failurePhase, 'environment_restore');
  assert.equal(thrown.details?.restoreErrorCode, 'environment_backup_invalid');
  assert.equal(thrown.details?.rollbackPhase, 'rollback_mail');
  assert.equal(thrown.details?.rollbackErrorCode, 'mail_data_backup_corrupt');
  assert.doesNotMatch(JSON.stringify(thrown.details), new RegExp(`${leakedSecret}|private-secret-path`));

  const publicView = await opService.getOperation(queued.id);
  assert.equal(publicView.status, 'failed');
  assert.deepEqual(publicView.error, {
    code: 'restore_rollback_failed',
    message: 'İşlem tamamlanamadı; kayıtlı hata ve geri alma durumunu kontrol edin',
    phase: 'environment_restore',
    restoreErrorCode: 'environment_backup_invalid',
    rollbackPhase: 'rollback_mail',
    rollbackErrorCode: 'mail_data_backup_corrupt',
  });
  assert.doesNotMatch(JSON.stringify(publicView), new RegExp(`${leakedSecret}|private-secret-path`));
});
