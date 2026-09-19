import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PhpFpmTemplateError,
  phpFpmBinaryPath,
  phpFpmPackageName,
  phpFpmPoolDirectory,
  phpFpmPoolPath,
  phpFpmServiceUnit,
  phpFpmSocketPath,
  phpFpmTemplatePolicy,
  previewWebsitePhpFpmPool,
  renderWebsitePhpFpmPool,
} from '@yunpanel/config-templates';
import {
  createPhpFpmSiteManager,
  PhpFpmSiteManagerError,
} from '@yunpanel/host-runtime';

test('PHP-FPM Runtime Golden Path - Distro Baseline, Multi-Version & Verified Repo Validation', async (t) => {
  const websiteId = 'a1000000-0000-4000-8000-000000000001';
  const applicationId = 'b1000000-0000-4000-8000-000000000002';
  const operationId = 'c1000000-0000-4000-8000-000000000003';
  const unixUser = 'yunapp-f22159b046f8';
  const homeDirectory = `/var/lib/yunpanel/data/${applicationId}`;
  const currentRelease = `/var/lib/yunpanel/apps/${applicationId}/current`;
  const documentRoot = `${currentRelease}/public`;
  const temporaryDirectory = `${homeDirectory}/tmp`;
  const logDirectory = `${homeDirectory}/logs`;

  function createMockHost({ packageInstalled = true, serviceActive = true, aptCacheCandidate = true } = {}) {
    const entries = new Map([
      [documentRoot, { type: 'directory', mode: 0o750, uid: 1201, gid: 1201 }],
    ]);
    const calls = [];

    return {
      entries,
      calls,
      run: async (file, args) => {
        calls.push([file, [...args]]);
        if (file === '/usr/bin/dpkg-query') {
          if (!packageInstalled) {
            const err = new Error('not installed');
            err.code = 1;
            throw err;
          }
          return { stdout: 'install ok installed\t8.3.6-0ubuntu0.24.04.4' };
        }
        if (file === '/usr/bin/apt-cache') {
          if (!aptCacheCandidate) {
            return { stdout: 'Candidate: (none)\n' };
          }
          return { stdout: 'Candidate: 8.2.18-1+ubuntu24.04.1\nVersion table:\n     8.2.18-1+ubuntu24.04.1 500\n        500 https://ppa.launchpadcontent.net/ondrej/php/ubuntu noble/main amd64 Packages\n' };
        }
        if (file === '/usr/bin/apt-get') {
          packageInstalled = true;
          return { stdout: '' };
        }
        if (file.startsWith('/usr/sbin/php-fpm')) {
          return { stdout: 'configuration file test is successful' };
        }
        if (file === '/usr/bin/systemctl') {
          if (args[0] === 'is-active') {
            if (!serviceActive) {
              const err = new Error('inactive');
              err.code = 3;
              throw err;
            }
            return { stdout: '' };
          }
          if (args[0] === 'enable') {
            serviceActive = true;
            return { stdout: '' };
          }
          if (args[0] === 'reload') {
            return { stdout: '' };
          }
        }
        throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
      },
      lstatFn: async (file) => {
        const entry = entries.get(file);
        if (!entry) {
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        }
        return {
          uid: entry.uid ?? 0,
          gid: entry.gid ?? 0,
          mode: entry.mode ?? 0o600,
          isFile: () => entry.type === 'file',
          isDirectory: () => entry.type === 'directory',
          isSocket: () => entry.type === 'socket',
          isSymbolicLink: () => false,
        };
      },
      mkdirFn: async () => {},
      readFileFn: async (file) => {
        const entry = entries.get(file);
        if (!entry || entry.type !== 'file') {
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        }
        return entry.content;
      },
      writeFileFn: async (file, content, options = {}) => {
        entries.set(file, {
          type: 'file',
          content: String(content),
          mode: options.mode ?? 0o600,
          uid: 0,
          gid: 0,
        });
      },
      renameFn: async (source, target) => {
        const entry = entries.get(source);
        if (!entry) {
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        }
        entries.set(target, entry);
        entries.delete(source);
      },
      rmFn: async (file) => {
        entries.delete(file);
      },
    };
  }

  function createMockIdentityManager() {
    return {
      inspect: async () => ({
        satisfied: true,
        user: unixUser,
        uid: 1201,
        gid: 1201,
        homeDirectory,
        shell: '/usr/sbin/nologin',
        homeMode: 0o750,
      }),
    };
  }

  await t.test('1. Distro PHP 8.3 Baseline - Pool Config, Isolation & Socket', () => {
    const rendered = renderWebsitePhpFpmPool({
      unixUser,
      unixGroup: unixUser,
      applicationRoot: currentRelease,
      documentRoot,
      homeDirectory,
      temporaryDirectory,
      logDirectory,
    });

    assert.match(rendered, new RegExp(`\\[yunpanel-${unixUser}\\]`));
    assert.match(rendered, new RegExp(`user = ${unixUser}`));
    assert.match(rendered, new RegExp(`group = ${unixUser}`));
    assert.match(rendered, new RegExp(`listen = /run/php/yunpanel-${unixUser}\\.sock`));
    assert.match(rendered, /pm = ondemand/);
    assert.match(rendered, /security\.limit_extensions = \.php/);
    assert.match(rendered, new RegExp(`open_basedir\\] = ${currentRelease}:${homeDirectory}`));
    assert.match(rendered, new RegExp(`sys_temp_dir\\] = ${temporaryDirectory}`));
    assert.match(rendered, new RegExp(`error_log\\] = ${logDirectory}/php-error\\.log`));
    assert.match(rendered, /; managed by YunPanel PHP 8\.3/);
  });

  await t.test('2. Multi-Version Support (8.1, 8.2, 8.3, 8.4)', () => {
    for (const version of phpFpmTemplatePolicy.supportedVersions) {
      assert.equal(phpFpmServiceUnit(version), `php${version}-fpm.service`);
      assert.equal(phpFpmBinaryPath(version), `/usr/sbin/php-fpm${version}`);
      assert.equal(phpFpmPackageName(version), `php${version}-fpm`);
      assert.equal(phpFpmPoolDirectory(version), `/etc/php/${version}/fpm/pool.d`);
      assert.equal(phpFpmPoolPath(unixUser, version), `/etc/php/${version}/fpm/pool.d/yunpanel-${unixUser}.conf`);

      const preview = previewWebsitePhpFpmPool({
        unixUser,
        unixGroup: unixUser,
        phpVersion: version,
        applicationRoot: currentRelease,
        documentRoot,
        homeDirectory,
        temporaryDirectory,
        logDirectory,
      });
      assert.equal(preview.phpVersion, version);
      assert.equal(preview.serviceUnit, `php${version}-fpm.service`);
      assert.equal(preview.artifact.path, `/etc/php/${version}/fpm/pool.d/yunpanel-${unixUser}.conf`);
    }
  });

  await t.test('3. Rejection of Unsupported Versions (Fail-Closed)', () => {
    for (const invalid of ['5.6', '7.4', '8.0', '8.5', '9.0', 'node']) {
      assert.throws(
        () => renderWebsitePhpFpmPool({
          unixUser,
          unixGroup: unixUser,
          phpVersion: invalid,
          applicationRoot: currentRelease,
          documentRoot,
          homeDirectory,
          temporaryDirectory,
          logDirectory,
        }),
        (err) => err instanceof PhpFpmTemplateError && err.code === 'php_fpm_version_unsupported',
      );
    }
  });

  await t.test('4. Host Runtime Multi-Version Provisioning with Verified Repository', async () => {
    const host = createMockHost({ packageInstalled: false, serviceActive: false, aptCacheCandidate: true });
    // Pre-create socket in fake filesystem when enabled
    host.entries.set(phpFpmSocketPath(unixUser), { type: 'socket', mode: 0o660, uid: 33, gid: 33 });

    const manager = createPhpFpmSiteManager({
      receiptRoot: '/var/lib/yunpanel/staging/php-fpm-sites',
      identityManager: createMockIdentityManager(),
      run: host.run,
      lstatFn: host.lstatFn,
      mkdirFn: host.mkdirFn,
      readFileFn: host.readFileFn,
      writeFileFn: host.writeFileFn,
      renameFn: host.renameFn,
      rmFn: host.rmFn,
    });

    const applied = await manager.apply({
      websiteId,
      applicationId,
      unixUser,
      documentRoot,
      phpVersion: '8.2',
    }, { operationId });

    assert.equal(applied.satisfied, true);
    assert.equal(applied.phpVersion, '8.2');
    assert.equal(applied.serviceUnit, 'php8.2-fpm.service');
    assert.equal(applied.configPath, `/etc/php/8.2/fpm/pool.d/yunpanel-${unixUser}.conf`);

    // Proves apt-cache policy was verified
    const aptCacheCall = host.calls.find(([file]) => file === '/usr/bin/apt-cache');
    assert.ok(aptCacheCall);
    assert.deepEqual(aptCacheCall[1], ['policy', 'php8.2-fpm']);

    // Proves package install was executed
    const aptGetCall = host.calls.find(([file]) => file === '/usr/bin/apt-get');
    assert.ok(aptGetCall);
    assert.equal(aptGetCall[1].includes('php8.2-fpm'), true);

    // Verify inspect matches 8.2
    const inspected = await manager.inspect({
      websiteId,
      applicationId,
      unixUser,
      documentRoot,
      phpVersion: '8.2',
    });
    assert.equal(inspected.satisfied, true);
    assert.equal(inspected.phpVersion, '8.2');
  });

  await t.test('5. Non-Distro Version Refused Without Verified Repository', async () => {
    const host = createMockHost({ packageInstalled: false, serviceActive: false, aptCacheCandidate: false });
    const manager = createPhpFpmSiteManager({
      receiptRoot: '/var/lib/yunpanel/staging/php-fpm-sites',
      identityManager: createMockIdentityManager(),
      run: host.run,
      lstatFn: host.lstatFn,
      mkdirFn: host.mkdirFn,
      readFileFn: host.readFileFn,
      writeFileFn: host.writeFileFn,
      renameFn: host.renameFn,
      rmFn: host.rmFn,
    });

    await assert.rejects(
      manager.apply({
        websiteId,
        applicationId,
        unixUser,
        documentRoot,
        phpVersion: '8.1',
      }, { operationId }),
      (err) => err instanceof PhpFpmSiteManagerError && err.code === 'php_fpm_repository_unverified',
    );

    // Verify no arbitrary apt-get install was attempted
    assert.equal(host.calls.some(([file]) => file === '/usr/bin/apt-get'), false);
  });
});
