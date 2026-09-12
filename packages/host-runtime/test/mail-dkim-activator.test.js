import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
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
  mailDkimTemplatePolicy,
  previewRspamdDkimSigningConfig,
} from '@yunpanel/config-templates';
import {
  createMailDkimActivator,
  MailDkimActivationError,
  mailDkimActivatorInternals,
} from '../src/index.js';

const PAIR = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const OLD_PAIR = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const PUBLIC_KEY = Buffer.from(PAIR.publicKey).toString('base64');
const POLICY = Object.freeze({ domain: 'example.com', selector: 'mail-2026', publicKey: PUBLIC_KEY });
const TRANSACTION_ID = 'mail-dkim-job-001';

function bundle() {
  return {
    preview: previewRspamdDkimSigningConfig([POLICY]),
    keys: [{ ...POLICY, privateKey: PAIR.privateKey }],
  };
}

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-dkim-activate-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function createMappedFs(root) {
  const owners = new Map();
  const mapPath = (value) => path.join(root, value.replace(/^\/+/, ''));
  return {
    mapPath,
    setOwner(value, uid, gid) { owners.set(mapPath(value), { uid, gid }); },
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
    rmFn: (value, options) => rm(mapPath(value), options),
    rmdirFn: (value) => rmdir(mapPath(value)),
    writeFileFn: (value, content, options) => writeFile(mapPath(value), content, options),
    chmodFn: (value, mode) => chmod(mapPath(value), mode),
    chownFn: async (value, uid, gid) => { owners.set(mapPath(value), { uid, gid }); },
  };
}

async function makeDirectory(mapped, value, mode = 0o755, uid = 0, gid = 0) {
  await mkdir(mapped.mapPath(value), { recursive: true, mode });
  await chmod(mapped.mapPath(value), mode);
  mapped.setOwner(value, uid, gid);
}

async function makeFile(mapped, value, content, mode, uid = 0, gid = 0) {
  await mkdir(path.dirname(mapped.mapPath(value)), { recursive: true });
  await writeFile(mapped.mapPath(value), content, { mode });
  await chmod(mapped.mapPath(value), mode);
  mapped.setOwner(value, uid, gid);
}

async function prepare(root, {
  identity = '_rspamd:x:113:119::/var/lib/rspamd:/usr/sbin/nologin\n',
  failFirstConfigtest = false,
  parent = null,
  keyRoot = null,
  previous = null,
} = {}) {
  const mapped = createMappedFs(root);
  await makeDirectory(mapped, '/etc/rspamd', 0o755, 0, 0);
  await makeDirectory(mapped, '/etc/rspamd/local.d', 0o755, 0, 0);
  if (parent) await makeDirectory(mapped, mailDkimActivatorInternals.liveKeyParent, parent.mode, parent.uid, parent.gid);
  if (keyRoot) await makeDirectory(mapped, mailDkimTemplatePolicy.keyRoot, keyRoot.mode, keyRoot.uid, keyRoot.gid);
  if (previous) {
    await makeFile(mapped, mailDkimTemplatePolicy.configPath, previous.config, previous.configMode, previous.configUid, previous.configGid);
    await makeFile(
      mapped,
      mailDkimTemplatePolicy.keyPath(POLICY.domain, POLICY.selector),
      previous.privateKey,
      previous.keyMode,
      previous.keyUid,
      previous.keyGid,
    );
  }

  const calls = [];
  let configtestFailures = failFirstConfigtest ? 1 : 0;
  const run = async (file, args) => {
    calls.push([file, [...args]]);
    if (file === '/usr/bin/getent') return { stdout: identity, stderr: '' };
    if (file === '/usr/bin/rspamadm' && args[0] === 'configtest' && configtestFailures > 0) {
      configtestFailures -= 1;
      throw new Error('fixture rspamd config failure');
    }
    return { stdout: '', stderr: '' };
  };
  const activator = createMailDkimActivator({
    backupRoot: '/var/lib/yunpanel/recovery/mail-dkim-test',
    run,
    ...mapped,
  });
  return { activator, calls, mapped };
}

async function metadata(mapped, value) {
  const result = await mapped.lstatFn(value);
  return { mode: result.mode & 0o7777, uid: result.uid, gid: result.gid };
}

test('activates DKIM signing with root:rspamd private access and secret-free result', async () => withTempDirectory(async (root) => {
  const context = await prepare(root);
  const desired = bundle();
  const result = await context.activator.activate(desired, { transactionId: TRANSACTION_ID });

  assert.deepEqual(result, {
    version: 1,
    previewSha256: desired.preview.sha256,
    applied: true,
    sideEffects: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /BEGIN PRIVATE KEY|privateKey/);
  assert.equal(await readFile(context.mapped.mapPath(mailDkimTemplatePolicy.configPath), 'utf8'), desired.preview.artifact.content);
  assert.equal(
    await readFile(context.mapped.mapPath(mailDkimTemplatePolicy.keyPath(POLICY.domain, POLICY.selector)), 'utf8'),
    PAIR.privateKey,
  );
  assert.deepEqual(await metadata(context.mapped, mailDkimActivatorInternals.liveKeyParent), { mode: 0o750, uid: 0, gid: 119 });
  assert.deepEqual(await metadata(context.mapped, mailDkimTemplatePolicy.keyRoot), { mode: 0o750, uid: 0, gid: 119 });
  assert.deepEqual(await metadata(context.mapped, mailDkimTemplatePolicy.configPath), { mode: 0o640, uid: 0, gid: 0 });
  assert.deepEqual(
    await metadata(context.mapped, mailDkimTemplatePolicy.keyPath(POLICY.domain, POLICY.selector)),
    { mode: 0o640, uid: 0, gid: 119 },
  );

  const manifest = await readFile(
    context.mapped.mapPath(`/var/lib/yunpanel/recovery/mail-dkim-test/${TRANSACTION_ID}/manifest.json`),
    'utf8',
  );
  assert.doesNotMatch(manifest, /BEGIN PRIVATE KEY|privateKey/);
  assert.deepEqual(context.calls, [
    ['/usr/bin/getent', ['passwd', '_rspamd']],
    ['/usr/bin/rspamadm', ['configtest']],
    ['/usr/bin/systemctl', ['reload', 'rspamd']],
    ['/usr/bin/systemctl', ['is-active', '--quiet', 'rspamd']],
  ]);
}));

test('rejects privileged rspamd identity and private/public mismatch before live mutation', async () => withTempDirectory(async (root) => {
  const privileged = await prepare(root, { identity: '_rspamd:x:0:0::/root:/usr/sbin/nologin\n' });
  await assert.rejects(
    privileged.activator.activate(bundle(), { transactionId: 'mail-dkim-job-002' }),
    (error) => error instanceof MailDkimActivationError && error.code === 'mail_dkim_rspamd_identity_invalid',
  );
  await assert.rejects(lstat(privileged.mapped.mapPath(mailDkimTemplatePolicy.configPath)), (error) => error?.code === 'ENOENT');
  await assert.rejects(lstat(privileged.mapped.mapPath(mailDkimTemplatePolicy.keyRoot)), (error) => error?.code === 'ENOENT');

  const mismatch = bundle();
  mismatch.keys[0] = { ...mismatch.keys[0], privateKey: OLD_PAIR.privateKey };
  const mismatchContext = await prepare(root);
  await assert.rejects(
    mismatchContext.activator.activate(mismatch, { transactionId: 'mail-dkim-job-003' }),
    (error) => error instanceof MailDkimActivationError && error.code === 'mail_dkim_private_key_mismatch',
  );
  assert.deepEqual(mismatchContext.calls, []);
}));

test('existing non-traversable rspamd DKIM parent blocks activation without changing live state', async () => withTempDirectory(async (root) => {
  const context = await prepare(root, {
    parent: { mode: 0o700, uid: 0, gid: 0 },
  });
  await assert.rejects(
    context.activator.activate(bundle(), { transactionId: 'mail-dkim-job-004' }),
    (error) => error instanceof MailDkimActivationError && error.code === 'mail_dkim_parent_not_traversable',
  );
  assert.deepEqual(await metadata(context.mapped, mailDkimActivatorInternals.liveKeyParent), { mode: 0o700, uid: 0, gid: 0 });
  await assert.rejects(lstat(context.mapped.mapPath(mailDkimTemplatePolicy.keyRoot)), (error) => error?.code === 'ENOENT');
  await assert.rejects(lstat(context.mapped.mapPath(mailDkimTemplatePolicy.configPath)), (error) => error?.code === 'ENOENT');
}));

test('config validation failure restores prior config, key and managed directory metadata exactly', async () => withTempDirectory(async (root) => {
  const previous = {
    config: 'enabled = false;\n',
    configMode: 0o644,
    configUid: 0,
    configGid: 0,
    privateKey: OLD_PAIR.privateKey,
    keyMode: 0o600,
    keyUid: 0,
    keyGid: 0,
  };
  const context = await prepare(root, {
    failFirstConfigtest: true,
    parent: { mode: 0o755, uid: 0, gid: 0 },
    keyRoot: { mode: 0o700, uid: 0, gid: 0 },
    previous,
  });

  await assert.rejects(
    context.activator.activate(bundle(), { transactionId: 'mail-dkim-job-005' }),
    (error) => error instanceof MailDkimActivationError && error.code === 'mail_dkim_config_validation_failed',
  );
  assert.equal(await readFile(context.mapped.mapPath(mailDkimTemplatePolicy.configPath), 'utf8'), previous.config);
  assert.equal(
    await readFile(context.mapped.mapPath(mailDkimTemplatePolicy.keyPath(POLICY.domain, POLICY.selector)), 'utf8'),
    previous.privateKey,
  );
  assert.deepEqual(await metadata(context.mapped, mailDkimTemplatePolicy.configPath), { mode: 0o644, uid: 0, gid: 0 });
  assert.deepEqual(
    await metadata(context.mapped, mailDkimTemplatePolicy.keyPath(POLICY.domain, POLICY.selector)),
    { mode: 0o600, uid: 0, gid: 0 },
  );
  assert.deepEqual(await metadata(context.mapped, mailDkimTemplatePolicy.keyRoot), { mode: 0o700, uid: 0, gid: 0 });
  assert.deepEqual(await metadata(context.mapped, mailDkimActivatorInternals.liveKeyParent), { mode: 0o755, uid: 0, gid: 0 });
  assert.deepEqual(context.calls.slice(-3), [
    ['/usr/bin/rspamadm', ['configtest']],
    ['/usr/bin/systemctl', ['reload', 'rspamd']],
    ['/usr/bin/systemctl', ['is-active', '--quiet', 'rspamd']],
  ]);
}));

test('a completed recovery transaction is never overwritten by a second activation', async () => withTempDirectory(async (root) => {
  const context = await prepare(root);
  const desired = bundle();
  await context.activator.activate(desired, { transactionId: 'mail-dkim-job-006' });
  const before = await readFile(context.mapped.mapPath(mailDkimTemplatePolicy.configPath), 'utf8');

  await assert.rejects(
    context.activator.activate(desired, { transactionId: 'mail-dkim-job-006' }),
    (error) => error instanceof MailDkimActivationError && error.code === 'mail_dkim_backup_exists',
  );
  assert.equal(await readFile(context.mapped.mapPath(mailDkimTemplatePolicy.configPath), 'utf8'), before);
}));

test('live artifact drift after backup fails closed before replacement', async () => withTempDirectory(async (root) => {
  const context = await prepare(root, {
    parent: { mode: 0o755, uid: 0, gid: 0 },
  });
  let configChecks = 0;
  const originalLstat = context.mapped.lstatFn;
  const activator = createMailDkimActivator({
    backupRoot: '/var/lib/yunpanel/recovery/mail-dkim-drift',
    run: async (file, args) => {
      if (file === '/usr/bin/getent') return { stdout: '_rspamd:x:113:119::/var/lib/rspamd:/usr/sbin/nologin\n', stderr: '' };
      return { stdout: '', stderr: '' };
    },
    ...context.mapped,
    lstatFn: async (value) => {
      if (value === mailDkimTemplatePolicy.configPath) {
        configChecks += 1;
        if (configChecks === 2) {
          await makeFile(context.mapped, value, 'changed after backup\n', 0o640, 0, 0);
        }
      }
      return originalLstat(value);
    },
  });
  await assert.rejects(
    activator.activate(bundle(), { transactionId: 'mail-dkim-job-007' }),
    (error) => error instanceof MailDkimActivationError && error.code === 'mail_dkim_live_state_changed',
  );
  assert.equal(await readFile(context.mapped.mapPath(mailDkimTemplatePolicy.configPath), 'utf8'), 'changed after backup\n');
}));
