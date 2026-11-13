import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import {
  elFinderFpmPoolPath,
  elFinderFpmSocketPath,
  elFinderFpmTemplateInternals,
  renderElFinderFpmPool,
} from '@yunpanel/config-templates';
import { createApplicationIdentity } from '../src/application-identity.js';
import {
  createElFinderFpmSiteManager,
  ElFinderFpmSiteManagerError,
  elFinderFpmSiteManagerInternals as internals,
} from '../src/elfinder-fpm-site-manager.js';

const websiteId = '12345678-1234-4234-8234-123456789012';
const applicationId = '22345678-1234-4234-8234-123456789012';
const operationId = '32345678-1234-4234-8234-123456789012';
const identity = createApplicationIdentity(applicationId);
const unixUser = elFinderFpmTemplateInternals.applicationUser(applicationId);
const configPath = elFinderFpmPoolPath(unixUser);
const socketPath = elFinderFpmSocketPath(unixUser);
const intent = Object.freeze({ websiteId, applicationId, unixUser });

function enoent() {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}

function fileStat(mode = 0o600) {
  return {
    uid: 0,
    gid: 0,
    mode,
    isFile: () => true,
    isSocket: () => false,
    isSymbolicLink: () => false,
  };
}

function socketStat(mode = 0o660) {
  return {
    uid: 33,
    gid: 33,
    mode,
    isFile: () => false,
    isSocket: () => true,
    isSymbolicLink: () => false,
  };
}

function fixture({
  initialConfig = null,
  failFirstConfigTest = false,
  identitySatisfied = true,
} = {}) {
  const calls = [];
  const files = new Map();
  let socketExists = initialConfig !== null;
  let active = initialConfig !== null;
  let failConfigTest = failFirstConfigTest;

  if (initialConfig !== null) files.set(configPath, { content: initialConfig, mode: 0o600 });

  const identityManager = {
    async inspect(input) {
      calls.push(['identity', structuredClone(input)]);
      if (!identitySatisfied) return { satisfied: false, reason: 'fixture_identity_missing' };
      return {
        satisfied: true,
        user: unixUser,
        homeDirectory: identity.paths.workspace.homeDirectory,
        uid: 2001,
        gid: 2001,
        homeMode: 0o750,
      };
    },
  };

  const run = async (file, args) => {
    calls.push(['run', file, [...args]]);
    if (file === '/usr/bin/dpkg-query') {
      return { stdout: 'install ok installed\t8.3.6-0ubuntu0.24.04.1' };
    }
    if (file === '/usr/sbin/php-fpm8.3') {
      if (failConfigTest) {
        failConfigTest = false;
        throw new Error('fixture invalid config');
      }
      return { stdout: '' };
    }
    if (file === '/usr/bin/systemctl' && args[0] === 'is-active') {
      if (!active) throw new Error('inactive');
      return { stdout: '' };
    }
    if (file === '/usr/bin/systemctl' && args[0] === 'enable') {
      active = true;
      socketExists = true;
      return { stdout: '' };
    }
    if (file === '/usr/bin/systemctl' && args[0] === 'reload') {
      socketExists = files.has(configPath);
      return { stdout: '' };
    }
    if (file === '/usr/bin/apt-get') return { stdout: '' };
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
  };

  const readFileFn = async (target) => {
    const record = files.get(target);
    if (!record) throw enoent();
    return record.content;
  };
  const writeFileFn = async (target, value, options) => {
    calls.push(['write', target, options?.mode]);
    files.set(target, {
      content: String(value),
      mode: options?.mode ?? 0o600,
    });
  };
  const renameFn = async (from, to) => {
    const record = files.get(from);
    if (!record) throw enoent();
    files.set(to, record);
    files.delete(from);
  };
  const rmFn = async (target) => {
    files.delete(target);
    if (target === configPath) socketExists = false;
  };
  const lstatFn = async (target) => {
    if (target === configPath) {
      const record = files.get(target);
      if (!record) throw enoent();
      return fileStat(record.mode);
    }
    if (target === socketPath) {
      if (!socketExists) throw enoent();
      return socketStat();
    }
    throw enoent();
  };

  const manager = createElFinderFpmSiteManager({
    receiptRoot: '/receipts',
    identityManager,
    run,
    lstatFn,
    mkdirFn: async (target, options) => { calls.push(['mkdir', target, options?.mode]); },
    readFileFn,
    writeFileFn,
    renameFn,
    rmFn,
  });

  return {
    manager,
    calls,
    files,
    desired: renderElFinderFpmPool({
      websiteId,
      applicationId,
      unixUser,
      unixGroup: unixUser,
      homeDirectory: identity.paths.workspace.homeDirectory,
      temporaryDirectory: identity.paths.workspace.temporaryDirectory,
    }),
  };
}

test('elFinder FPM apply creates only the canonical per-Website pool and verifies its socket', async () => {
  const fx = fixture();
  const result = await fx.manager.apply(intent, { operationId });

  assert.equal(result.satisfied, true);
  assert.equal(result.created, true);
  assert.equal(result.unixUser, unixUser);
  assert.equal(result.root, identity.paths.workspace.homeDirectory);
  assert.equal(result.configPath, configPath);
  assert.equal(result.socketPath, socketPath);
  assert.equal(fx.files.get(configPath)?.content, fx.desired);
  assert.ok(fx.calls.some((entry) => entry[0] === 'run'
    && entry[1] === '/usr/sbin/php-fpm8.3' && entry[2][0] === '--test'));
  assert.ok(fx.calls.some((entry) => entry[0] === 'run'
    && entry[1] === '/usr/bin/systemctl' && entry[2].join(' ') === 'reload php8.3-fpm.service'));
  assert.equal(fx.calls.some((entry) => entry[0] === 'run' && entry[1] === '/usr/bin/useradd'), false);
});

test('elFinder FPM apply restores operation-before absence after configtest failure', async () => {
  const fx = fixture({ failFirstConfigTest: true });

  await assert.rejects(
    fx.manager.apply(intent, { operationId }),
    (error) => error instanceof ElFinderFpmSiteManagerError
      && error.code === 'elfinder_fpm_config_test_failed',
  );

  assert.equal(fx.files.has(configPath), false);
  assert.ok(fx.calls.some((entry) => entry[0] === 'run'
    && entry[1] === '/usr/sbin/php-fpm8.3'));
});

test('elFinder FPM refuses a foreign existing pool before durable mutation', async () => {
  const fx = fixture({ initialConfig: '[foreign]\nuser = root\n' });

  await assert.rejects(
    fx.manager.apply(intent, { operationId }),
    (error) => error instanceof ElFinderFpmSiteManagerError
      && error.code === 'elfinder_fpm_pool_conflict',
  );

  assert.equal(fx.files.get(configPath)?.content, '[foreign]\nuser = root\n');
  assert.equal(fx.calls.some((entry) => entry[0] === 'write' && entry[1] === configPath), false);
});

test('elFinder FPM compensation removes only the pool created by the operation', async () => {
  const fx = fixture();
  await fx.manager.apply(intent, { operationId });

  const result = await fx.manager.compensate(intent, { operationId });
  assert.equal(result.satisfied, true);
  assert.equal(result.preservedExisting, false);
  assert.equal(fx.files.has(configPath), false);

  const again = await fx.manager.compensate(intent, { operationId });
  assert.equal(again.satisfied, true);
  assert.equal(fx.files.has(configPath), false);
});

test('elFinder FPM requires an already-provisioned exact Website identity and workspace', async () => {
  const fx = fixture({ identitySatisfied: false });

  await assert.rejects(
    fx.manager.apply(intent, { operationId }),
    (error) => error instanceof ElFinderFpmSiteManagerError
      && error.code === 'elfinder_fpm_identity_required',
  );

  assert.equal(fx.files.has(configPath), false);
  assert.equal(fx.calls.some((entry) => entry[0] === 'run' && entry[1] === '/usr/bin/apt-get'), false);
});

test('elFinder FPM rejects forged Website Unix identity before inspection', async () => {
  const fx = fixture();
  await assert.rejects(
    fx.manager.inspect({ ...intent, unixUser: 'yunapp-ffffffffffff' }),
    (error) => error instanceof ElFinderFpmSiteManagerError
      && error.code === 'elfinder_fpm_identity_mismatch',
  );
});

// Runtime retirement outcomes are measured by native27 on the real shared FPM
// service: two fresh PHP siblings, normal static removal, actual journal reload
// count, earliest dynamic responses and normal cleanup. The old in-memory fake
// retirement/crash/inactive cases are not runtime evidence. Unsafe crash/service
// fault, retained/foreign live pool channels remain explicit native OPEN gates.
// Existing apply/configtest rollback/compensate compatibility tests above stay.
test('retirement refuses an unjournalled pool before any mutation (legacy compatibility)', async () => {
  const unknown = fixture({ initialConfig: 'operator configuration' });
  await assert.rejects(unknown.manager.retire(intent, { operationId }), error => error.code === 'elfinder_fpm_retirement_blocked');
  assert.equal(unknown.files.get(configPath).content, 'operator configuration');
  assert.deepEqual(unknown.calls, []);
});

const spec = internals.normalizeIntent(intent);
function receiptInput(overrides = {}) {
  return { version: 1, operationId, websiteId, applicationId, unixUser,
    specDigest: internals.specDigest(spec), configSha256: spec.preview.sha256,
    mutated: true, previousConfig: null, state: 'active', ...overrides };
}
async function privateReceipt(t, content, untrustedAlias = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-elfinder-retirement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, `${operationId}.json`);
  if (content !== undefined) await writeFile(target, content, { mode: 0o600 });
  let receiptRoot = root;
  if (untrustedAlias) {
    receiptRoot = `${root}-alias`; await symlink(root, receiptRoot, 'dir');
    t.after(() => rm(receiptRoot, { force: true }));
  }
  return { root, target, receiptRoot, manager: createElFinderFpmSiteManager({ receiptRoot }) };
}

test('real empty untrusted receipt directory cannot start retirement or create a checkpoint', async t => {
  const fx = await privateReceipt(t, undefined, true);
  await assert.rejects(fx.manager.retire(intent, { operationId }), { code: 'elfinder_fpm_retirement_checkpoint_invalid' });
  assert.deepEqual(await readdir(fx.root), []);
});

test('real malformed receipt in an untrusted directory is preserved before service access', async t => {
  const contents = '{'; const fx = await privateReceipt(t, contents, true);
  await assert.rejects(fx.manager.retire(intent, { operationId }), { code: 'elfinder_fpm_retirement_checkpoint_invalid' });
  assert.equal(await readFile(fx.target, 'utf8'), contents);
  assert.deepEqual(await readdir(fx.root), [`${operationId}.json`]);
});

test('real foreign receipt in an untrusted directory is preserved without a checkpoint', async t => {
  const contents = JSON.stringify(receiptInput({ websiteId: applicationId }));
  const fx = await privateReceipt(t, contents, true);
  await assert.rejects(fx.manager.retire(intent, { operationId }), { code: 'elfinder_fpm_retirement_checkpoint_invalid' });
  assert.equal(await readFile(fx.target, 'utf8'), contents);
  assert.deepEqual(await readdir(fx.root), [`${operationId}.json`]);
});

test('real retained receipt in an untrusted directory is not converted into deletion ownership', async t => {
  const contents = JSON.stringify(receiptInput({ mutated: false, previousConfig: renderElFinderFpmPool(spec.templateInput) }));
  const fx = await privateReceipt(t, contents, true);
  await assert.rejects(fx.manager.retire(intent, { operationId }), { code: 'elfinder_fpm_retirement_checkpoint_invalid' });
  assert.equal(await readFile(fx.target, 'utf8'), contents);
  assert.deepEqual(await readdir(fx.root), [`${operationId}.json`]);
});

test('real private receipt preflight cannot be bypassed by compensated state', async t => {
  const contents = JSON.stringify(receiptInput({ state: 'compensated' }));
  const fx = await privateReceipt(t, contents), alias = `${fx.root}-alias`;
  t.after(() => rm(alias, { force: true })); await symlink(fx.root, alias, 'dir');
  const manager = createElFinderFpmSiteManager({ receiptRoot: alias });
  await assert.rejects(manager.retire(intent, { operationId }), { code: 'elfinder_fpm_retirement_checkpoint_invalid' });
  assert.equal(await readFile(fx.target, 'utf8'), contents);
  assert.deepEqual(await readdir(fx.root), [`${operationId}.json`]);
});

// These are pure schema inputs, never canned process/socket/HTTP observations.
function checkpointInput(overrides = {}) {
  return { ...internals.retirementBinding(operationId, spec), state: 'prepared', wasActive: true,
    mainPid: process.pid, socketUid: process.getuid(), socketGid: process.getgid(), reloadAttempted: false,
    protectedListeners: [{ path: '/run/php/sibling-a.sock', uid: process.getuid(), gid: process.getgid(), mode: 0o660 },
      { path: '/run/php/sibling-b.sock', uid: process.getuid(), gid: process.getgid(), mode: 0o660 }], ...overrides };
}
test('retirement schema binds exact operation, runtime and immutable sibling identities', () => {
  const input = checkpointInput(), value = internals.normalizeRetirementCheckpoint(input, { operationId, spec });
  assert.equal(value.serviceUnit, 'php8.3-fpm.service'); assert.deepEqual(value.protectedListeners, input.protectedListeners);
  assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(value.protectedListeners), true);
  assert.equal(Object.isFrozen(value.protectedListeners[0]), true);
  const invalid = [
    { operationId: websiteId }, { websiteId: applicationId }, { applicationId: websiteId }, { unixUser: 'root' },
    { specDigest: '0'.repeat(64) }, { configSha256: '0'.repeat(64) }, { serviceUnit: 'php8.2-fpm.service' },
    { socketPath: '/run/php/foreign.sock' }, { unexpected: true }, { state: 'verified' },
    { state: 'prepared', reloadAttempted: true },
    { state: 'reload_started', reloadAttempted: false }, { wasActive: false }, { mainPid: 0 },
    { socketUid: -1 }, { socketGid: 0.5 }, { protectedListeners: [input.protectedListeners[0], input.protectedListeners[0]] },
    { protectedListeners: [...input.protectedListeners].reverse() },
    { protectedListeners: [{ ...input.protectedListeners[0], path: spec.preview.socketPath }] },
    { protectedListeners: [{ ...input.protectedListeners[0], path: '/run/php/../foreign.sock' }] },
    { protectedListeners: [{ ...input.protectedListeners[0], extra: true }] },
  ];
  for (const change of invalid) assert.throws(() => internals.normalizeRetirementCheckpoint(checkpointInput(change), { operationId, spec }),
    { code: 'elfinder_fpm_retirement_checkpoint_invalid' });
});

test('reload intent and inactive schema states cannot manufacture terminal readiness', () => {
  const started = internals.normalizeRetirementCheckpoint(checkpointInput({ state: 'reload_started', reloadAttempted: true }), { operationId, spec });
  assert.equal(started.state, 'reload_started'); assert.equal('satisfied' in started, false);
  const inactive = checkpointInput({ wasActive: false, mainPid: 0, protectedListeners: [] });
  assert.equal(internals.normalizeRetirementCheckpoint(inactive, { operationId, spec }).wasActive, false);
  assert.throws(() => internals.normalizeRetirementCheckpoint({ ...inactive, reloadAttempted: true }, { operationId, spec }),
    { code: 'elfinder_fpm_retirement_checkpoint_invalid' });
});

test('original receipt schema preserves retained state and rejects foreign bindings', () => {
  const retained = receiptInput({ mutated: false, previousConfig: renderElFinderFpmPool(spec.templateInput) });
  assert.equal(internals.normalizeReceipt(retained, { operationId, spec }).mutated, false);
  assert.equal(internals.normalizeReceipt(retained, { operationId, spec }).previousConfig, retained.previousConfig);
  for (const value of [null, [], receiptInput({ websiteId: applicationId }), receiptInput({ operationId: websiteId }),
    receiptInput({ applicationId: websiteId }), receiptInput({ unixUser: 'root' }), receiptInput({ state: 'retired' }),
    receiptInput({ configSha256: '0'.repeat(64) }), receiptInput({ specDigest: '0'.repeat(64) })]) {
    assert.throws(() => internals.normalizeReceipt(value, { operationId, spec }), { code: 'elfinder_fpm_receipt_invalid' });
  }
});

async function fifoAttempt(target, method, kind, receiptRoot) {
  const moduleUrl = new URL('../src/elfinder-fpm-site-manager.js', import.meta.url).href;
  const script = `
    import { createElFinderFpmSiteManager, elFinderFpmSiteManagerInternals } from ${JSON.stringify(moduleUrl)};
    const [target, method, kind, root, rawIntent, operationId] = process.argv.slice(1);
    const manager = method === 'reader' ? null : createElFinderFpmSiteManager({ receiptRoot: root });
    process.send({ began: true });
    try {
      if (method === 'reader') await elFinderFpmSiteManagerInternals.readRetirementJson(target, undefined, kind);
      else await manager[method](JSON.parse(rawIntent), { operationId });
      process.send({ resolved: true });
    } catch (error) { process.send({ errorName: error.name, errorCode: error.code ?? null }); }
    finally { process.disconnect(); }
  `;
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, target, method, kind,
      receiptRoot, JSON.stringify(intent), operationId], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const result = { began: false, timedOut: false, observation: null }; let timer;
    const bound = duration => { clearTimeout(timer); timer = setTimeout(() => { result.timedOut = true; child.kill('SIGKILL'); }, duration); };
    bound(5000);
    child.on('message', value => {
      if (value.began) { result.began = true; bound(1500); }
      else result.observation = value;
    });
    child.on('error', () => { result.spawnFailed = true; });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ ...result, code, signal }); });
  });
}

for (const [method, kind, expectedCode] of [
  ['reader', 'receipt', 'elfinder_fpm_receipt_invalid'],
  ['reader', 'checkpoint', 'elfinder_fpm_retirement_checkpoint_invalid'],
  ['retire', 'receipt', 'elfinder_fpm_retirement_checkpoint_invalid'],
  ['inspectRetirement', 'receipt', 'elfinder_fpm_retirement_checkpoint_invalid'],
]) test(`real FIFO ${method}/${kind} is rejected without blocking or changing its inode`, async t => {
  const fx = await privateReceipt(t, undefined, method !== 'reader'), suffix = kind === 'checkpoint' ? '.retirement.json' : '.json';
  const target = path.join(fx.root, operationId + suffix);
  execFileSync('/usr/bin/mkfifo', ['-m', '600', target], { stdio: 'ignore' });
  const before = await lstat(target);
  assert.equal(before.isFIFO(), true);
  const result = await fifoAttempt(target, method, kind, fx.receiptRoot);
  assert.equal(result.began, true); assert.equal(result.timedOut, false, 'A real FIFO open must not wait for a writer');
  assert.equal(result.code, 0); assert.equal(result.signal, null);
  assert.deepEqual(result.observation, { errorName: 'ElFinderFpmSiteManagerError', errorCode: expectedCode });
  const after = await lstat(target);
  assert.equal(after.isFIFO(), true); assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
  assert.equal(after.mode, before.mode); assert.equal(after.uid, before.uid); assert.equal(after.gid, before.gid);
  assert.deepEqual(await readdir(fx.root), [operationId + suffix]);
});

