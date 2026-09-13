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
  enableManagedMailSrs,
  mailForwardingTemplatePolicy,
  mailSrsTemplatePolicy,
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

const ARGON2ID_HASH = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 21).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 22).toString('base64').replace(/=+$/, '')}`;
const TRANSACTION_ID = 'mail-srs-activate-001';
const VMAIL_UID = 5000;
const VMAIL_GID = 5000;
const POSTFIX_UID = 110;
const POSTFIX_GID = 117;
const SRS_SECRET = 'S'.repeat(43);
const SRS_SECRET_CONTENT = `${SRS_SECRET}\n`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function srsFixture() {
  const input = {
    domains: ['example.com'],
    mailboxes: ['owner@example.com'],
    aliases: [],
    accounts: [{ address: 'owner@example.com', passwordHash: ARGON2ID_HASH }],
    postmasterAddress: 'owner@example.com',
    forwardings: [{ source: 'owner@example.com', mode: 'copy', destinations: ['external@gmail.com'] }],
  };
  const base = previewManagedMailSubmissionConfiguration(input);
  const preview = enableManagedMailSrs(base, {
    domains: input.domains,
    forwardings: input.forwardings,
    srsDomain: 'mail.example.com',
    secretRevision: 1,
    secretSha256: sha256(SRS_SECRET_CONTENT),
    secretBytes: Buffer.byteLength(SRS_SECRET_CONTENT),
  });
  return {
    preview,
    passwd: renderDovecotQuotaPasswdFile({ domains: input.domains, accounts: input.accounts }),
  };
}

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-srs-activate-'));
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

function submissionSocketStat() {
  return {
    mode: 0o660,
    uid: POSTFIX_UID,
    gid: POSTFIX_GID,
    isFile: () => false,
    isDirectory: () => false,
    isSocket: () => true,
    isSymbolicLink: () => false,
  };
}

async function prepare(root, { failFirstDoveconf = false } = {}) {
  const liveRoot = path.join(root, 'live');
  const mapped = createMappedFs(liveRoot);
  for (const directory of ['/etc/postfix', '/etc/dovecot/conf.d', '/etc/rspamd/local.d', '/etc/default']) {
    await mkdir(mapped.mapPath(directory), { recursive: true });
  }
  const originalMainCf = Buffer.from('myhostname = mail.example.net\nmydestination = $myhostname, localhost\n');
  const originalMasterCf = Buffer.from('smtp inet n - y - - smtpd\n');
  await writeFile(mapped.mapPath(mailConfigBackupInternals.postfixMainCfPath), originalMainCf, { mode: 0o644 });
  await writeFile(mapped.mapPath(mailConfigBackupInternals.postfixMasterCfPath), originalMasterCf, { mode: 0o644 });

  const { preview, passwd } = srsFixture();
  const configManager = createMailConfigManager({ stagingRoot: path.join(root, 'staging') });
  await configManager.stageConfiguration(preview, {
    sensitiveArtifacts: [
      { path: mailTemplatePolicy.dovecotPasswdFilePath, content: passwd },
      { path: mailSrsTemplatePolicy.secretPath, content: SRS_SECRET_CONTENT },
    ],
  });
  const backupManager = createMailConfigBackupManager({
    backupRoot: path.join(root, 'backup'),
    liveLstatFn: mapped.lstatFn,
    liveReadFileFn: mapped.readFileFn,
  });
  await backupManager.backupConfiguration(preview, { transactionId: TRANSACTION_ID });

  const readinessPhases = [];
  const readinessInspector = {
    inspect: async (candidate, { phase } = {}) => {
      readinessPhases.push(phase);
      return {
        version: 1,
        sha256: phase === 'post' ? 'b'.repeat(64) : 'a'.repeat(64),
        previewSha256: candidate.sha256,
        phase,
        ready: true,
        blockers: [],
        sideEffects: false,
      };
    },
  };
  const calls = [];
  const postfixParameters = new Map();
  const masterParameters = new Map();
  let masterDefinition = null;
  let doveconfFailuresRemaining = failFirstDoveconf ? 1 : 0;
  const run = async (file, args) => {
    calls.push([file, [...args]]);
    if (file === '/usr/bin/getent') {
      if (args[1] === 'vmail') {
        return { stdout: `vmail:x:${VMAIL_UID}:${VMAIL_GID}::/var/lib/yunpanel/mail:/usr/sbin/nologin\n`, stderr: '' };
      }
      if (args[1] === 'postfix') {
        return { stdout: `postfix:x:${POSTFIX_UID}:${POSTFIX_GID}::/var/spool/postfix:/usr/sbin/nologin\n`, stderr: '' };
      }
      throw new Error('unexpected identity');
    }
    if (file === '/usr/sbin/postmap') {
      const source = args[0].replace(/^hash:/, '');
      await writeFile(mapped.mapPath(`${source}.db`), Buffer.from(`compiled:${source}\n`), { mode: 0o640 });
      return { stdout: '', stderr: '' };
    }
    if (file === '/usr/bin/sievec') {
      assert.deepEqual(args, [mailForwardingTemplatePolicy.sievePath]);
      await writeFile(mapped.mapPath(mailForwardingTemplatePolicy.compiledPath), Buffer.from('compiled-sieve'), { mode: 0o644 });
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
        return { stdout: '', stderr: '' };
      }
      return { stdout: `${masterDefinition ?? ''}\n`, stderr: '' };
    }
    if (file === '/usr/sbin/postconf' && args[0] === '-P') {
      const expression = args[1];
      const separator = expression.indexOf('=');
      if (separator >= 0) {
        masterParameters.set(expression.slice(0, separator), expression.slice(separator + 1));
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
  const lstatFn = async (value) => value === mailSubmissionTemplatePolicy.dovecotAuthSocket
    ? submissionSocketStat()
    : mapped.lstatFn(value);
  const activator = createMailConfigActivator({
    configManager,
    backupManager,
    readinessInspector,
    run,
    ...mapped,
    lstatFn,
  });
  return {
    activator,
    calls,
    mapped,
    originalMainCf,
    originalMasterCf,
    passwd,
    preview,
    readinessPhases,
  };
}

test('activates protected SRS state and restarts PostSRSd before final mail health', async () => withTempDirectory(async (root) => {
  const context = await prepare(root);
  const result = await context.activator.activateConfiguration(context.preview, { transactionId: TRANSACTION_ID });

  assert.equal(result.applied, true);
  assert.deepEqual(context.readinessPhases, ['pre', 'post']);
  assert.equal(JSON.stringify(result).includes(SRS_SECRET), false);
  assert.equal(JSON.stringify(result).includes(ARGON2ID_HASH), false);

  const secretPath = context.mapped.mapPath(mailSrsTemplatePolicy.secretPath);
  assert.equal(await readFile(secretPath, 'utf8'), SRS_SECRET_CONTENT);
  assert.equal((await stat(secretPath)).mode & 0o777, 0o600);
  const secretMetadata = await context.mapped.lstatFn(mailSrsTemplatePolicy.secretPath);
  assert.equal(secretMetadata.uid, 0);
  assert.equal(secretMetadata.gid, 0);

  const defaults = context.preview.artifacts.find((artifact) => artifact.path === mailSrsTemplatePolicy.defaultsPath);
  assert.equal(await readFile(context.mapped.mapPath(mailSrsTemplatePolicy.defaultsPath), 'utf8'), defaults.content);
  assert.equal((await stat(context.mapped.mapPath(mailSrsTemplatePolicy.defaultsPath))).mode & 0o777, 0o640);

  const restartIndex = context.calls.findIndex(([file, args]) => file === '/usr/bin/systemctl'
    && args[0] === 'restart' && args[1] === mailSrsTemplatePolicy.serviceUnit);
  const validateIndex = context.calls.findIndex(([file, args]) => file === '/usr/sbin/postfix' && args[0] === 'check');
  assert.ok(restartIndex >= 0);
  assert.ok(validateIndex > restartIndex);
  assert.equal(context.calls.some(([file, args]) => file === '/usr/bin/systemctl'
    && args.join(' ') === `is-active --quiet ${mailSrsTemplatePolicy.serviceUnit}`), true);
}));

test('validation failure removes newly-created SRS files and stops PostSRSd during rollback', async () => withTempDirectory(async (root) => {
  const context = await prepare(root, { failFirstDoveconf: true });

  await assert.rejects(
    context.activator.activateConfiguration(context.preview, { transactionId: TRANSACTION_ID }),
    (error) => error instanceof MailConfigActivationError && error.code === 'mail_config_validation_failed',
  );

  await assert.rejects(lstat(context.mapped.mapPath(mailSrsTemplatePolicy.defaultsPath)), (error) => error?.code === 'ENOENT');
  await assert.rejects(lstat(context.mapped.mapPath(mailSrsTemplatePolicy.secretPath)), (error) => error?.code === 'ENOENT');
  assert.deepEqual(await readFile(context.mapped.mapPath(mailConfigBackupInternals.postfixMainCfPath)), context.originalMainCf);
  assert.deepEqual(await readFile(context.mapped.mapPath(mailConfigBackupInternals.postfixMasterCfPath)), context.originalMasterCf);

  const runtimeCalls = context.calls.filter(([file, args]) => file === '/usr/bin/systemctl'
    && ['restart', 'stop'].includes(args[0]) && args[1] === mailSrsTemplatePolicy.serviceUnit);
  assert.deepEqual(runtimeCalls.map(([, args]) => args), [
    ['restart', mailSrsTemplatePolicy.serviceUnit],
    ['stop', mailSrsTemplatePolicy.serviceUnit],
  ]);
  assert.deepEqual(context.readinessPhases, ['pre', 'pre']);
}));
