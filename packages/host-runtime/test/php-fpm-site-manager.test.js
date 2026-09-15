import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPhpFpmSiteManager,
  PhpFpmSiteManagerError,
} from '../src/php-fpm-site-manager.js';

const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const unixUser = 'yunapp-4dc352e64a14';
const homeDirectory = `/var/lib/yunpanel/data/${applicationId}`;
const currentRelease = `/var/lib/yunpanel/apps/${applicationId}/current`;
const configPath = `/etc/php/8.3/fpm/pool.d/yunpanel-${unixUser}.conf`;
const socketPath = `/run/php/yunpanel-${unixUser}.sock`;

function intent(overrides = {}) {
  return {
    websiteId,
    applicationId,
    unixUser,
    documentRoot: `${currentRelease}/public`,
    ...overrides,
  };
}

function missing(code = 'ENOENT') {
  const error = new Error('missing');
  error.code = code;
  return error;
}

function identityManager({ satisfied = true } = {}) {
  return {
    inspect: async (value) => {
      assert.deepEqual(value, {
        user: unixUser,
        homeDirectory,
        websiteId,
        applicationId,
      });
      if (!satisfied) return { satisfied: false, reason: 'website_identity_workspace_missing' };
      return {
        satisfied: true,
        user: unixUser,
        uid: 1201,
        gid: 1201,
        homeDirectory,
        shell: '/usr/sbin/nologin',
        homeMode: 0o750,
        pathContract: {},
      };
    },
  };
}

function fakeHost({ packageInstalled = false, serviceActive = false } = {}) {
  const entries = new Map();
  const calls = [];

  const readFileFn = async (file) => {
    const entry = entries.get(file);
    if (!entry || entry.type !== 'file') throw missing();
    return entry.content;
  };
  const writeFileFn = async (file, content, options = {}) => {
    entries.set(file, {
      type: 'file',
      content: String(content),
      mode: options.mode ?? 0o600,
      uid: 0,
      gid: 0,
    });
  };
  const renameFn = async (source, target) => {
    const entry = entries.get(source);
    if (!entry) throw missing();
    entries.set(target, entry);
    entries.delete(source);
  };
  const rmFn = async (file) => { entries.delete(file); };
  const mkdirFn = async () => {};
  const lstatFn = async (file) => {
    const entry = entries.get(file);
    if (!entry) throw missing();
    return {
      uid: entry.uid ?? 0,
      gid: entry.gid ?? 0,
      mode: entry.mode ?? 0,
      isFile: () => entry.type === 'file',
      isSocket: () => entry.type === 'socket',
      isSymbolicLink: () => false,
    };
  };

  const run = async (file, args) => {
    calls.push([file, [...args]]);
    if (file === '/usr/bin/dpkg-query') {
      if (!packageInstalled) throw missing(1);
      return { stdout: 'install ok installed\t8.3.6-0ubuntu0.24.04.4' };
    }
    if (file === '/usr/bin/apt-get') {
      packageInstalled = true;
      return { stdout: '' };
    }
    if (file === '/usr/sbin/php-fpm8.3') {
      return { stdout: 'configuration file test is successful' };
    }
    if (file === '/usr/bin/systemctl' && args[0] === 'is-active') {
      if (!serviceActive) throw missing(3);
      return { stdout: '' };
    }
    if (file === '/usr/bin/systemctl' && args[0] === 'enable') {
      serviceActive = true;
      entries.set(socketPath, { type: 'socket', mode: 0o660, uid: 33, gid: 33 });
      return { stdout: '' };
    }
    if (file === '/usr/bin/systemctl' && args[0] === 'reload') {
      if (entries.has(configPath)) {
        entries.set(socketPath, { type: 'socket', mode: 0o660, uid: 33, gid: 33 });
      } else {
        entries.delete(socketPath);
      }
      return { stdout: '' };
    }
    throw new Error(`unexpected command ${file} ${args.join(' ')}`);
  };

  return {
    entries,
    calls,
    run,
    lstatFn,
    mkdirFn,
    readFileFn,
    renameFn,
    rmFn,
    writeFileFn,
    packageInstalled: () => packageInstalled,
    serviceActive: () => serviceActive,
  };
}

function manager(host, options = {}) {
  return createPhpFpmSiteManager({
    receiptRoot: '/var/lib/yunpanel/staging/php-fpm-sites',
    identityManager: options.identityManager ?? identityManager(),
    run: host.run,
    lstatFn: host.lstatFn,
    mkdirFn: host.mkdirFn,
    readFileFn: host.readFileFn,
    renameFn: host.renameFn,
    rmFn: host.rmFn,
    writeFileFn: host.writeFileFn,
  });
}

test('PHP-FPM site apply installs distro FPM and activates a dedicated Website pool', async () => {
  const host = fakeHost();
  const siteManager = manager(host);

  const result = await siteManager.apply(intent(), { operationId });

  assert.equal(result.satisfied, true);
  assert.equal(result.adapter, 'php-fpm');
  assert.equal(result.websiteId, websiteId);
  assert.equal(result.applicationId, applicationId);
  assert.equal(result.unixUser, unixUser);
  assert.equal(result.unixUid, 1201);
  assert.equal(result.unixGid, 1201);
  assert.equal(result.configPath, configPath);
  assert.equal(result.socketPath, socketPath);
  assert.equal(result.created, true);
  assert.equal(host.packageInstalled(), true);
  assert.equal(host.serviceActive(), true);
  assert.equal(host.entries.get(configPath)?.mode, 0o640);
  assert.match(host.entries.get(configPath)?.content ?? '', new RegExp(`user = ${unixUser}`));
  assert.match(host.entries.get(configPath)?.content ?? '', new RegExp(`listen = ${socketPath.replaceAll('.', '\\.')}`));
  assert.equal(host.calls.some(([file]) => file === '/usr/bin/apt-get'), true);
  assert.equal(host.calls.some(([file, args]) => file === '/usr/sbin/php-fpm8.3' && args[0] === '--test'), true);
  assert.equal(host.calls.some(([file, args]) => file === '/usr/bin/systemctl' && args[0] === 'enable'), true);
});

test('PHP-FPM site apply refuses to provision before canonical Website identity is ready', async () => {
  const host = fakeHost();
  const siteManager = manager(host, { identityManager: identityManager({ satisfied: false }) });

  await assert.rejects(
    siteManager.apply(intent(), { operationId }),
    (error) => error instanceof PhpFpmSiteManagerError && error.code === 'php_fpm_identity_required',
  );
  assert.equal(host.calls.some(([file]) => file === '/usr/bin/apt-get'), false);
});

test('PHP-FPM site intent rejects a Unix user that does not match canonical Application identity', async () => {
  const host = fakeHost();
  const siteManager = manager(host);

  await assert.rejects(
    siteManager.inspect(intent({ unixUser: 'yunapp-aaaaaaaaaaaa' })),
    (error) => error instanceof PhpFpmSiteManagerError && error.code === 'php_fpm_site_identity_mismatch',
  );
});

test('PHP-FPM site apply fails closed on an existing foreign pool configuration', async () => {
  const host = fakeHost({ packageInstalled: true });
  host.entries.set(configPath, { type: 'file', content: '[foreign]\n', mode: 0o640, uid: 0, gid: 0 });
  const siteManager = manager(host);

  await assert.rejects(
    siteManager.apply(intent(), { operationId }),
    (error) => error instanceof PhpFpmSiteManagerError && error.code === 'php_fpm_pool_conflict',
  );
  assert.equal(host.entries.get(configPath)?.content, '[foreign]\n');
});

test('PHP-FPM inspection reports an inactive or missing socket without claiming readiness', async () => {
  const host = fakeHost({ packageInstalled: true, serviceActive: true });
  const siteManager = manager(host);
  await siteManager.apply(intent(), { operationId });
  host.entries.delete(socketPath);

  const result = await siteManager.inspect(intent());
  assert.equal(result.satisfied, false);
  assert.equal(result.reason, 'php_fpm_socket_missing');
});

test('PHP-FPM compensation removes only the operation-owned pool and preserves shared service', async () => {
  const host = fakeHost({ packageInstalled: true });
  const siteManager = manager(host);
  await siteManager.apply(intent(), { operationId });

  const result = await siteManager.compensate(intent(), { operationId });

  assert.equal(result.satisfied, true);
  assert.equal(result.restoredPrevious, false);
  assert.equal(result.preservedExisting, false);
  assert.equal(result.receiptState, 'compensated');
  assert.equal(host.entries.has(configPath), false);
  assert.equal(host.serviceActive(), true);
  assert.equal(host.calls.some(([file, args]) => file === '/usr/bin/systemctl' && args[0] === 'reload'), true);
});

test('PHP-FPM compensation refuses destructive restore after pool content drift', async () => {
  const host = fakeHost({ packageInstalled: true });
  const siteManager = manager(host);
  await siteManager.apply(intent(), { operationId });
  host.entries.set(configPath, { type: 'file', content: '[changed-after-apply]\n', mode: 0o640, uid: 0, gid: 0 });

  await assert.rejects(
    siteManager.compensate(intent(), { operationId }),
    (error) => error instanceof PhpFpmSiteManagerError && error.code === 'php_fpm_compensation_drift',
  );
  assert.equal(host.entries.get(configPath)?.content, '[changed-after-apply]\n');
});
