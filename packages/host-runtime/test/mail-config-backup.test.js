import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  mailForwardingTemplatePolicy,
  mailTemplatePolicy,
  previewManagedMailForwardingConfiguration,
} from '@yunpanel/config-templates';
import {
  createMailConfigBackupManager,
  MailConfigBackupError,
  mailConfigBackupInternals,
} from '../src/index.js';

const ARGON2ID_HASH = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 3).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 4).toString('base64').replace(/=+$/, '')}`;

function preview() {
  return previewManagedMailForwardingConfiguration({
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

test('backs up mail sources, compiled maps/sieve, main.cf and managed directory state without exposing content', async () => withTempDirectory(async (root) => {
  const compiledDomainMap = mailConfigBackupInternals.postfixCompiledPaths[0];
  const compiledSieve = mailConfigBackupInternals.sieveCompiledPath;
  const live = new Map([
    [mailTemplatePolicy.postfixVirtualDomainMapPath, Buffer.from('example.com OK\n')],
    [compiledDomainMap, Buffer.from('compiled-domain-map')],
    [mailConfigBackupInternals.postfixMainCfPath, Buffer.from('myhostname = mail.example.com\n')],
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
  assert.equal(result.version, 3);
  assert.equal(result.transactionId, 'mail-job-0001');
  assert.equal(result.artifacts.length, mailConfigBackupInternals.targetPaths.length);
  assert.equal(result.directories.length, mailConfigBackupInternals.managedDirectoryPaths.length);
  assert.equal(JSON.stringify(result).includes(ARGON2ID_HASH), false);
  assert.equal(result.artifacts.find((entry) => entry.targetPath === compiledDomainMap).present, true);
  assert.equal(result.artifacts.find((entry) => entry.targetPath === compiledSieve).present, true);
  assert.equal(result.artifacts.find((entry) => entry.targetPath === mailForwardingTemplatePolicy.sievePath).present, true);
  assert.equal(result.artifacts.find((entry) => entry.targetPath === mailConfigBackupInternals.postfixMainCfPath).present, true);
  assert.equal(result.artifacts.find((entry) => entry.targetPath === mailTemplatePolicy.dovecotPasswdFilePath).mode, 0o600);
  assert.equal(result.artifacts.find((entry) => entry.targetPath === mailTemplatePolicy.dovecotAuthConfigPath).present, false);
  assert.deepEqual(result.directories[0], { path: '/etc/yunpanel', present: true, mode: 0o755, uid: 0, gid: 0 });
  assert.equal(result.directories[1].present, false);

  const directory = manager.transactionDirectory('mail-job-0001');
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const artifact of result.artifacts.filter((entry) => entry.present)) {
    assert.equal((await stat(path.join(directory, artifact.backupName))).mode & 0o777, 0o600);
  }
  const inspected = await manager.inspectBackup(preview(), { transactionId: 'mail-job-0001' });
  assert.equal(inspected.satisfied, true);
  assert.equal(inspected.result.planSha256, result.planSha256);

  const readsBeforeRetry = liveReads;
  live.set(mailTemplatePolicy.postfixVirtualDomainMapPath, Buffer.from('changed after backup\n'));
  const repeated = await manager.backupConfiguration(preview(), { transactionId: 'mail-job-0001' });
  assert.equal(repeated.planSha256, result.planSha256);
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
}));
