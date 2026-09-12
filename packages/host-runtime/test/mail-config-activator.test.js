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
  mailForwardingTemplatePolicy,
  mailSubmissionTemplatePolicy,
  mailTemplatePolicy,
  previewManagedMailSubmissionConfiguration,
  renderDovecotQuotaPasswdFile,
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
const VMAIL_UID = 5000;
const VMAIL_GID = 5000;
const POSTFIX_UID = 110;
const POSTFIX_GID = 117;

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
    forwardings: [{ source: 'owner@example.com', mode: 'copy', destinations: ['backup@elsewhere.test'] }],
  };
  return {
    preview: previewManagedMailSubmissionConfiguration(input),
    passwd: renderDovecotQuotaPasswdFile({ domains: input.domains, accounts: input.accounts }),
  };
}

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-activate-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function createMappedFs(liveRoot) {
  const owners = new Map();
  const mapPath = (value) => value === '/etc' || value.startsWith('/etc/')
    ? path.join(liveRoot, value.slice(1))
    : value;
  return {
    mapPath,
    lstatFn: async (value) => {
      const target = mapPath(value);
      const metadata = await lstat(target);
      const owner = owners.get(target);
      if (!owner) return metadata;
      return new Proxy(metadata, {
        get(object, property) {
          if (property === 'uid') return owner.uid;
          if (property === 'gid') return owner.gid;
          const resolved = object[property];
          return typeof resolved === 'function' ? resolved.bind(object) : resolved;
        },
      });
    },
    mkdirFn: (value, options) => mkdir(mapPath(value), options),
    readFileFn: (value, options) => readFile(mapPath(value), options),
    renameFn: (from, to) => rename(mapPath(from), mapPath(to)),
    rmFn: async (value, options) => {
      owners.delete(mapPath(value));
      return rm(mapPath(value), options);
    },
    rmdirFn: (value) => rmdir(mapPath(value)),
    writeFileFn: (value, content, options) => writeFile(mapPath(value), content, options),
    chmodFn: (value, mode) => chmod(mapPath(value), mode),
    chownFn: async (value, uid, gid) => { owners.set(mapPath(value), { uid, gid }); },
  };
}

function socketStat({ valid = true } = {}) {
  return {
    mode: valid ? 0o660 : 0o644,
    uid: valid ? POSTFIX_UID : 0,
    gid: valid ? POSTFIX_GID : 0,
    isFile: () => false,
    isDirectory: () => false,
    isSocket: () => true,
    isSymbolicLink: () => false,
  };
}

async function prepare({
  root,
  failFirstDoveconf = false,
  failSievec = false,
  invalidVmailIdentity = false,
  invalidPostfixIdentity = false,
  invalidSubmissionSocket = false,
} = {}) {
  const liveRoot = path.join(root, 'live');
  const stagingRoot = path.join(root, 'staging');
  const backupRoot = path.join(root, 'backup');
  const mapped = createMappedFs(liveRoot);
  await mkdir(mapped.mapPath('/etc/postfix'), { recursive: true });
  await mkdir(mapped.mapPath('/etc/dovecot/conf.d'), { recursive: true });
  await mkdir(mapped.mapPath('/etc/rspamd/local.d'), { recursive: true });
  const originalMainCf = Buffer.from('myhostname = mail.example.net\nmydestination = $myhostname, localhost\n');
  const originalMasterCf = Buffer.from('smtp inet n - y - - smtpd\n');
  await writeFile(mapped.mapPath(mailConfigBackupInternals.postfixMainCfPath), originalMainCf, { mode: 0o644 });
  await writeFile(mapped.mapPath(mailConfigBackupInternals.postfixMasterCfPath), originalMasterCf, { mode: 0o644 });

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
  const masterParameters = new Map();
  let masterDefinition = null;
  let doveconfFailuresRemaining = failFirstDoveconf ? 1 : 0;
  const run = async (file, args) => {
    calls.push([file, [...args]]);
    if (file === '/usr/bin/getent') {
      if (args[0] !== 'passwd' || !['vmail', 'postfix'].includes(args[1])) throw new Error('unexpected identity');
      if (args[1] === 'vmail') {
        return {
          stdout: invalidVmailIdentity
            ? 'vmail:x:0:0::/var/lib/yunpanel/mail:/usr/sbin/nologin\n'
            : `vmail:x:${VMAIL_UID}:${VMAIL_GID}::/var/lib/yunpanel/mail:/usr/sbin/nologin\n`,
          stderr: '',
        };
      }
      return {
        stdout: invalidPostfixIdentity
          ? 'postfix:x:0:0::/var/spool/postfix:/usr/sbin/nologin\n'
          : `postfix:x:${POSTFIX_UID}:${POSTFIX_GID}::/var/spool/postfix:/usr/sbin/nologin\n`,
        stderr: '',
      };
    }
    if (file === '/usr/sbin/postmap') {
      const source = args[0].replace(/^hash:/, '');
      await writeFile(mapped.mapPath(`${source}.db`), Buffer.from(`compiled:${source}\n`), { mode: 0o640 });
      return { stdout: '', stderr: '' };
    }
    if (file === '/usr/bin/sievec') {
      if (failSievec) throw new Error('fixture sieve compile failure');
      assert.deepEqual(args, [mailForwardingTemplatePolicy.sievePath]);
      await writeFile(
        mapped.mapPath(mailForwardingTemplatePolicy.compiledPath),
        Buffer.from('compiled-sieve'),
        { mode: 0o644 },
      );
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
    if (file === '/usr/sbin/postconf' && args[0] === '-M') {
      const expression = args[1];
      const separator = expression.indexOf('=');
      if (separator >= 0) {
        masterDefinition = expression.slice(separator + 1);
        await appendFile(mapped.mapPath(mailConfigBackupInternals.postfixMasterCfPath), `${masterDefinition}\n`);
        return { stdout: '', stderr: '' };
      }
      return { stdout: `${masterDefinition ?? ''}\n`, stderr: '' };
    }
    if (file === '/usr/sbin/postconf' && args[0] === '-P') {
      const expression = args[1];
      const separator = expression.indexOf('=');
      if (separator >= 0) {
        const key = expression.slice(0, separator);
        const value = expression.slice(separator + 1);
        masterParameters.set(key, value);
        await appendFile(mapped.mapPath(mailConfigBackupInternals.postfixMasterCfPath), `  -o ${key.split('/').at(-1)}=${value}\n`);
        return { stdout: '', stderr: '' };
      }
      return { stdout: `${expression}=${masterParameters.get(expression) ?? ''}\n`, stderr: '' };
    }
    if (file === '/usr/bin/doveconf' && args[0] === '-n' && doveconfFailuresRemaining > 0) {
      doveconfFailuresRemaining -= 1;
      throw new Error('fixture validation failure');
    }
    return { stdout: '', stderr: '' };
  };

  const activatorLstatFn = async (value) => value === mailSubmissionTemplatePolicy.dovecotAuthSocket
    ? socketStat({ valid: !invalidSubmissionSocket })
    : mapped.lstatFn(value);
  const activator = createMailConfigActivator({
    configManager,
    backupManager,
    readinessInspector,
    run,
    ...mapped,
    lstatFn: activatorLstatFn,
  });
  return {
    activator,
    backup,
    backupManager,
    calls,
    mapped,
    originalMainCf,
    originalMasterCf,
    passwd,
    preview,
  };
}

test('activates staged mail config with compiled maps/sieve, guarded submission and secret-free result', async () => withTempDirectory(async (root) => {
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
  const sieveSourceMetadata = await context.mapped.lstatFn(mailForwardingTemplatePolicy.sievePath);
  assert.equal(sieveSourceMetadata.uid, 0);
  assert.equal(sieveSourceMetadata.gid, VMAIL_GID);
  assert.equal(sieveSourceMetadata.mode & 0o777, 0o640);
  const compiledSieveMetadata = await context.mapped.lstatFn(mailConfigBackupInternals.sieveCompiledPath);
  assert.equal(compiledSieveMetadata.isFile(), true);
  assert.equal(compiledSieveMetadata.mode & 0o777, 0o640);
  assert.equal(compiledSieveMetadata.uid, 0);
  assert.equal(compiledSieveMetadata.gid, VMAIL_GID);
  assert.equal((await stat(context.mapped.mapPath('/etc/yunpanel/mail/postfix'))).isDirectory(), true);
  assert.equal((await stat(context.mapped.mapPath('/etc/yunpanel/mail/dovecot'))).isDirectory(), true);

  const compileCalls = context.calls.filter(([file]) => file === '/usr/sbin/postmap' || file === '/usr/bin/sievec');
  assert.deepEqual(compileCalls.map((entry) => entry[0]), [
    '/usr/sbin/postmap',
    '/usr/sbin/postmap',
    '/usr/sbin/postmap',
    '/usr/sbin/postmap',
    '/usr/bin/sievec',
  ]);
  assert.equal(context.calls.some(([file, args]) => file === '/usr/sbin/postconf'
    && args[0] === '-M' && args[1] === 'submission/inet=submission inet n - n - - smtpd'), true);
  assert.equal(context.calls.some(([file, args]) => file === '/usr/sbin/postconf'
    && args[0] === '-P' && args[1] === 'submission/inet/smtpd_tls_security_level=encrypt'), true);
  const reloads = context.calls.filter(([file, args]) => file === '/usr/bin/systemctl' && args[0] === 'reload');
  assert.deepEqual(reloads.map(([, args]) => args[1]), ['rspamd', 'dovecot', 'postfix']);
}));

test('restores files, postfix main.cf/master.cf, compiled maps/sieve and newly-created directories after validation failure', async () => withTempDirectory(async (root) => {
  const context = await prepare({ root, failFirstDoveconf: true });

  await assert.rejects(
    context.activator.activateConfiguration(context.preview, { transactionId: TRANSACTION_ID }),
    (error) => error instanceof MailConfigActivationError && error.code === 'mail_config_validation_failed',
  );

  assert.deepEqual(
    await readFile(context.mapped.mapPath(mailConfigBackupInternals.postfixMainCfPath)),
    context.originalMainCf,
  );
  assert.deepEqual(
    await readFile(context.mapped.mapPath(mailConfigBackupInternals.postfixMasterCfPath)),
    context.originalMasterCf,
  );
  for (const targetPath of context.preview.artifacts.map((artifact) => artifact.path)
    .concat(mailConfigBackupInternals.compiledPaths)) {
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

test('unsafe submission auth socket rolls back the complete transaction', async () => withTempDirectory(async (root) => {
  const context = await prepare({ root, invalidSubmissionSocket: true });
  await assert.rejects(
    context.activator.activateConfiguration(context.preview, { transactionId: TRANSACTION_ID }),
    (error) => error instanceof MailConfigActivationError && error.code === 'mail_submission_socket_invalid',
  );
  assert.deepEqual(await readFile(context.mapped.mapPath(mailConfigBackupInternals.postfixMainCfPath)), context.originalMainCf);
  assert.deepEqual(await readFile(context.mapped.mapPath(mailConfigBackupInternals.postfixMasterCfPath)), context.originalMasterCf);
}));

test('sieve compile failure rolls back without being mislabeled as a postmap failure', async () => withTempDirectory(async (root) => {
  const context = await prepare({ root, failSievec: true });
  await assert.rejects(
    context.activator.activateConfiguration(context.preview, { transactionId: TRANSACTION_ID }),
    (error) => error instanceof MailConfigActivationError && error.code === 'mail_sieve_compile_failed',
  );
  for (const targetPath of context.preview.artifacts.map((artifact) => artifact.path)
    .concat(mailConfigBackupInternals.compiledPaths)) {
    await assert.rejects(lstat(context.mapped.mapPath(targetPath)), (error) => error?.code === 'ENOENT');
  }
}));

test('invalid or privileged mail identities block activation before the first mutation', async () => withTempDirectory(async (root) => {
  const vmailContext = await prepare({ root, invalidVmailIdentity: true });
  await assert.rejects(
    vmailContext.activator.activateConfiguration(vmailContext.preview, { transactionId: TRANSACTION_ID }),
    (error) => error instanceof MailConfigActivationError && error.code === 'mail_vmail_identity_unavailable',
  );
  assert.deepEqual(vmailContext.calls.slice(0, 2), [
    ['/usr/bin/getent', ['passwd', 'vmail']],
    ['/usr/bin/getent', ['passwd', 'postfix']],
  ]);
  assert.deepEqual(await readFile(vmailContext.mapped.mapPath(mailConfigBackupInternals.postfixMainCfPath)), vmailContext.originalMainCf);

  const secondRoot = path.join(root, 'postfix-case');
  await mkdir(secondRoot, { recursive: true });
  const postfixContext = await prepare({ root: secondRoot, invalidPostfixIdentity: true });
  await assert.rejects(
    postfixContext.activator.activateConfiguration(postfixContext.preview, { transactionId: TRANSACTION_ID }),
    (error) => error instanceof MailConfigActivationError && error.code === 'mail_postfix_identity_unavailable',
  );
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
  assert.deepEqual(context.calls.slice(0, 2), [
    ['/usr/bin/getent', ['passwd', 'vmail']],
    ['/usr/bin/getent', ['passwd', 'postfix']],
  ]);
  await assert.rejects(
    lstat(context.mapped.mapPath('/etc/yunpanel/mail/postfix')),
    (error) => error?.code === 'ENOENT',
  );
}));
