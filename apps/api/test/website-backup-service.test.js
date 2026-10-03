import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WebsiteBackupError,
  createWebsiteBackupService,
  isWebsiteBackupError,
} from '../src/website-backup-service.js';
import {
  createDisasterRecoveryScope,
  normalizeDisasterRecoveryScope,
  maskDisasterRecoverySecrets,
  DISASTER_RECOVERY_CATEGORIES,
} from '../src/backup-manifest.js';
import {
  verifyDisasterRecoveryRestore,
  BackupPlanError,
} from '../src/backup-plan.js';
import { createBackupResourceProvider } from '../src/backup-resource-provider.js';
import {
  sanitizeDisasterRecoveryRestoreResult,
  DatabaseRestoreJobResultError,
} from '../src/database-restore-job-result.js';

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

test('PROD-08 Service: disaster recovery scope creation compiles all 6 domains and masks sensitive secrets', () => {
  const scope = createDisasterRecoveryScope({
    serverId,
    websiteId,
    siteFiles: [
      {
        path: '/var/lib/yunpanel/websites/TestApp/public_html',
        fileCount: 42,
        totalBytes: 1048576,
        contentSha256: 'a'.repeat(64),
      },
    ],
    databases: [
      {
        databaseName: 'app_db',
        engine: 'mariadb',
        sizeBytes: 2097152,
        dumpSha256: 'b'.repeat(64),
      },
    ],
    mail: [
      {
        mailDomainId: 'domain-mail-1',
        domainName: 'example.com',
        storageBytes: 524288,
        snapshotSha256: 'c'.repeat(64),
      },
    ],
    configuration: [
      {
        kind: 'nginx',
        path: '/etc/nginx/sites-available/example.com.conf',
        checksum: 'd'.repeat(64),
      },
    ],
    panelRelationships: [
      {
        resourceType: 'role_grant',
        resourceId: 'grant-123',
        details: { role: 'owner', websiteId },
      },
    ],
    encryptionKeys: [
      {
        keyId: 'ssl-key-1',
        kind: 'tls_private_key',
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----',
        keyPassword: 'unmasked-pass-123',
      },
    ],
  });

  assert.equal(scope.version, 1);
  assert.equal(scope.serverId, serverId);
  assert.equal(scope.websiteId, websiteId);
  assert.deepEqual(scope.categories, DISASTER_RECOVERY_CATEGORIES);

  // Validate normalization
  const normalized = normalizeDisasterRecoveryScope(scope);
  assert.equal(normalized.scopeDigest, scope.scopeDigest);
  assert.equal(normalized.secretsMasked, true);

  // Validate secret masking
  const json = JSON.stringify(scope);
  assert.doesNotMatch(json, /-----BEGIN RSA PRIVATE KEY-----/);
  assert.doesNotMatch(json, /unmasked-pass-123/);
  assert.match(json, /\[REDACTED_PRIVATE_KEY\]/);
  assert.match(json, /\[REDACTED\]/);
});

test('PROD-08 Service: createBackupResourceProvider provides disasterRecoveryScope with server resources', async () => {
  const provider = createBackupResourceProvider({
    serverRegistry: {
      async getServer(id) {
        return id === serverId ? { id: serverId, name: 'primary' } : null;
      },
    },
    dockerComposeProjectRegistry: {
      async listProjects() { return []; },
    },
    applicationRegistry: {
      async listApplications() { return []; },
    },
    applicationEnvironmentRegistry: {
      async environmentStatus() { return { savedRevision: 1, appliedRevision: 1, appliedReleaseId: null }; },
    },
    websiteRegistry: {
      async listWebsites() { return [{ id: websiteId, serverId, name: 'TestApp' }]; },
    },
    databaseBindingRegistry: {
      async listBindings() { return []; },
    },
    loadDatabaseInventory: async () => ({
      engine: 'mariadb',
      version: '10.11.8',
      snapshot: {
        jobId: '1dff50cb-0840-413c-a9d1-d069f8e87743',
        refreshedAt: '2026-10-03T08:00:00.000Z',
      },
      databases: [{
        name: 'app_db',
        sizeBytes: 1024,
      }],
    }),
    mailDomainRegistry: {
      async listMailDomains() { return []; },
    },
    domainRegistry: {
      async getDomain() { return null; },
      async listDomains() { return []; },
    },
    mailDataOperationsService: {
      async previewBackup() { return { bytes: 0, snapshotSha256: '0'.repeat(64), files: 0 }; },
    },
  });

  assert.equal(typeof provider.disasterRecoveryScope, 'function');
  const scope = await provider.disasterRecoveryScope({
    serverId,
    websiteId,
    siteFiles: [{ path: '/var/lib/yunpanel/websites/TestApp', totalBytes: 1024 }],
    configuration: [{ kind: 'nginx', path: '/etc/nginx/sites-available/test.conf' }],
    panelRelationships: [{ resourceType: 'owner', resourceId: 'user-1' }],
    encryptionKeys: [{ keyId: 'key-1', privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----' }],
  });

  assert.equal(scope.serverId, serverId);
  assert.equal(scope.websiteId, websiteId);
  assert.deepEqual(scope.categories, DISASTER_RECOVERY_CATEGORIES);
  assert.equal(scope.secretsMasked, true);
  assert.equal(scope.encryptionKeys[0].privateKey, '[REDACTED_PRIVATE_KEY]');
  assert.equal(scope.database.length, 1);
  assert.equal(scope.database[0].databaseName, 'app_db');
});

test('PROD-08 Service: verifyDisasterRecoveryRestore validates empty authorized target, site health, data integrity, RPO, and RTO', () => {
  const result = verifyDisasterRecoveryRestore({
    websiteId,
    serverId,
    targetDirectory: '/var/lib/yunpanel/websites/TestApp-DR',
    allowedTargetRoots: ['/var/lib/yunpanel/websites'],
    targetWasEmpty: true,
    disasterTimestamp: '2026-10-03T08:00:00.000Z',
    snapshotTimestamp: '2026-10-03T07:40:00.000Z', // 20 mins = 1200s RPO
    recoveryStartedAt: '2026-10-03T08:05:00.000Z',
    recoveryCompletedAt: '2026-10-03T08:25:00.000Z', // 20 mins = 1200s RTO
    acceptableRpoSeconds: 3600, // 1h acceptable
    targetRtoSeconds: 7200,     // 2h target
    operationalVerification: {
      siteRunning: true,
      httpStatus: 200,
    },
    integrityVerification: {
      filesVerified: true,
      databaseChecksumMatched: true,
      recordsValidated: true,
    },
  });

  assert.equal(result.verified, true);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.targetAuthorized, true);
  assert.equal(result.targetWasEmpty, true);
  assert.equal(result.operationalVerified, true);
  assert.equal(result.integrityVerified, true);
  assert.equal(result.metrics.rpoSeconds, 1200);
  assert.equal(result.metrics.rpoAccepted, true);
  assert.equal(result.metrics.rtoSeconds, 1200);
  assert.equal(result.metrics.rtoAccepted, true);

  // Non-empty target must fail
  assert.throws(
    () => verifyDisasterRecoveryRestore({
      websiteId,
      serverId,
      targetDirectory: '/var/lib/yunpanel/websites/TestApp-DR',
      allowedTargetRoots: ['/var/lib/yunpanel/websites'],
      targetWasEmpty: false,
      operationalVerification: { siteRunning: true, httpStatus: 200 },
      integrityVerification: { filesVerified: true },
    }),
    (err) => err instanceof BackupPlanError && err.code === 'target_not_empty',
  );

  // Unauthorized target must fail
  assert.throws(
    () => verifyDisasterRecoveryRestore({
      websiteId,
      serverId,
      targetDirectory: '/var/unauthorized/target',
      allowedTargetRoots: ['/var/lib/yunpanel/websites'],
      targetWasEmpty: true,
      operationalVerification: { siteRunning: true, httpStatus: 200 },
      integrityVerification: { filesVerified: true },
    }),
    (err) => err instanceof BackupPlanError && err.code === 'target_unauthorized',
  );
});

test('PROD-08 Service: disaster recovery verification rejects snapshot-only or backup-file-only evidence', () => {
  assert.throws(
    () => verifyDisasterRecoveryRestore({
      websiteId,
      serverId,
      targetDirectory: '/var/lib/yunpanel/websites/TestApp',
      snapshotListOnly: true,
      targetWasEmpty: true,
      operationalVerification: { siteRunning: true, httpStatus: 200 },
      integrityVerification: { filesVerified: true },
    }),
    (err) => err instanceof BackupPlanError && err.code === 'disaster_recovery_insufficient_evidence',
  );

  assert.throws(
    () => verifyDisasterRecoveryRestore({
      websiteId,
      serverId,
      targetDirectory: '/var/lib/yunpanel/websites/TestApp',
      backupFileOnly: true,
      targetWasEmpty: true,
      operationalVerification: { siteRunning: true, httpStatus: 200 },
      integrityVerification: { filesVerified: true },
    }),
    (err) => err instanceof BackupPlanError && err.code === 'disaster_recovery_insufficient_evidence',
  );
});

test('PROD-08 Service: sanitizeDisasterRecoveryRestoreResult enforces RPO, RTO tolerances and masks secrets', () => {
  const validResult = {
    recoveryId: 'dr-test-rec-1',
    websiteId,
    targetPath: '/var/lib/yunpanel/websites/TestApp-DR',
    targetWasEmpty: true,
    targetAuthorized: true,
    operationalVerified: true,
    integrityVerified: true,
    restoredCategories: DISASTER_RECOVERY_CATEGORIES,
    metrics: {
      rpoSeconds: 600,
      acceptableRpoSeconds: 1800,
      rtoSeconds: 900,
      targetRtoSeconds: 3600,
    },
    verified: true,
    scope: {
      adminPassword: 'super-secret-pw',
      databasePassword: 'db-secret-pw',
    },
  };

  const sanitized = sanitizeDisasterRecoveryRestoreResult({ id: 'job-rec-1' }, validResult);
  assert.equal(sanitized.verified, true);
  assert.equal(sanitized.restored, true);
  assert.equal(sanitized.secretsMasked, true);
  assert.equal(sanitized.scope.adminPassword, '[REDACTED]');
  assert.equal(sanitized.scope.databasePassword, '[REDACTED]');

  // Exceeded RPO throws
  assert.throws(
    () => sanitizeDisasterRecoveryRestoreResult({ id: 'job-rec-1' }, {
      ...validResult,
      metrics: { rpoSeconds: 3600, acceptableRpoSeconds: 1800, rtoSeconds: 900, targetRtoSeconds: 3600 },
    }),
    (err) => err instanceof DatabaseRestoreJobResultError && err.code === 'disaster_recovery_rpo_exceeded',
  );

  // Exceeded RTO throws
  assert.throws(
    () => sanitizeDisasterRecoveryRestoreResult({ id: 'job-rec-1' }, {
      ...validResult,
      metrics: { rpoSeconds: 600, acceptableRpoSeconds: 1800, rtoSeconds: 5000, targetRtoSeconds: 3600 },
    }),
    (err) => err instanceof DatabaseRestoreJobResultError && err.code === 'disaster_recovery_rto_exceeded',
  );

  // Private key leak in result throws
  assert.throws(
    () => sanitizeDisasterRecoveryRestoreResult({ id: 'job-rec-1' }, {
      ...validResult,
      rawLeakedKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----',
    }),
    (err) => err instanceof DatabaseRestoreJobResultError && err.code === 'disaster_recovery_secret_leak',
  );
});
