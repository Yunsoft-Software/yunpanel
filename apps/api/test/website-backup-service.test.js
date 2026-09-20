import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WebsiteBackupError,
  createWebsiteBackupService,
  isWebsiteBackupError,
} from '../src/website-backup-service.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const otherServerId = 'd0bc7f95-bdbd-4375-904f-50c532fc3faa';
const websiteId = '2c387b02-8747-458a-b509-8f531d4d149e';
const notFoundWebsiteId = '00000000-0000-4000-8000-000000000000';
const repositoryId = '91a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c';
const notFoundRepoId = '11111111-2222-4333-8444-555555555555';

function fixture({
  activeJobs = [],
  dumpFails = false,
  composePauseFails = false,
  snapshotFails = false,
  overrideBackupSet = {},
} = {}) {
  const calls = {
    commands: [],
    mkdir: [],
    writeFile: [],
    readFile: [],
    rm: [],
    createSnapshot: [],
  };

  const website = {
    id: websiteId,
    serverId,
    name: 'TestApp',
    primaryDomain: 'example.com',
    runtimeType: 'node',
  };

  const repository = {
    id: repositoryId,
    serverId,
    name: 'default_repo',
    target: '/var/lib/yunpanel/backups/restic/repos/default_repo',
  };

  const backupSet = {
    version: 1,
    digest: 'sha256-abc123def456',
    targetPaths: ['/var/lib/yunpanel/apps/test/current', '/var/lib/yunpanel/data/test'],
    excludePatterns: ['**/tmp/**'],
    tags: [`website:${websiteId}`, `server:${serverId}`],
    stagedRoot: '/var/lib/yunpanel/tmp/backup-staging-test',
    databases: [
      {
        databaseName: 'app_db',
        dumpHook: {
          program: 'mariadb-dump',
          args: ['--single-transaction', 'app_db'],
          stagedDumpPath: '/var/lib/yunpanel/tmp/backup-staging-test/databases/app_db.sql',
        },
      },
    ],
    env: {
      stagedMetadataPath: '/var/lib/yunpanel/tmp/backup-staging-test/env/environment.json',
      variables: { NODE_ENV: 'production' },
    },
    nginxConfig: [
      {
        configPath: '/etc/nginx/sites-available/example.com.conf',
        stagedConfigPath: '/var/lib/yunpanel/tmp/backup-staging-test/nginx/example.com.conf',
      },
    ],
    dnsRecords: [
      {
        domain: 'example.com',
        stagedZonePath: '/var/lib/yunpanel/tmp/backup-staging-test/dns/example.com.json',
      },
    ],
    composeHooks: {
      enabled: true,
      preHook: {
        command: 'docker',
        args: ['compose', '-p', 'site_proj', 'pause'],
      },
      postHook: {
        command: 'docker',
        args: ['compose', '-p', 'site_proj', 'unpause'],
      },
    },
    ...overrideBackupSet,
  };

  const service = createWebsiteBackupService({
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
        return id === repositoryId ? 'test_repo_secret_pass' : null;
      },
    },
    resticManager: {
      async createSnapshot(args) {
        calls.createSnapshot.push(args);
        if (snapshotFails) {
          throw new Error('Restic snapshot failed');
        }
        return {
          snapshotId: 'snap-12345678',
          filesNew: 10,
          filesChanged: 2,
        };
      },
    },
    websiteBackupSetProvider: {
      async getWebsiteBackupSet() {
        return backupSet;
      },
    },
    jobRegistry: {
      async listJobs() {
        return activeJobs;
      },
    },
    localServerId: serverId,
    runCommand: async (cmd, args) => {
      calls.commands.push({ cmd, args });
      if (cmd === 'mariadb-dump' && dumpFails) {
        throw new Error('Database connection refused');
      }
      if (args.includes('pause') && composePauseFails) {
        throw new Error('Docker daemon not responding');
      }
      if (cmd === 'mariadb-dump') {
        return { stdout: '-- MariaDB dump 10.19\nCREATE TABLE test (id INT);' };
      }
      return { stdout: '' };
    },
    mkdirFn: async (dir, opts) => {
      calls.mkdir.push({ dir, opts });
    },
    writeFileFn: async (filePath, content, opts) => {
      calls.writeFile.push({ filePath, content, opts });
    },
    readFileFn: async (filePath) => {
      calls.readFile.push(filePath);
      return 'server { listen 80; }';
    },
    rmFn: async (targetPath, opts) => {
      calls.rm.push({ targetPath, opts });
    },
  });

  return { service, calls, website, repository, backupSet };
}

test('createWebsiteBackupService validation', () => {
  assert.throws(
    () => createWebsiteBackupService(),
    (err) => err instanceof WebsiteBackupError && err.code === 'website_backup_dependencies_invalid',
  );
  assert.throws(
    () => createWebsiteBackupService({ websiteRegistry: { getWebsite: () => {} } }),
    (err) => err instanceof WebsiteBackupError && err.code === 'website_backup_dependencies_invalid',
  );
});

test('previewBackup succeeds with expected contract', async () => {
  const { service, backupSet } = fixture();
  const preview = await service.previewBackup({
    websiteId,
    repositoryId,
  });

  assert.equal(preview.websiteId, websiteId);
  assert.equal(preview.websiteName, 'TestApp');
  assert.equal(preview.repositoryId, repositoryId);
  assert.equal(preview.backupSetDigest, backupSet.digest);
  assert.deepEqual(preview.databases, ['app_db']);
  assert.equal(preview.composeHooksEnabled, true);
  assert.equal(
    preview.confirmation,
    `backup:${websiteId}:${repositoryId}:${backupSet.digest}`,
  );
  assert.ok(Object.isFrozen(preview));
});

test('previewBackup throws if website not found', async () => {
  const { service } = fixture();
  await assert.rejects(
    service.previewBackup({ websiteId: notFoundWebsiteId, repositoryId }),
    (err) => err instanceof WebsiteBackupError && err.code === 'website_not_found' && err.status === 404,
  );
});

test('previewBackup throws if repository not found', async () => {
  const { service } = fixture();
  await assert.rejects(
    service.previewBackup({ websiteId, repositoryId: notFoundRepoId }),
    (err) => err instanceof WebsiteBackupError && err.code === 'repository_not_found' && err.status === 404,
  );
});

test('previewBackup throws 409 if website has active job conflict', async () => {
  const { service } = fixture({
    activeJobs: [{ status: 'running', resourceType: 'website', resourceId: websiteId }],
  });
  await assert.rejects(
    service.previewBackup({ websiteId, repositoryId }),
    (err) => err instanceof WebsiteBackupError && err.code === 'website_job_conflict' && err.status === 409,
  );
});

test('executeBackup executes pre-hooks, snapshot, and cleans up', async () => {
  const { service, calls, backupSet } = fixture();
  const confirmation = `backup:${websiteId}:${repositoryId}:${backupSet.digest}`;

  const result = await service.executeBackup({
    websiteId,
    repositoryId,
    expectedPreviewDigest: backupSet.digest,
    confirmation,
    tags: ['manual-trigger'],
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.websiteId, websiteId);
  assert.equal(result.repositoryId, repositoryId);
  assert.equal(result.snapshot.snapshotId, 'snap-12345678');
  assert.equal(result.backupSetDigest, backupSet.digest);

  // 1. Database dump executed
  assert.ok(calls.commands.some((c) => c.cmd === 'mariadb-dump'));
  // 2. Database dump written to staging
  assert.ok(calls.writeFile.some((w) => w.filePath.endsWith('app_db.sql')));
  // 3. Env metadata written
  assert.ok(calls.writeFile.some((w) => w.filePath.endsWith('environment.json')));
  // 4. Nginx config read and written to staging
  assert.ok(calls.readFile.some((f) => f.endsWith('example.com.conf')));
  assert.ok(calls.writeFile.some((w) => w.filePath.endsWith('example.com.conf')));
  // 5. DNS record written
  assert.ok(calls.writeFile.some((w) => w.filePath.endsWith('example.com.json')));
  // 6. Compose preHook (pause) run
  assert.ok(calls.commands.some((c) => c.args.includes('pause')));
  // 7. Restic createSnapshot run with combined tags
  assert.equal(calls.createSnapshot.length, 1);
  const snapArg = calls.createSnapshot[0];
  assert.equal(snapArg.password, 'test_repo_secret_pass');
  assert.ok(snapArg.tags.includes('manual-trigger'));
  assert.ok(snapArg.tags.includes(`website:${websiteId}`));
  // 8. Compose postHook (unpause) run in finally
  assert.ok(calls.commands.some((c) => c.args.includes('unpause')));
  // 9. Staging root cleaned up in finally
  assert.ok(calls.rm.some((r) => r.targetPath === backupSet.stagedRoot));
});

test('executeBackup fails when expectedPreviewDigest is stale', async () => {
  const { service, backupSet } = fixture();
  await assert.rejects(
    service.executeBackup({
      websiteId,
      repositoryId,
      expectedPreviewDigest: 'stale-digest',
      confirmation: `backup:${websiteId}:${repositoryId}:${backupSet.digest}`,
    }),
    (err) => err instanceof WebsiteBackupError && err.code === 'backup_preview_stale' && err.status === 409,
  );
});

test('executeBackup fails when confirmation does not match', async () => {
  const { service, backupSet } = fixture();
  await assert.rejects(
    service.executeBackup({
      websiteId,
      repositoryId,
      expectedPreviewDigest: backupSet.digest,
      confirmation: 'backup:invalid',
    }),
    (err) => err instanceof WebsiteBackupError && err.code === 'backup_confirmation_invalid' && err.status === 409,
  );
});

test('executeBackup database dump failure cleans up and does not take snapshot', async () => {
  const { service, calls, backupSet } = fixture({ dumpFails: true });
  const confirmation = `backup:${websiteId}:${repositoryId}:${backupSet.digest}`;

  await assert.rejects(
    service.executeBackup({
      websiteId,
      repositoryId,
      expectedPreviewDigest: backupSet.digest,
      confirmation,
    }),
    (err) => err instanceof WebsiteBackupError && err.code === 'backup_database_dump_failed' && err.status === 500,
  );

  assert.equal(calls.createSnapshot.length, 0);
  // Staging directory cleaned up even on failure
  assert.ok(calls.rm.some((r) => r.targetPath === backupSet.stagedRoot));
});

test('executeBackup compose pause failure cleans up and does not take snapshot', async () => {
  const { service, calls, backupSet } = fixture({ composePauseFails: true });
  const confirmation = `backup:${websiteId}:${repositoryId}:${backupSet.digest}`;

  await assert.rejects(
    service.executeBackup({
      websiteId,
      repositoryId,
      expectedPreviewDigest: backupSet.digest,
      confirmation,
    }),
    (err) => err instanceof WebsiteBackupError && err.code === 'backup_compose_quiesce_failed' && err.status === 500,
  );

  assert.equal(calls.createSnapshot.length, 0);
  // Staging directory cleaned up even on failure
  assert.ok(calls.rm.some((r) => r.targetPath === backupSet.stagedRoot));
});
