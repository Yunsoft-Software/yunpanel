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
const documentRoot = `${currentRelease}/public`;
const configPath = `/etc/php/8.3/fpm/pool.d/yunpanel-${unixUser}.conf`;
const socketPath = `/run/php/yunpanel-${unixUser}.sock`;

function intent(overrides = {}) {
  return {
    websiteId,
    applicationId,
    unixUser,
    documentRoot,
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
  const entries = new Map([
    [documentRoot, { type: 'directory', mode: 0o750, uid: 1201, gid: 1201 }],
  ]);
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
      isDirectory: () => entry.type === 'directory',
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
    if (file === '/usr/bin/apt-cache') {
      return { stdout: 'Package: php8.2-fpm\nCandidate: 8.2.18-1+ubuntu24.04.1+deb.sury.org+1\nVersion table:\n *** 8.2.18-1+ubuntu24.04.1+deb.sury.org+1 500\n     500 https://ppa.launchpadcontent.net/ondrej/php/ubuntu noble/main amd64 Packages\n' };
    }
    if (file === '/usr/bin/apt-get') {
      packageInstalled = true;
      return { stdout: '' };
    }
    if (file.startsWith('/usr/sbin/php-fpm')) {
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
      const hasAnyPool = [...entries.keys()].some((k) => k.includes('/fpm/pool.d/'));
      if (hasAnyPool) {
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
  assert.equal(result.documentRoot, documentRoot);
  assert.equal(result.documentRootMode, 0o750);
  assert.equal(result.configPath, configPath);
  assert.equal(result.socketPath, socketPath);
  assert.equal(result.created, true);
  assert.equal(host.packageInstalled(), true);
  assert.equal(host.serviceActive(), true);
  assert.equal(host.entries.get(configPath)?.mode, 0o600);
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

test('PHP-FPM site apply refuses to mutate the host before the isolated document root exists', async () => {
  const host = fakeHost();
  host.entries.delete(documentRoot);
  const siteManager = manager(host);

  await assert.rejects(
    siteManager.apply(intent(), { operationId }),
    (error) => error instanceof PhpFpmSiteManagerError && error.code === 'php_fpm_document_root_required',
  );
  assert.equal(host.calls.some(([file]) => file === '/usr/bin/apt-get'), false);
  assert.equal(host.entries.has(configPath), false);
});

test('PHP-FPM site inspection rejects document-root ownership or world-access drift', async () => {
  for (const entry of [
    { type: 'directory', mode: 0o750, uid: 1300, gid: 1201 },
    { type: 'directory', mode: 0o755, uid: 1201, gid: 1201 },
  ]) {
    const host = fakeHost({ packageInstalled: true });
    host.entries.set(documentRoot, entry);
    const siteManager = manager(host);
    await assert.rejects(
      siteManager.inspect(intent()),
      (error) => error instanceof PhpFpmSiteManagerError && error.code === 'php_fpm_document_root_drift',
    );
  }
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
  host.entries.set(configPath, { type: 'file', content: '[foreign]\n', mode: 0o600, uid: 0, gid: 0 });
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
  host.entries.set(configPath, { type: 'file', content: '[changed-after-apply]\n', mode: 0o600, uid: 0, gid: 0 });

  await assert.rejects(
    siteManager.compensate(intent(), { operationId }),
    (error) => error instanceof PhpFpmSiteManagerError && error.code === 'php_fpm_compensation_drift',
  );
  assert.equal(host.entries.get(configPath)?.content, '[changed-after-apply]\n');
});


test('PHP-FPM migration preview snapshots pool ownership, receipt, service and socket without mutation', async () => {
  const host = fakeHost();
  const siteManager = manager(host);
  await siteManager.apply(intent(), { operationId });
  const mutationCallsBefore = host.calls.filter(([file, args]) => file === '/usr/bin/apt-get'
    || (file === '/usr/bin/systemctl' && ['enable', 'reload'].includes(args[0]))).length;

  const preview = await siteManager.previewMigration(intent(), { operationId });

  assert.equal(preview.version, 1);
  assert.equal(preview.adapter, 'php-fpm');
  assert.equal(preview.satisfied, true);
  assert.equal(preview.safeCreateCandidate, false);
  assert.deepEqual(preview.current.identity, {
    satisfied: true,
    uid: 1201,
    gid: 1201,
    homeDirectory,
    homeMode: '0750',
  });
  assert.equal(preview.current.documentRoot.mode, '0750');
  assert.equal(preview.current.package.installed, true);
  assert.equal(preview.current.receipt.state, 'active');
  assert.equal(preview.current.receipt.mutated, true);
  assert.equal(preview.current.pool.present, true);
  assert.equal(preview.current.pool.matchesDesired, true);
  assert.match(preview.current.pool.sha256, /^[a-f0-9]{64}$/);
  assert.equal(preview.current.configValid, true);
  assert.equal(preview.current.serviceActive, true);
  assert.equal(preview.current.socket.socket, true);
  assert.equal(preview.current.socket.mode, '0660');
  assert.equal(preview.desired.configPath, configPath);
  assert.equal(preview.desired.socketPath, socketPath);
  assert.deepEqual(preview.differences, []);
  assert.equal(JSON.stringify(preview).includes(`user = ${unixUser}`), false);

  const mutationCallsAfter = host.calls.filter(([file, args]) => file === '/usr/bin/apt-get'
    || (file === '/usr/bin/systemctl' && ['enable', 'reload'].includes(args[0]))).length;
  assert.equal(mutationCallsAfter, mutationCallsBefore);
});

test('PHP-FPM migration preview reports foreign legacy pool drift without adopting or overwriting it', async () => {
  const host = fakeHost({ packageInstalled: true, serviceActive: true });
  host.entries.set(configPath, {
    type: 'file',
    content: '[foreign]\nuser = attacker\n',
    mode: 0o600,
    uid: 0,
    gid: 0,
  });
  const siteManager = manager(host);

  const preview = await siteManager.previewMigration(intent(), { operationId });

  assert.equal(preview.satisfied, false);
  assert.equal(preview.safeCreateCandidate, false);
  assert.equal(preview.current.receipt.state, null);
  assert.equal(preview.current.pool.present, true);
  assert.equal(preview.current.pool.matchesDesired, false);
  assert.match(preview.current.pool.sha256, /^[a-f0-9]{64}$/);
  assert.equal(preview.differences.includes('php_fpm_receipt_missing'), true);
  assert.equal(preview.differences.includes('php_fpm_pool_drift'), true);
  assert.equal(JSON.stringify(preview).includes('attacker'), false);
  assert.equal(host.entries.get(configPath)?.content, '[foreign]\nuser = attacker\n');
  assert.equal(host.calls.some(([file, args]) => file === '/usr/bin/apt-get'
    || (file === '/usr/bin/systemctl' && ['enable', 'reload'].includes(args[0]))), false);
});


test('PHP-FPM migration preview marks only an already-running shared service with no site pool as safe-create', async () => {
  const host = fakeHost({ packageInstalled: true, serviceActive: true });
  const siteManager = manager(host);

  const preview = await siteManager.previewMigration(intent(), { operationId });

  assert.equal(preview.satisfied, false);
  assert.equal(preview.safeCreateCandidate, true);
  assert.equal(preview.current.package.installed, true);
  assert.equal(preview.current.serviceActive, true);
  assert.equal(preview.current.pool.present, false);
  assert.equal(preview.current.receipt.state, null);
  assert.equal(preview.differences.includes('php_fpm_pool_missing'), true);
  assert.equal(host.calls.some(([file]) => file === '/usr/bin/apt-get'), false);
});

test('PHP-FPM migration lifecycle creates only a receipt-owned missing pool without installing or enabling shared runtime', async () => {
  const host = fakeHost({ packageInstalled: true, serviceActive: true });
  const siteManager = manager(host);
  const callsBefore = host.calls.length;

  const applied = await siteManager.applyMigration(intent(), { operationId });
  const inspected = await siteManager.inspectMigrationOperation(intent(), { operationId });

  assert.equal(applied.satisfied, true);
  assert.equal(applied.phpFpmReceiptVersion, 1);
  assert.equal(applied.createdPhpFpmPool, true);
  assert.equal(inspected.satisfied, true);
  assert.equal(inspected.phpFpmReceiptVersion, 1);
  assert.equal(inspected.createdPhpFpmPool, true);
  const migrationCalls = host.calls.slice(callsBefore);
  assert.equal(migrationCalls.some(([file]) => file === '/usr/bin/apt-get'), false);
  assert.equal(migrationCalls.some(([file, args]) => file === '/usr/bin/systemctl' && args[0] === 'enable'), false);
  assert.equal(migrationCalls.some(([file, args]) => file === '/usr/bin/systemctl' && args[0] === 'reload'), true);
});

test('PHP-FPM migration lifecycle refuses missing package or inactive shared service before site mutation', async () => {
  for (const shared of [
    { packageInstalled: false, serviceActive: false },
    { packageInstalled: true, serviceActive: false },
  ]) {
    const host = fakeHost(shared);
    const siteManager = manager(host);
    await assert.rejects(
      siteManager.applyMigration(intent(), { operationId }),
      (error) => error instanceof PhpFpmSiteManagerError && error.code === 'php_fpm_migration_not_safe_create',
    );
    assert.equal(host.entries.has(configPath), false);
    assert.equal(host.calls.some(([file]) => file === '/usr/bin/apt-get'), false);
    assert.equal(host.calls.some(([file, args]) => file === '/usr/bin/systemctl' && args[0] === 'enable'), false);
  }
});

test('PHP-FPM migration rollback removes only the receipt-owned pool and preserves shared service', async () => {
  const host = fakeHost({ packageInstalled: true, serviceActive: true });
  const siteManager = manager(host);
  await siteManager.applyMigration(intent(), { operationId });

  const compensated = await siteManager.compensate(intent(), { operationId });

  assert.equal(compensated.satisfied, true);
  assert.equal(compensated.restoredPrevious, false);
  assert.equal(compensated.preservedExisting, false);
  assert.equal(host.entries.has(configPath), false);
  assert.equal(host.serviceActive(), true);
  assert.equal(host.calls.some(([file, args]) => file === '/usr/bin/systemctl' && args[0] === 'disable'), false);
});

test('PHP-FPM site manager supports multi-version PHP with verified repository', async () => {
  const host = fakeHost({ packageInstalled: false, serviceActive: false });
  const siteManager = manager(host);

  const applied = await siteManager.apply(intent({ phpVersion: '8.2' }), { operationId });
  assert.equal(applied.satisfied, true);
  assert.equal(applied.phpVersion, '8.2');
  assert.equal(applied.serviceUnit, 'php8.2-fpm.service');
  assert.equal(applied.configPath, `/etc/php/8.2/fpm/pool.d/yunpanel-${unixUser}.conf`);

  // Verify repository policy was checked before installation
  const aptCacheCall = host.calls.find(([file]) => file === '/usr/bin/apt-cache');
  assert.ok(aptCacheCall);
  assert.deepEqual(aptCacheCall[1], ['policy', 'php8.2-fpm']);

  // Verify package was installed
  const aptGetCall = host.calls.find(([file]) => file === '/usr/bin/apt-get');
  assert.ok(aptGetCall);
  assert.equal(aptGetCall[1].includes('php8.2-fpm'), true);

  // Verify inspection matches 8.2
  const inspected = await siteManager.inspect(intent({ phpVersion: '8.2' }));
  assert.equal(inspected.satisfied, true);
  assert.equal(inspected.phpVersion, '8.2');
});

test('PHP-FPM site manager refuses non-distro version without verified repository', async () => {
  const host = fakeHost({ packageInstalled: false, serviceActive: false });
  // Override apt-cache to simulate unverified / absent repository
  const originalRun = host.run;
  host.run = async (file, args) => {
    if (file === '/usr/bin/apt-cache') {
      return { stdout: 'Package: php8.1-fpm\nCandidate: (none)\nVersion table:\n' };
    }
    return originalRun(file, args);
  };

  const siteManager = manager(host);
  await assert.rejects(
    siteManager.apply(intent({ phpVersion: '8.1' }), { operationId }),
    (error) => error instanceof PhpFpmSiteManagerError && error.code === 'php_fpm_repository_unverified',
  );
  assert.equal(host.calls.some(([file]) => file === '/usr/bin/apt-get'), false);
});

test('PHP-FPM site manager rejects a foreign candidate even when an older version exists in verified PPA', async () => {
  const host = fakeHost({ packageInstalled: false, serviceActive: false });
  const originalRun = host.run;
  host.run = async (file, args) => file === '/usr/bin/apt-cache'
    ? { stdout: 'php8.2-fpm:\n  Installed: (none)\n  Candidate: 8.2.99-foreign\n  Version table:\n     8.2.99-foreign 700\n        700 https://packages.example.test/php noble/main amd64 Packages\n     8.2.18-ppa 500\n        500 https://ppa.launchpadcontent.net/ondrej/php/ubuntu noble/main amd64 Packages\n' }
    : originalRun(file, args);

  await assert.rejects(
    manager(host).apply(intent({ phpVersion: '8.2' }), { operationId }),
    (error) => error instanceof PhpFpmSiteManagerError && error.code === 'php_fpm_repository_unverified',
  );
  assert.equal(host.calls.some(([file]) => file === '/usr/bin/apt-get'), false);
});

test('PHP-FPM site manager rejects unsupported PHP version in intent', async () => {
  const host = fakeHost({ packageInstalled: true, serviceActive: true });
  const siteManager = manager(host);

  for (const invalid of ['7.4', '8.0', '9.0', 'invalid']) {
    await assert.rejects(
      siteManager.inspect(intent({ phpVersion: invalid })),
      (error) => error instanceof PhpFpmSiteManagerError && error.code === 'php_fpm_site_version_unsupported',
    );
  }
});
