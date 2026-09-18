import assert from 'node:assert/strict';
import test from 'node:test';
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
