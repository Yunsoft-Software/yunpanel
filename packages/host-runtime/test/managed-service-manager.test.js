import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createManagedServiceManager,
  ManagedServiceError,
  managedServicePolicy,
} from '../src/managed-service-manager.js';

const ACTIVE_UNIT = 'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n';
const INACTIVE_UNIT = 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=enabled\n';

test('managed service catalog covers the hosting service groups without arbitrary units', () => {
  assert.deepEqual(managedServicePolicy.services.map((entry) => entry.id), [
    'nginx', 'mariadb', 'mysql', 'docker', 'cron', 'postfix', 'dovecot', 'rspamd',
    'roundcube', 'phpmyadmin', 'elfinder', 'restic', 'rclone', 'postsrsd', 'redis', 'memcached',
    'netdata', 'goaccess',
  ]);
  assert.deepEqual(managedServicePolicy.actions, ['start', 'stop', 'restart']);
  for (const entry of managedServicePolicy.services) {
    assert.ok(entry.packages.length > 0);
    assert.equal(entry.units.length > 0, !['roundcube', 'phpmyadmin', 'elfinder', 'restic', 'rclone', 'goaccess'].includes(entry.id));
    assert.ok(entry.units.every((unit) => unit.endsWith('.service')));
  }
});

test('inspect reports package and unit state for an allowlisted service', async () => {
  const calls = [];
  const manager = createManagedServiceManager({
    run: async (file, args) => {
      calls.push([file, args]);
      if (file === '/usr/bin/dpkg-query') return { stdout: 'install ok installed\t1:10.11.13-0ubuntu0.24.04.1' };
      if (file === '/usr/bin/systemctl') return { stdout: ACTIVE_UNIT };
      throw new Error('unexpected command');
    },
  });
  const result = await manager.inspect('mariadb');
  assert.equal(result.id, 'mariadb');
  assert.equal(result.installed, true);
  assert.equal(result.active, true);
  assert.equal(result.packages[0].packageName, 'mariadb-server');
  assert.equal(result.units[0].unit, 'mariadb.service');
  assert.deepEqual(result.health, { status: 'ready', configuration: 'not_applicable' });
  assert.equal(calls.length, 2);
});

test('missing packages are reported without leaking command errors', async () => {
  const manager = createManagedServiceManager({
    run: async (file) => {
      if (file === '/usr/bin/dpkg-query') throw Object.assign(new Error('/secret/path'), { stderr: 'sensitive output' });
      return { stdout: 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=\n' };
    },
  });
  const result = await manager.inspect('rspamd');
  assert.deepEqual(result.packages, [{ packageName: 'rspamd', installed: false, version: null }]);
  assert.equal(result.units[0].unitFileState, 'unknown');
  assert.equal(result.installed, false);
  assert.equal(result.active, false);
  assert.deepEqual(result.health, { status: 'not_installed', configuration: 'not_checked' });
});

test('mail inspection runs only fixed configuration checks and never returns their output', async () => {
  const cases = [
    ['postfix', '/usr/sbin/postfix', ['check']],
    ['dovecot', '/usr/bin/doveconf', ['-n']],
    ['rspamd', '/usr/bin/rspamadm', ['configtest']],
  ];
  for (const [serviceId, checkFile, checkArgs] of cases) {
    const calls = [];
    const manager = createManagedServiceManager({
      run: async (file, args) => {
        calls.push([file, args]);
        if (file === '/usr/bin/dpkg-query') return { stdout: 'install ok installed\t1.0' };
        if (file === '/usr/bin/systemctl') return { stdout: ACTIVE_UNIT };
        if (file === checkFile) return { stdout: 'PRIVATE CONFIG OUTPUT', stderr: 'PRIVATE WARNING' };
        throw new Error('unexpected command');
      },
    });
    const result = await manager.inspect(serviceId);
    assert.deepEqual(result.health, { status: 'ready', configuration: 'valid' });
    assert.ok(calls.some(([file, args]) => file === checkFile && JSON.stringify(args) === JSON.stringify(checkArgs)));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
});

test('failed mail configuration checks produce bounded health without leaking command errors', async () => {
  const manager = createManagedServiceManager({
    run: async (file) => {
      if (file === '/usr/bin/dpkg-query') return { stdout: 'install ok installed\t1.0' };
      if (file === '/usr/bin/systemctl') return { stdout: ACTIVE_UNIT };
      throw Object.assign(new Error('/private/mail/config'), { stderr: 'TOKEN=hidden' });
    },
  });
  const result = await manager.inspect('postfix');
  assert.deepEqual(result.health, { status: 'configuration_invalid', configuration: 'invalid' });
  assert.doesNotMatch(JSON.stringify(result), /private|hidden/);
});



test('managed Postfix and Dovecot installs include SQLite lookup packages and bind only the mail-auth group before service start', async () => {
  for (const serviceId of ['postfix', 'dovecot']) {
    const calls = [];
    const installed = new Set();
    let active = false;
    const manager = createManagedServiceManager({
      run: async (file, args) => {
        calls.push([file, args]);
        if (file === '/usr/bin/dpkg-query') {
          const packageName = args.at(-1);
          if (!installed.has(packageName)) throw new Error('not installed');
          return { stdout: 'install ok installed\t1.0' };
        }
        if (file === '/usr/bin/apt-get' && args[0] === 'install') {
          for (const packageName of args.slice(3)) installed.add(packageName);
          return { stdout: '' };
        }
        if (file === '/usr/bin/apt-get') return { stdout: '' };
        if (file === '/usr/sbin/adduser') return { stdout: '' };
        if (file === '/usr/bin/systemctl' && args[0] === 'enable') {
          active = true;
          return { stdout: '' };
        }
        if (file === '/usr/bin/systemctl') return { stdout: active ? ACTIVE_UNIT : INACTIVE_UNIT };
        if (file === '/usr/sbin/postfix' || file === '/usr/bin/doveconf') return { stdout: '' };
        throw new Error('unexpected command');
      },
    });

    const result = await manager.install(serviceId);
    assert.equal(result.installed, true);
    const packageNames = result.packages.map((entry) => entry.packageName);
    assert.equal(packageNames.includes('sqlite3'), true);
    assert.equal(
      packageNames.includes(serviceId === 'postfix' ? 'postfix-sqlite' : 'dovecot-sqlite'),
      true,
    );
    const membership = calls.find(([file]) => file === '/usr/sbin/adduser');
    assert.deepEqual(membership, [
      '/usr/sbin/adduser',
      [serviceId === 'postfix' ? 'postfix' : 'dovecot', 'yunpanel-mailauth'],
    ]);
    const membershipIndex = calls.indexOf(membership);
    const enableIndex = calls.findIndex(([file, args]) => file === '/usr/bin/systemctl' && args[0] === 'enable');
    const restartIndex = calls.findIndex(([file, args]) => file === '/usr/bin/systemctl' && args[0] === 'restart');
    assert.ok(membershipIndex >= 0 && enableIndex > membershipIndex && restartIndex > enableIndex);
    assert.equal(calls.some(([file, args]) => file === '/usr/sbin/adduser' && args[1] === 'vmail'), false);
  }
});

test('Roundcube install includes SQLite backend and PHP-FPM while remaining distinct from service control', async () => {
  const calls = [];
  const installed = new Set();
  const manager = createManagedServiceManager({
    run: async (file, args) => {
      calls.push([file, args]);
      if (file === '/usr/bin/dpkg-query') {
        const packageName = args.at(-1);
        if (!installed.has(packageName)) throw new Error('not installed');
        return { stdout: 'install ok installed\t1.6.6+dfsg-2ubuntu0.1' };
      }
      if (file === '/usr/bin/apt-get' && args[0] === 'install') {
        for (const packageName of args.slice(3)) installed.add(packageName);
        return { stdout: '' };
      }
      if (file === '/usr/bin/apt-get' || file === '/usr/bin/test' || file === '/usr/bin/php') return { stdout: '' };
      throw new Error('unexpected command');
    },
  });
  const result = await manager.install('roundcube');
  assert.equal(result.changed, true);
  assert.equal(result.installed, true);
  assert.equal(result.active, false);
  assert.deepEqual(result.units, []);
  assert.deepEqual(result.health, { status: 'installed', configuration: 'valid' });
  assert.deepEqual(result.packages.map((entry) => entry.packageName), [
    'roundcube-core', 'roundcube-sqlite3', 'php-fpm',
  ]);
  assert.deepEqual(calls.find(([file, args]) => file === '/usr/bin/apt-get' && args[0] === 'install')?.[1], [
    'install', '--yes', '--no-install-recommends', 'roundcube-core', 'roundcube-sqlite3', 'php-fpm',
  ]);
  assert.ok(calls.some(([file, args]) => file === '/usr/bin/test'
    && args.join(' ') === '-f /var/lib/roundcube/public_html/index.php'));
  assert.ok(calls.some(([file, args]) => file === '/usr/bin/test'
    && args.join(' ') === '-f /usr/share/roundcube/SQL/sqlite.initial.sql'));
  assert.equal(calls.some(([file]) => file === '/usr/bin/systemctl'), false);
  await assert.rejects(manager.control('roundcube', 'restart'), { code: 'managed_service_not_controllable' });
});

test('phpMyAdmin install uses the fixed package and configuration allowlist without a fabricated service', async () => {
  const calls = [];
  const installed = new Set();
  const manager = createManagedServiceManager({
    run: async (file, args) => {
      calls.push([file, args]);
      if (file === '/usr/bin/dpkg-query') {
        const packageName = args.at(-1);
        if (!installed.has(packageName)) throw new Error('not installed');
        return { stdout: 'install ok installed\t5.2.1+dfsg-3' };
      }
      if (file === '/usr/bin/apt-get' && args[0] === 'install') {
        for (const packageName of args.slice(3)) installed.add(packageName);
        return { stdout: '' };
      }
      if (file === '/usr/bin/apt-get' || file === '/usr/bin/test' || file === '/usr/bin/php') return { stdout: '' };
      throw new Error('unexpected command');
    },
  });
  const result = await manager.install('phpmyadmin');
  assert.equal(result.changed, true);
  assert.equal(result.installed, true);
  assert.equal(result.active, false);
  assert.deepEqual(result.units, []);
  assert.deepEqual(result.health, { status: 'installed', configuration: 'valid' });
  assert.deepEqual(result.packages.map((entry) => entry.packageName), ['phpmyadmin', 'php-fpm', 'php-mysql']);
  assert.deepEqual(calls.find(([file, args]) => file === '/usr/bin/apt-get' && args[0] === 'install')?.[1], [
    'install', '--yes', '--no-install-recommends', 'phpmyadmin', 'php-fpm', 'php-mysql',
  ]);
  assert.ok(calls.some(([file, args]) => file === '/usr/bin/test'
    && args.join(' ') === '-f /usr/share/phpmyadmin/index.php'));
  assert.ok(calls.some(([file, args]) => file === '/usr/bin/php'
    && args.join(' ') === '-l /etc/phpmyadmin/config.inc.php'));
  assert.equal(calls.some(([file]) => file === '/usr/bin/systemctl'), false);
  await assert.rejects(manager.control('phpmyadmin', 'restart'), { code: 'managed_service_not_controllable' });
});

test('elFinder installs only PHP runtime dependencies and validates the packaged shared application', async () => {
  const calls = [];
  const installed = new Set();
  const manager = createManagedServiceManager({
    run: async (file, args) => {
      calls.push([file, args]);
      if (file === '/usr/bin/dpkg-query') {
        const packageName = args.at(-1);
        if (!installed.has(packageName)) throw new Error('not installed');
        return { stdout: 'install ok installed\t8.3' };
      }
      if (file === '/usr/bin/apt-get' && args[0] === 'install') {
        for (const packageName of args.slice(3)) installed.add(packageName);
        return { stdout: '' };
      }
      if (file === '/usr/bin/apt-get' || file === '/usr/bin/test' || file === '/usr/bin/php') return { stdout: '' };
      throw new Error('unexpected command');
    },
  });

  const result = await manager.install('elfinder');
  assert.equal(result.changed, true);
  assert.equal(result.installed, true);
  assert.equal(result.active, false);
  assert.deepEqual(result.units, []);
  assert.deepEqual(result.health, { status: 'installed', configuration: 'valid' });
  assert.deepEqual(result.packages.map((entry) => entry.packageName), [
    'php-fpm', 'php-mbstring', 'php-zip', 'libjs-jquery', 'libjs-jquery-ui',
  ]);
  assert.deepEqual(calls.find(([file, args]) => file === '/usr/bin/apt-get' && args[0] === 'install')?.[1], [
    'install', '--yes', '--no-install-recommends',
    'php-fpm', 'php-mbstring', 'php-zip', 'libjs-jquery', 'libjs-jquery-ui',
  ]);
  for (const expected of [
    '-f /usr/share/yunpanel/elfinder/VERSION',
    '-f /usr/share/yunpanel/elfinder/index.html',
    '-f /usr/share/yunpanel/elfinder/yunpanel-client.js',
    '-f /usr/share/yunpanel/elfinder/vendor/elfinder/js/elfinder.min.js',
    '-f /usr/share/yunpanel/elfinder/vendor/elfinder/css/elfinder.min.css',
    '-f /usr/share/yunpanel/elfinder/vendor/elfinder/img/toolbar.png',
    '-f /usr/share/yunpanel/elfinder/vendor/elfinder/php/autoload.php',
    '-f /usr/share/yunpanel/elfinder/connector.php',
    '-f /usr/share/javascript/jquery/jquery.min.js',
    '-f /usr/share/javascript/jquery-ui/jquery-ui.min.js',
    '-f /usr/share/javascript/jquery-ui/themes/base/jquery-ui.min.css',
  ]) {
    assert.ok(calls.some(([file, args]) => file === '/usr/bin/test' && args.join(' ') === expected));
  }
  assert.ok(calls.some(([file, args]) => file === '/usr/bin/php'
    && args.join(' ') === '-l /usr/share/yunpanel/elfinder/connector.php'));
  assert.ok(calls.some(([file, args]) => file === '/usr/bin/php'
    && args[0] === '-r' && args[1].includes('posix_geteuid')
    && args[1].includes('mb_strlen') && args[1].includes('ZipArchive')));
  assert.equal(calls.some(([file]) => file === '/usr/bin/systemctl'), false);
  await assert.rejects(manager.control('elfinder', 'restart'), { code: 'managed_service_not_controllable' });
});

test('restic and rclone are fixed package-only tools with binary health gates', async () => {
  for (const tool of ['restic', 'rclone']) {
    const calls = [];
    let installed = false;
    let binaryHealthy = true;
    const manager = createManagedServiceManager({
      run: async (file, args) => {
        calls.push([file, args]);
        if (file === '/usr/bin/dpkg-query') {
          if (!installed) throw new Error('not installed');
          return { stdout: 'install ok installed\t1.2.3-1' };
        }
        if (file === '/usr/bin/apt-get' && args[0] === 'install') {
          assert.deepEqual(args, ['install', '--yes', '--no-install-recommends', tool]);
          installed = true;
          return { stdout: '' };
        }
        if (file === '/usr/bin/apt-get') return { stdout: '' };
        if (file === `/usr/bin/${tool}` && args[0] === 'version') {
          if (!binaryHealthy) throw new Error('binary failed');
          return { stdout: `${tool} 1.2.3` };
        }
        throw new Error('unexpected command');
      },
    });
    const result = await manager.install(tool);
    assert.equal(result.changed, true);
    assert.equal(result.active, false);
    assert.deepEqual(result.units, []);
    assert.deepEqual(result.health, { status: 'installed', configuration: 'valid' });
    assert.equal(calls.some(([file]) => file === '/usr/bin/systemctl'), false);
    await assert.rejects(manager.control(tool, 'restart'), { code: 'managed_service_not_controllable' });
    binaryHealthy = false;
    const drifted = await manager.inspect(tool);
    assert.deepEqual(drifted.health, { status: 'configuration_invalid', configuration: 'invalid' });
    await assert.rejects(manager.install(tool), { code: 'managed_backup_binary_unhealthy' });
    assert.equal(calls.filter(([file, args]) => file === '/usr/bin/apt-get' && args[0] === 'install').length, 1);
  }
});

test('PostSRSd installs only the fixed Noble package and managed service unit', async () => {
  const calls = [];
  const installed = new Set();
  let active = false;
  const manager = createManagedServiceManager({
    run: async (file, args) => {
      calls.push([file, args]);
      if (file === '/usr/bin/dpkg-query') {
        if (!installed.has('postsrsd')) throw new Error('not installed');
        return { stdout: 'install ok installed\t1.10-2.1build1' };
      }
      if (file === '/usr/bin/apt-get' && args[0] === 'install') {
        assert.deepEqual(args, ['install', '--yes', '--no-install-recommends', 'postsrsd']);
        installed.add('postsrsd');
        return { stdout: '' };
      }
      if (file === '/usr/bin/apt-get') return { stdout: '' };
      if (file === '/usr/bin/systemctl' && args[0] === 'enable') {
        assert.deepEqual(args, ['enable', '--now', 'postsrsd.service']);
        active = true;
        return { stdout: '' };
      }
      if (file === '/usr/bin/systemctl') return { stdout: active ? ACTIVE_UNIT : INACTIVE_UNIT };
      throw new Error('unexpected command');
    },
  });

  const result = await manager.install('postsrsd');
  assert.equal(result.changed, true);
  assert.equal(result.installed, true);
  assert.equal(result.active, true);
  assert.deepEqual(result.packages.map((entry) => entry.packageName), ['postsrsd']);
  assert.deepEqual(result.units.map((entry) => entry.unit), ['postsrsd.service']);
  assert.deepEqual(result.health, { status: 'ready', configuration: 'not_applicable' });
  assert.equal(calls.some(([file, args]) => file === '/usr/bin/apt-get' && args.includes('curl')), false);
});

test('install refreshes APT, installs only catalog packages and enables the fixed unit', async () => {
  const calls = [];
  const installed = new Set();
  let mariadbActive = false;
  let securityInspections = 0;
  const manager = createManagedServiceManager({
    databaseSecurityInspector: async () => {
      securityInspections += 1;
      return {
        engine: 'mariadb',
        ready: true,
        connection: { protocol: 'socket', nativeSocketAuth: true },
      };
    },
    run: async (file, args) => {
      calls.push([file, args]);
      if (file === '/usr/bin/dpkg-query') {
        const packageName = args.at(-1);
        if (!installed.has(packageName)) throw new Error('not installed');
        return { stdout: 'install ok installed\t1.0' };
      }
      if (file === '/usr/bin/apt-get' && args[0] === 'install') {
        for (const packageName of args.slice(3)) installed.add(packageName);
        return { stdout: '' };
      }
      if (file === '/usr/bin/apt-get') return { stdout: '' };
      if (file === '/usr/bin/systemctl' && args[0] === 'enable') { mariadbActive = true; return { stdout: '' }; }
      if (file === '/usr/bin/systemctl') return { stdout: mariadbActive ? ACTIVE_UNIT : INACTIVE_UNIT };
      throw new Error('unexpected command');
    },
  });
  const result = await manager.install('mariadb');
  assert.equal(result.changed, true);
  assert.equal(result.installed, true);
  assert.equal(result.active, true);
  assert.deepEqual(calls.find(([file, args]) => file === '/usr/bin/apt-get' && args[0] === 'install')?.[1], [
    'install', '--yes', '--no-install-recommends', 'mariadb-server',
  ]);
  assert.ok(calls.some(([file, args]) => file === '/usr/bin/systemctl' && args.join(' ') === 'enable --now mariadb.service'));
  assert.equal(securityInspections, 1);
});

test('database install fails closed when native socket security baseline is unavailable or not ready', async () => {
  const run = async (file) => {
    if (file === '/usr/bin/dpkg-query') return { stdout: 'install ok installed\t1:10.11' };
    if (file === '/usr/bin/systemctl') return { stdout: ACTIVE_UNIT };
    throw new Error('unexpected command');
  };
  const cases = [
    [null, 'managed_database_security_inspection_unavailable'],
    [async () => { throw new Error('private socket path'); }, 'managed_database_security_inspection_failed'],
    [async () => ({
      engine: 'mariadb',
      ready: false,
      connection: { protocol: 'socket', nativeSocketAuth: false },
    }), 'managed_database_security_not_ready'],
    [async () => ({
      engine: 'mysql',
      ready: true,
      connection: { protocol: 'socket', nativeSocketAuth: true },
    }), 'managed_database_security_not_ready'],
  ];
  for (const [databaseSecurityInspector, code] of cases) {
    const manager = createManagedServiceManager({ run, databaseSecurityInspector });
    await assert.rejects(
      manager.install('mariadb'),
      (error) => error instanceof ManagedServiceError
        && error.code === code
        && !error.message.includes('private socket path'),
    );
  }
});

test('database install fails closed when the conflicting engine is already installed', async () => {
  const calls = [];
  const manager = createManagedServiceManager({
    run: async (file, args) => {
      calls.push([file, args]);
      if (file === '/usr/bin/dpkg-query' && args.at(-1) === 'mysql-server') return { stdout: 'install ok installed\t8.0' };
      if (file === '/usr/bin/dpkg-query') throw new Error('not installed');
      if (file === '/usr/bin/systemctl') return { stdout: INACTIVE_UNIT };
      throw new Error('unexpected command');
    },
  });
  await assert.rejects(
    manager.install('mariadb'),
    (error) => error instanceof ManagedServiceError && error.code === 'managed_service_conflict',
  );
  assert.equal(calls.some(([file]) => file === '/usr/bin/apt-get'), false);
});

test('service control only permits fixed actions and requires an installed service', async () => {
  let active = true;
  const calls = [];
  const manager = createManagedServiceManager({
    run: async (file, args) => {
      calls.push([file, args]);
      if (file === '/usr/bin/dpkg-query') return { stdout: 'install ok installed\t1.0' };
      if (file === '/usr/bin/systemctl' && args[0] === 'stop') { active = false; return { stdout: '' }; }
      if (file === '/usr/bin/systemctl') return { stdout: active ? ACTIVE_UNIT : INACTIVE_UNIT };
      throw new Error('unexpected command');
    },
  });
  const stopped = await manager.control('nginx', 'stop');
  assert.equal(stopped.active, false);
  assert.equal(stopped.action, 'stop');
  await assert.rejects(manager.control('nginx', 'reload'), { code: 'unsupported_managed_service_action' });
  assert.equal(calls.some(([, args]) => args[0] === 'reload'), false);
});

test('mutating service operations are serialized behind a process-local lock', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let blocked = false;
  const manager = createManagedServiceManager({
    run: async (file, args) => {
      if (file === '/usr/bin/dpkg-query') return { stdout: 'install ok installed\t1.0' };
      if (file === '/usr/bin/systemctl' && args[0] === 'restart') { blocked = true; await gate; return { stdout: '' }; }
      if (file === '/usr/bin/systemctl') return { stdout: ACTIVE_UNIT };
      return { stdout: '' };
    },
  });
  const first = manager.control('nginx', 'restart');
  while (!blocked) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(manager.control('cron', 'restart'), { code: 'managed_service_operation_in_progress' });
  release();
  await first;
});

test('unknown service identifiers fail closed before a command is executed', async () => {
  let calls = 0;
  const manager = createManagedServiceManager({ run: async () => { calls += 1; return { stdout: '' }; } });
  await assert.rejects(
    manager.inspect('ssh'),
    (error) => error instanceof ManagedServiceError && error.code === 'unsupported_managed_service',
  );
  assert.equal(calls, 0);
});
