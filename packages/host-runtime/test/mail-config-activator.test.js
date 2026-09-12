import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  mailTemplatePolicy,
  previewManagedMailConfiguration,
  renderDovecotPasswdFile,
} from '@yunpanel/config-templates';
import {
  createMailConfigActivator,
  createMailConfigBackupManager,
  createMailConfigManager,
  MailConfigActivationError,
  mailConfigBackupInternals,
} from '../src/index.js';

const ARGON2ID_HASH = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 11).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 12).toString('base64').replace(/=+$/, '')}`;
const TRANSACTION_ID = 'mail-job-activate-001';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const input = {
    domains: ['example.com'],
    mailboxes: ['owner@example.com'],
    aliases: [{ source: 'info@example.com', destinations: ['owner@example.com'] }],
    accounts: [{ address: 'owner@example.com', passwordHash: ARGON2ID_HASH }],
    postmasterAddress: 'owner@example.com',
  };
  return {
    preview: previewManagedMailConfiguration(input),
    passwd: renderDovecotPasswdFile({ domains: input.domains, accounts: input.accounts }),
  };
}

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-activate-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function createMappedFs(liveRoot) {
  const mapPath = (value) => value === '/etc' || value.startsWith('/etc/')
    ? path.join(liveRoot, value.slice(1))
    : value;
  return {
    mapPath,
    lstatFn: (value) => lstat(mapPath(value)),
    mkdirFn: (value, options) => mkdir(mapPath(value), options),
    readFileFn: (value, options) => readFile(mapPath(value), options),
    renameFn: (from, to) => rename(mapPath(from), mapPath(to)),
    rmFn: (value, options) => rm(mapPath(value), options),
    rmdirFn: (value) => rmdir(mapPath(value)),
    writeFileFn: (value, content, options) => writeFile(mapPath(value), content, options),
    chmodFn: (value, mode) => chmod(mapPath(value), mode),
    chownFn: async () => {},
  };
}

async function prepare({ root, failFirstDoveconf = false } = {}) {
  const liveRoot = path.join(root, 'live');
  const stagingRoot = path.join(root, 'staging');
  const backupRoot = path.join(root, 'backup');
  const mapped = createMappedFs(liveRoot);
  await mkdir(mapped.mapPath('/etc/postfix'), { recursive: true });
  await mkdir(mapped.mapPath('/etc/dovecot/conf.d'), { recursive: true });
  await mkdir(mapped.mapPath('/etc/rspamd/local.d'), { recursive: true });
  const originalMainCf = Buffer.from('myhostname = mail.example.net\nmydestination = $myhostname, localhost\n');
  await writeFile(mapped.mapPath(mailConfigBackupInternals.postfixMainCfPath), originalMainCf, { mode: 0o644 });

  const { preview, passwd } = fixture();
  const configManager = createMailConfigManager({ stagingRoot });
  await configManager.stageConfiguration(preview, {
    sensitiveArtifacts: [{ path: mailTemplatePolicy.dovecotPasswdFilePath, content: passwd }],
  });
  const backupManager = createMailConfigBackupManager({
    backupRoot,
    liveLstatFn: mapped.lstatFn,
    liveReadFileFn: mapped.readFileFn,
  });
  const backup = await backupManager.backupConfiguration(preview, { transactionId: TRANSACTION_ID });

  const readinessInspector = {
    inspect: async (candidate) => ({
      version: 1,
      sha256: 'a'.repeat(64),
      previewSha256: candidate.sha256,
      ready: true,
      blockers: [],
      sideEffects: false,
    }),
  };
  const calls = [];
  const postfixParameters = new Map();
  let doveconfFailuresRemaining = failFirstDoveconf ? 1 : 0;
  const run = async (file, args) => {
    calls.push([file, [...args]]);
    if (file === '/usr/sbin/postmap') {
      const source = args[0].replace(/^hash:/, '');
      await writeFile(mapped.mapPath(`${source}.db`), Buffer.from(`compiled:${source}\n`), { mode: 0o640 });
      return { stdout: '', stderr: '' };
    }
    if (file === '/usr/sbin/postconf' && args[0] === '-e') {
      const separator = args[1].indexOf(' = ');
      const name = args[1].slice(0, separator);
      const value = args[1].slice(separator + 3);
      postfixParameters.set(name, value);
      await appendFile(mapped.mapPath(mailConfigBackupInternals.postfixMainCfPath), `${name} = ${value}\n`);
      return { stdout: '', stderr: '' };
    }
    if (file === '/usr/sbin/postconf' && args[0] === '-h') {
      return { stdout: `${postfixParameters.get(args[1]) ?? ''}\n`, stderr: '' };
    }
    if (file === '/usr/bin/doveconf' && args[0] === '-n' && doveconfFailuresRemaining > 0) {
      doveconfFailuresRemaining -= 1;
      throw new Error('fixture validation failure');
    }
    return { stdout: '', stderr: '' };
  };

  const activator = createMailConfigActivator({
    configManager,
    backupManager,
    readinessInspector,
    run,
    ...mapped,
  });
  return {
    activator,
    backup,
    backupManager,
    calls,
    mapped,
    originalMainCf,
    passwd,
    preview,
  };
}

test('activates staged mail config with compiled maps, postfix parameters and secret-free result', async () => withTempDirectory(async (root) => {
  const context = await prepare({ root });
  const result = await context.activator.activateConfiguration(context.preview, { transactionId: TRANSACTION_ID });

  assert.equal(result.applied, true);
  assert.equal(result.sideEffects, true);
  assert.equal(result.previewSha256, context.preview.sha256);
  assert.equal(JSON.stringify(result).includes(ARGON2ID_HASH), false);
  assert.equal(JSON.stringify(result).includes(context.passwd), false);

  for (const artifact of context.preview.artifacts) {
    const target = context.mapped.mapPath(artifact.path);
    assert.equal((await stat(target)).isFile(), true);
    const content = await readFile(target);
    assert.equal(sha256(content), artifact.sha256);
  }
  for (const compiledPath of mailConfigBackupInternals.postfixCompiledPaths) {
    assert.equal((await stat(context.mapped.mapPath(compiledPath))).isFile(), true);
  }
  assert.equal((await stat(context.mapped.mapPath('/etc/yunpanel/mail/postfix'))).isDirectory(), true);
  assert.equal((await stat(context.mapped.mapPath('/etc/yunpanel/mail/dovecot'))).isDirectory(), true);

  assert.deepEqual(context.calls.slice(0, 3).map((entry) => entry[0]), [
    '/usr/sbin/postmap',
    '/usr/sbin/postmap',
    '/usr/sbin/postmap',
  ]);
  const reloads = context.calls.filter(([file, args]) => file === '/usr/bin/systemctl' && args[0] === 'reload');
  assert.deepEqual(reloads.map(([, args]) => args[1]), ['rspamd', 'dovecot', 'postfix']);
}));

test('restores files, postfix main.cf, compiled maps and newly-created directories after validation failure', async () => withTempDirectory(async (root) => {
  const context = await prepare({ root, failFirstDoveconf: true });

  await assert.rejects(
    context.activator.activateConfiguration(context.preview, { transactionId: TRANSACTION_ID }),
    (error) => error instanceof MailConfigActivationError && error.code === 'mail_config_validation_failed',
  );

  assert.deepEqual(
    await readFile(context.mapped.mapPath(mailConfigBackupInternals.postfixMainCfPath)),
    context.originalMainCf,
  );
  for (const targetPath of context.preview.artifacts.map((artifact) => artifact.path)
    .concat(mailConfigBackupInternals.postfixCompiledPaths)) {
    await assert.rejects(lstat(context.mapped.mapPath(targetPath)), (error) => error?.code === 'ENOENT');
  }
  for (const directoryPath of mailConfigBackupInternals.managedDirectoryPaths) {
    await assert.rejects(lstat(context.mapped.mapPath(directoryPath)), (error) => error?.code === 'ENOENT');
  }

  const reloads = context.calls.filter(([file, args]) => file === '/usr/bin/systemctl' && args[0] === 'reload');
  assert.deepEqual(reloads.map(([, args]) => args[1]), ['postfix', 'dovecot', 'rspamd']);
  const inspected = await context.backupManager.inspectBackup(context.preview, { transactionId: TRANSACTION_ID });
  assert.equal(inspected.satisfied, true);
}));

test('rejects live state drift after backup before the first activation mutation', async () => withTempDirectory(async (root) => {
  const context = await prepare({ root });
  await writeFile(
    context.mapped.mapPath(mailConfigBackupInternals.postfixMainCfPath),
    'changed after backup\n',
    { mode: 0o644 },
  );

  await assert.rejects(
    context.activator.activateConfiguration(context.preview, { transactionId: TRANSACTION_ID }),
    (error) => error instanceof MailConfigActivationError && error.code === 'mail_live_state_changed',
  );
  assert.equal(context.calls.length, 0);
  await assert.rejects(
    lstat(context.mapped.mapPath('/etc/yunpanel/mail/postfix')),
    (error) => error?.code === 'ENOENT',
  );
}));
