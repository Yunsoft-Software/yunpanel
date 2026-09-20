import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  mailForwardingTemplatePolicy,
  mailSubmissionTemplatePolicy,
  mailTemplatePolicy,
  previewManagedMailSubmissionConfiguration,
} from '@yunpanel/config-templates';
import {
  createMailConfigBackupManager,
  MailConfigBackupError,
  mailConfigBackupInternals,
} from '../src/index.js';

const ARGON2ID_HASH = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 3).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 4).toString('base64').replace(/=+$/, '')}`;

function preview() {
  return previewManagedMailSubmissionConfiguration({
    domains: ['example.com'],
    mailboxes: ['owner@example.com'],
    aliases: [{ source: 'info@example.com', destinations: ['owner@example.com'] }],
    accounts: [{ address: 'owner@example.com', passwordHash: ARGON2ID_HASH }],
    postmasterAddress: 'owner@example.com',
    forwardings: [{ source: 'owner@example.com', mode: 'copy', destinations: ['backup@elsewhere.test'] }],
  });
}

function regularStat({ mode = 0o640, uid = 0, gid = 0 } = {}) {
  return {
    mode,
    uid,
    gid,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  };
}

function directoryStat({ mode = 0o750, uid = 0, gid = 0 } = {}) {
  return {
    mode,
    uid,
    gid,
    isFile: () => false,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
}

function missing() {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-backup-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('backs up mail sources, compiled maps/sieve, main.cf/master.cf and managed directory state without exposing content', async () => withTempDirectory(async (root) => {
  const compiledDomainMap = mailConfigBackupInternals.postfixCompiledPaths[0];
  const compiledSenderMap = `${mailSubmissionTemplatePolicy.senderLoginPath}.db`;
  const compiledSieve = mailConfigBackupInternals.sieveCompiledPath;
  const live = new Map([
    [mailTemplatePolicy.postfixVirtualDomainMapPath, Buffer.from('example.com OK\n')],
    [compiledDomainMap, Buffer.from('compiled-domain-map')],
    [mailSubmissionTemplatePolicy.senderLoginPath, Buffer.from('owner@example.com owner@example.com\n')],
    [compiledSenderMap, Buffer.from('compiled-sender-map')],
    [mailConfigBackupInternals.postfixMainCfPath, Buffer.from('myhostname = mail.example.com\n')],
    [mailConfigBackupInternals.postfixMasterCfPath, Buffer.from('smtp inet n - y - - smtpd\n')],
    [mailTemplatePolicy.dovecotPasswdFilePath, Buffer.from(`owner@example.com:{ARGON2ID}${ARGON2ID_HASH}\n`)],
    [mailForwardingTemplatePolicy.sievePath, Buffer.from('require ["envelope", "copy"];\n')],
    [compiledSieve, Buffer.from('compiled-sieve')],
    [mailTemplatePolicy.rspamdProxyConfigPath, Buffer.from('bind_socket = "127.0.0.1:11332";\n')],
  ]);
  const liveDirectories = new Map([
    ['/etc/yunpanel', directoryStat({ mode: 0o755, uid: 0, gid: 0 })],
  ]);
  let liveReads = 0;
  const manager = createMailConfigBackupManager({
    backupRoot: path.join(root, 'backup'),
    liveLstatFn: async (targetPath) => {
      if (liveDirectories.has(targetPath)) return liveDirectories.get(targetPath);
      if (!live.has(targetPath)) throw missing();
      const privateTarget = targetPath === mailTemplatePolicy.dovecotPasswdFilePath || targetPath === compiledSieve;
      return regularStat({ mode: privateTarget ? 0o600 : 0o640, uid: 12, gid: 34 });
    },
    liveReadFileFn: async (targetPath) => {
      liveReads += 1;
      return Buffer.from(live.get(targetPath));
    },
  });

  const result = await manager.backupConfiguration(preview(), { transactionId: 'mail-job-0001' });
  assert.equal(result.version, 6);
  assert.equal(result.transactionId, 'mail-job-0001');
  const { manifestSha256, ...manifest } = result;
  assert.equal(manifestSha256, createHash('sha256').update(JSON.stringify(manifest)).digest('hex'));
  assert.equal(result.artifacts.length, mailConfigBackupInternals.targetPaths.length);
  assert.equal(result.directories.length, mailConfigBackupInternals.managedDirectoryPaths.length);
  assert.equal(JSON.stringify(result).includes(ARGON2ID_HASH), false);
  assert.equal(result.artifacts.find((entry) => entry.targetPath === compiledDomainMap).present, true);
  assert.equal(result.artifacts.find((entry) => entry.targetPath === compiledSenderMap).present, true);
  assert.equal(result.artifacts.find((entry) => entry.targetPath === compiledSieve).present, true);
  assert.equal(result.artifacts.find((entry) => entry.targetPath === mailForwardingTemplatePolicy.sievePath).present, true);
  assert.equal(result.artifacts.find((entry) => entry.targetPath === mailConfigBackupInternals.postfixMainCfPath).present, true);
  assert.equal(result.artifacts.find((entry) => entry.targetPath === mailConfigBackupInternals.postfixMasterCfPath).present, true);
  assert.equal(result.artifacts.find((entry) => entry.targetPath === mailTemplatePolicy.dovecotPasswdFilePath).mode, 0o600);
  assert.equal(result.artifacts.find((entry) => entry.targetPath === mailTemplatePolicy.dovecotAuthConfigPath).present, false);
  assert.deepEqual(result.directories[0], { path: '/etc/yunpanel', present: true, mode: 0o755, uid: 0, gid: 0 });
  assert.equal(result.directories[1].present, false);

  const directory = manager.transactionDirectory('mail-job-0001');
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const artifact of result.artifacts.filter((entry) => entry.present)) {
    assert.equal((await stat(path.join(directory, artifact.backupName))).mode & 0o777, 0o600);
  }
  const legacyManifest = {
    ...manifest,
    version: 5,
    artifacts: manifest.artifacts.filter((artifact) => (
      mailConfigBackupInternals.legacyTargetPaths.includes(artifact.targetPath)
    )),
    directories: manifest.directories.filter((directory) => (
      mailConfigBackupInternals.legacyManagedDirectoryPaths.includes(directory.path)
    )),
  };
  const normalizedLegacy = mailConfigBackupInternals.normalizeManifest(legacyManifest, {
    transactionId: result.transactionId,
    planSha256: result.planSha256,
  });
  assert.equal(normalizedLegacy.version, 5);
  assert.equal(normalizedLegacy.artifacts.length, mailConfigBackupInternals.legacyTargetPaths.length);

  const inspected = await manager.inspectBackup(preview(), { transactionId: 'mail-job-0001' });
  assert.equal(inspected.satisfied, true);
  assert.equal(inspected.result.planSha256, result.planSha256);
  assert.equal(inspected.result.manifestSha256, result.manifestSha256);

  const identityBound = await manager.inspectBackupByIdentity({
    transactionId: result.transactionId,
    planSha256: result.planSha256,
    previewSha256: result.previewSha256,
    manifestSha256: result.manifestSha256,
  });
  assert.equal(identityBound.satisfied, true);
  assert.equal(identityBound.result.manifestSha256, result.manifestSha256);
  assert.deepEqual(await manager.inspectBackupByIdentity({
    transactionId: result.transactionId,
    planSha256: result.planSha256,
    previewSha256: 'f'.repeat(64),
    manifestSha256: result.manifestSha256,
  }), { satisfied: false, result: null });
  assert.deepEqual(await manager.inspectBackupByIdentity({
    transactionId: result.transactionId,
    planSha256: result.planSha256,
    previewSha256: result.previewSha256,
    manifestSha256: 'f'.repeat(64),
  }), { satisfied: false, result: null });

  const readsBeforeRetry = liveReads;
  live.set(mailTemplatePolicy.postfixVirtualDomainMapPath, Buffer.from('changed after backup\n'));
  const repeated = await manager.backupConfiguration(preview(), { transactionId: 'mail-job-0001' });
  assert.equal(repeated.planSha256, result.planSha256);
  assert.equal(repeated.manifestSha256, result.manifestSha256);
  assert.equal(liveReads, readsBeforeRetry);
}));

test('fails closed when postfix main.cf is unavailable before apply backup', async () => withTempDirectory(async (root) => {
  const manager = createMailConfigBackupManager({
    backupRoot: path.join(root, 'backup'),
    liveLstatFn: async () => { throw missing(); },
    liveReadFileFn: async () => Buffer.alloc(0),
  });

  await assert.rejects(
    manager.backupConfiguration(preview(), { transactionId: 'mail-job-0002' }),
    (error) => error instanceof MailConfigBackupError && error.code === 'mail_postfix_main_cf_missing',
  );
}));

test('fails closed when master.cf is unavailable after main.cf is present', async () => withTempDirectory(async (root) => {
  const manager = createMailConfigBackupManager({
    backupRoot: path.join(root, 'backup'),
    liveLstatFn: async (targetPath) => {
      if (targetPath === mailConfigBackupInternals.postfixMainCfPath) return regularStat({ mode: 0o644 });
      if (targetPath === mailConfigBackupInternals.postfixMasterCfPath) throw missing();
      if (mailConfigBackupInternals.managedDirectoryPaths.includes(targetPath)) throw missing();
      throw missing();
    },
    liveReadFileFn: async (targetPath) => targetPath === mailConfigBackupInternals.postfixMainCfPath
      ? Buffer.from('myhostname = mail.example.com\n')
      : Buffer.alloc(0),
  });

  await assert.rejects(
    manager.backupConfiguration(preview(), { transactionId: 'mail-job-0004' }),
    (error) => error instanceof MailConfigBackupError && error.code === 'mail_postfix_master_cf_missing',
  );
}));

test('fails closed on symlink-like live targets and invalid transaction ids', async () => withTempDirectory(async (root) => {
  const manager = createMailConfigBackupManager({
    backupRoot: path.join(root, 'backup'),
    liveLstatFn: async (targetPath) => {
      if (targetPath !== mailTemplatePolicy.postfixVirtualDomainMapPath) throw missing();
      return {
        mode: 0o777,
        uid: 0,
        gid: 0,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => true,
      };
    },
    liveReadFileFn: async () => Buffer.from('unsafe'),
  });

  await assert.rejects(
    manager.backupConfiguration(preview(), { transactionId: 'short' }),
    (error) => error instanceof MailConfigBackupError && error.code === 'mail_backup_transaction_invalid',
  );
  await assert.rejects(
    manager.backupConfiguration(preview(), { transactionId: 'mail-job-0003' }),
    (error) => error instanceof MailConfigBackupError && error.code === 'mail_live_artifact_unsafe',
  );
  await assert.rejects(
    manager.inspectBackupByIdentity({
      transactionId: 'mail-job-0003',
      planSha256: 'short',
      previewSha256: 'a'.repeat(64),
      manifestSha256: 'b'.repeat(64),
    }),
    (error) => error instanceof MailConfigBackupError && error.code === 'mail_backup_identity_invalid',
  );
}));

test('reads legacy v5 backup fixture on disk during upgrade recovery and verifies identity inspection', async () => withTempDirectory(async (root) => {
  const backupRoot = path.join(root, 'backup');
  const transactionId = 'legacy-mail-job-v5';
  const txDir = path.join(backupRoot, transactionId);
  const { mkdir: fsMkdir, writeFile: fsWriteFile, chmod: fsChmod } = await import('node:fs/promises');
  await fsMkdir(txDir, { recursive: true, mode: 0o700 });
  await fsChmod(txDir, 0o700);

  const planSha256 = '1'.repeat(64);
  const previewSha256 = '2'.repeat(64);

  const testFileContent = Buffer.from('virtual.domain.test OK\n');
  const testFileSha256 = createHash('sha256').update(testFileContent).digest('hex');
  const artifactName = `00-${path.basename(mailConfigBackupInternals.legacyTargetPaths[0])}.bak`;
  await fsWriteFile(path.join(txDir, artifactName), testFileContent, { mode: 0o600 });
  await fsChmod(path.join(txDir, artifactName), 0o600);

  const artifacts = mailConfigBackupInternals.legacyTargetPaths.map((targetPath, index) => {
    if (index === 0) {
      return {
        targetPath,
        present: true,
        backupName: artifactName,
        sha256: testFileSha256,
        bytes: testFileContent.length,
        mode: 0o600,
        uid: 0,
        gid: 0,
      };
    }
    return {
      targetPath,
      present: false,
      backupName: null,
      sha256: null,
      bytes: 0,
      mode: null,
      uid: null,
      gid: null,
    };
  });

  const directories = mailConfigBackupInternals.legacyManagedDirectoryPaths.map((dirPath, index) => {
    if (index === 0) {
      return { path: dirPath, present: true, mode: 0o755, uid: 0, gid: 0 };
    }
    return { path: dirPath, present: false, mode: null, uid: null, gid: null };
  });

  const manifest = {
    version: 5,
    transactionId,
    planSha256,
    previewSha256,
    artifacts,
    directories,
  };

  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestSha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  await fsWriteFile(path.join(txDir, 'manifest.json'), manifestContent, { mode: 0o600 });
  await fsChmod(path.join(txDir, 'manifest.json'), 0o600);

  const manager = createMailConfigBackupManager({ backupRoot });

  const inspected = await manager.inspectBackupByIdentity({
    transactionId,
    planSha256,
    previewSha256,
    manifestSha256,
  });

  assert.equal(inspected.satisfied, true);
  assert.equal(inspected.result.version, 5);
  assert.equal(inspected.result.transactionId, transactionId);
  assert.equal(inspected.result.planSha256, planSha256);
  assert.equal(inspected.result.previewSha256, previewSha256);
  assert.equal(inspected.result.manifestSha256, manifestSha256);
  assert.equal(inspected.result.artifacts.length, mailConfigBackupInternals.legacyTargetPaths.length);
  assert.equal(inspected.result.directories.length, mailConfigBackupInternals.legacyManagedDirectoryPaths.length);

  await assert.rejects(
    manager.inspectBackupByIdentity({
      transactionId,
      planSha256: '9'.repeat(64),
      previewSha256,
      manifestSha256,
    }),
    (error) => error instanceof MailConfigBackupError && error.code === 'mail_backup_manifest_invalid',
  );

  assert.deepEqual(await manager.inspectBackupByIdentity({
    transactionId,
    planSha256,
    previewSha256: '9'.repeat(64),
    manifestSha256,
  }), { satisfied: false, result: null });

  assert.deepEqual(await manager.inspectBackupByIdentity({
    transactionId,
    planSha256,
    previewSha256,
    manifestSha256: '9'.repeat(64),
  }), { satisfied: false, result: null });

  await fsWriteFile(path.join(txDir, artifactName), Buffer.from('tampered content!'), { mode: 0o600 });
  assert.deepEqual(await manager.inspectBackupByIdentity({
    transactionId,
    planSha256,
    previewSha256,
    manifestSha256,
  }), { satisfied: false, result: null });
}));

