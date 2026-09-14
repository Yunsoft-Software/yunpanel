import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPassengerManager,
  PassengerManagerError,
  passengerManagerInternals,
} from '../src/passenger-manager.js';

function enoent() {
  const error = new Error('missing');
  error.code = 'ENOENT';
  return error;
}

function commandFailure(code = 1) {
  const error = new Error('command failed');
  error.code = code;
  return error;
}

const unhealthy = Object.freeze({
  packageName: 'libnginx-mod-http-passenger',
  installed: false,
  installedVersion: null,
  passengerRoot: null,
  nginxPassengerRoots: Object.freeze([]),
  moduleLoaded: false,
  installValid: false,
  nodeVersion: null,
  healthy: false,
});

const healthy = Object.freeze({
  packageName: 'libnginx-mod-http-passenger',
  installed: true,
  installedVersion: '1:6.1.3-1',
  passengerRoot: '/usr/lib/ruby/vendor_ruby/phusion_passenger/locations.ini',
  nginxPassengerRoots: Object.freeze(['/usr/lib/ruby/vendor_ruby/phusion_passenger/locations.ini']),
  moduleLoaded: true,
  installValid: true,
  nodeVersion: 'v24.11.1',
  healthy: true,
});
const upgradedHealthy = Object.freeze({ ...healthy, installedVersion: '1:6.1.4-1' });

function ubuntuRead(file) {
  if (file === '/etc/os-release') return 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n';
  throw enoent();
}

function upgradeRun(commands, { candidate = upgradedHealthy.installedVersion, rollbackFails = false } = {}) {
  return async (file, args) => {
    commands.push([file, args]);
    if (file === '/usr/bin/dpkg-query') return { stdout: 'nginx:amd64: /usr/sbin/nginx\n' };
    if (file === '/usr/bin/apt-cache') return { stdout: `libnginx-mod-http-passenger:\n  Installed: ${healthy.installedVersion}\n  Candidate: ${candidate}\n` };
    if (rollbackFails && file === '/usr/bin/apt-get' && args.some((arg) => arg.includes(`=${healthy.installedVersion}`))) {
      throw commandFailure(100);
    }
    return { stdout: '' };
  };
}

test('Passenger manager is a no-op when inspection is already healthy', async () => {
  const commands = [];
  const manager = createPassengerManager({
    inspector: { inspect: async () => healthy },
    run: async (...args) => { commands.push(args); return { stdout: '' }; },
  });

  const result = await manager.apply();
  assert.equal(result.changed, false);
  assert.equal(result.healthy, true);
  assert.equal(commands.length, 0);
});

test('Passenger manager refuses unsupported operating systems before package mutation', async () => {
  const commands = [];
  const manager = createPassengerManager({
    inspector: { inspect: async () => unhealthy },
    run: async (...args) => { commands.push(args); return { stdout: '' }; },
    readFileFn: async (file) => {
      if (file === '/etc/os-release') return 'ID=debian\nVERSION_ID="13"\nVERSION_CODENAME=trixie\n';
      throw enoent();
    },
  });

  await assert.rejects(
    manager.apply(),
    (error) => error instanceof PassengerManagerError && error.code === 'passenger_platform_unsupported',
  );
  assert.equal(commands.length, 0);
});

test('Passenger manager blocks a non-dpkg Nginx binary', async () => {
  const commands = [];
  const manager = createPassengerManager({
    inspector: { inspect: async () => unhealthy },
    readFileFn: async (file) => {
      if (file === '/etc/os-release') return 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n';
      throw enoent();
    },
    run: async (file, args) => {
      commands.push([file, args]);
      if (file === '/usr/bin/dpkg-query') throw commandFailure(1);
      return { stdout: '' };
    },
    lstatFn: async (file) => {
      if (file === '/usr/sbin/nginx') return { isFile: () => true };
      throw enoent();
    },
  });

  await assert.rejects(
    manager.apply(),
    (error) => error instanceof PassengerManagerError && error.code === 'passenger_nginx_incompatible',
  );
  assert.equal(commands.some(([file]) => file === '/usr/bin/apt-get'), false);
});

test('Passenger manager installs from scoped APT source and requires healthy post-inspection', async () => {
  const commands = [];
  const writes = [];
  const renames = [];
  const symlinks = [];
  let inspections = 0;
  const manager = createPassengerManager({
    inspector: {
      inspect: async () => {
        inspections += 1;
        return inspections === 1 ? unhealthy : healthy;
      },
    },
    run: async (file, args) => {
      commands.push([file, args]);
      if (file === '/usr/bin/dpkg-query') return { stdout: 'nginx:amd64: /usr/sbin/nginx\n' };
      return { stdout: '' };
    },
    readFileFn: async (file) => {
      if (file === '/etc/os-release') return 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n';
      if (file.endsWith('.gpg')) return Buffer.from('test-keyring');
      throw enoent();
    },
    lstatFn: async (file) => {
      if (file === passengerManagerInternals.moduleLink) throw enoent();
      throw new Error(`unexpected lstat ${file}`);
    },
    mkdirFn: async () => {},
    writeFileFn: async (file, content, options) => { writes.push([file, content, options]); },
    renameFn: async (from, to) => { renames.push([from, to]); },
    readlinkFn: async () => { throw new Error('not expected'); },
    symlinkFn: async (from, to) => { symlinks.push([from, to]); },
  });

  const result = await manager.apply();
  assert.equal(result.changed, true);
  assert.equal(result.healthy, true);
  assert.equal(inspections, 2);
  assert.ok(commands.some(([file, args]) => file === '/usr/bin/apt-get'
    && args.join(' ') === 'install --yes --no-install-recommends nginx libnginx-mod-http-passenger'));
  assert.ok(commands.some(([file, args]) => file === '/usr/bin/curl' && args.includes(passengerManagerInternals.keyUrl)));
  assert.ok(commands.some(([file, args]) => file === '/usr/bin/gpg' && args.includes('--dearmor')));
  assert.ok(commands.some(([file, args]) => file === '/usr/sbin/nginx' && args.join(' ') === '-t'));
  assert.ok(commands.some(([file, args]) => file === '/usr/bin/systemctl' && args.join(' ') === 'restart nginx'));
  assert.deepEqual(symlinks, [[passengerManagerInternals.moduleSource, passengerManagerInternals.moduleLink]]);
  const repositoryWrite = writes.find(([, content]) => typeof content === 'string' && content.includes('oss-binaries.phusionpassenger.com'));
  assert.ok(repositoryWrite);
  assert.match(repositoryWrite[1], /signed-by=\/usr\/share\/keyrings\/yunpanel-phusion-passenger\.gpg/);
  assert.ok(renames.some(([, to]) => to === passengerManagerInternals.keyPath));
  assert.ok(renames.some(([, to]) => to === passengerManagerInternals.repositoryPath));
});

test('Passenger manager rejects an unexpected regular file at the managed module link path', async () => {
  let inspections = 0;
  const manager = createPassengerManager({
    inspector: { inspect: async () => (++inspections === 1 ? unhealthy : healthy) },
    run: async (file, args) => file === '/usr/bin/dpkg-query'
      ? { stdout: 'nginx: /usr/sbin/nginx\n' }
      : { stdout: '' },
    readFileFn: async (file) => {
      if (file === '/etc/os-release') return ubuntuRead(file);
      if (file.endsWith('.gpg')) return Buffer.from('test-keyring');
      throw enoent();
    },
    lstatFn: async (file) => file === passengerManagerInternals.moduleLink
      ? { isSymbolicLink: () => false }
      : (() => { throw enoent(); })(),
    mkdirFn: async () => {},
    writeFileFn: async () => {},
    renameFn: async () => {},
    symlinkFn: async () => {},
  });
  await assert.rejects(
    manager.apply(),
    (error) => error instanceof PassengerManagerError && error.code === 'passenger_module_link_conflict',
  );
});

test('Passenger manager never reports success when post-install inspection stays unhealthy', async () => {
  const manager = createPassengerManager({
    inspector: { inspect: async () => unhealthy },
    run: async (file) => file === '/usr/bin/dpkg-query'
      ? { stdout: 'nginx: /usr/sbin/nginx\n' }
      : { stdout: '' },
    readFileFn: async (file) => {
      if (file === '/etc/os-release') return 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n';
      if (file.endsWith('.gpg')) return Buffer.from('test-keyring');
      throw enoent();
    },
    lstatFn: async () => { throw enoent(); },
    mkdirFn: async () => {},
    writeFileFn: async () => {},
    renameFn: async () => {},
    symlinkFn: async () => {},
  });

  await assert.rejects(
    manager.apply(),
    (error) => error instanceof PassengerManagerError && error.code === 'passenger_install_incomplete',
  );
});

test('Passenger upgrade is a no-op when the APT candidate equals the healthy installed version', async () => {
  const commands = [];
  const manager = createPassengerManager({
    inspector: { inspect: async () => healthy },
    run: upgradeRun(commands, { candidate: healthy.installedVersion }),
    readFileFn: ubuntuRead,
  });

  const result = await manager.upgrade();
  assert.equal(result.changed, false);
  assert.equal(result.upgraded, false);
  assert.equal(result.previousVersion, healthy.installedVersion);
  assert.equal(result.candidateVersion, healthy.installedVersion);
  assert.equal(commands.some(([file, args]) => file === '/usr/bin/apt-get' && args.includes('--only-upgrade')), false);
});

test('Passenger upgrade installs the candidate and requires exact healthy postcondition evidence', async () => {
  const commands = [];
  let inspections = 0;
  const manager = createPassengerManager({
    inspector: { inspect: async () => (++inspections === 1 ? healthy : upgradedHealthy) },
    run: upgradeRun(commands),
    readFileFn: ubuntuRead,
  });

  const result = await manager.upgrade();
  assert.equal(result.changed, true);
  assert.equal(result.upgraded, true);
  assert.equal(result.previousVersion, healthy.installedVersion);
  assert.equal(result.candidateVersion, upgradedHealthy.installedVersion);
  assert.equal(result.installedVersion, upgradedHealthy.installedVersion);
  assert.ok(commands.some(([file, args]) => file === '/usr/bin/apt-get'
    && args.join(' ') === 'install --only-upgrade --yes --no-install-recommends libnginx-mod-http-passenger'));
  assert.ok(commands.some(([file, args]) => file === '/usr/sbin/nginx' && args.join(' ') === '-t'));
  assert.ok(commands.some(([file, args]) => file === '/usr/bin/systemctl' && args.join(' ') === 'restart nginx'));
});

test('Passenger upgrade failure injection after package mutation restores the exact previous package', async () => {
  const commands = [];
  let inspections = 0;
  const checkpoints = [];
  const manager = createPassengerManager({
    inspector: { inspect: async () => { inspections += 1; return healthy; } },
    run: upgradeRun(commands),
    readFileFn: ubuntuRead,
    checkpoint: async (name) => {
      checkpoints.push(name);
      if (name === 'after-package-upgrade') throw new Error('injected');
    },
  });

  await assert.rejects(
    manager.upgrade(),
    (error) => error instanceof PassengerManagerError && error.code === 'passenger_failure_injected',
  );
  assert.deepEqual(checkpoints, ['before-package-upgrade', 'after-package-upgrade']);
  assert.ok(commands.some(([file, args]) => file === '/usr/bin/apt-get'
    && args.includes(`${passengerManagerInternals.packageName}=${healthy.installedVersion}`)
    && args.includes('--allow-downgrades')));
  assert.ok(inspections >= 2);
});

test('Passenger unhealthy upgrade postcondition rolls back before returning failure', async () => {
  const commands = [];
  let inspections = 0;
  const brokenCandidate = { ...upgradedHealthy, healthy: false, moduleLoaded: false };
  const manager = createPassengerManager({
    inspector: {
      inspect: async () => {
        inspections += 1;
        if (inspections === 1) return healthy;
        if (inspections === 2) return brokenCandidate;
        return healthy;
      },
    },
    run: upgradeRun(commands),
    readFileFn: ubuntuRead,
  });

  await assert.rejects(
    manager.upgrade(),
    (error) => error instanceof PassengerManagerError && error.code === 'passenger_upgrade_incomplete',
  );
  assert.equal(inspections, 3);
  assert.ok(commands.some(([file, args]) => file === '/usr/bin/apt-get'
    && args.includes(`${passengerManagerInternals.packageName}=${healthy.installedVersion}`)));
});

test('Passenger rollback failure is explicit and does not report the original upgrade as recovered', async () => {
  const commands = [];
  const manager = createPassengerManager({
    inspector: { inspect: async () => healthy },
    run: upgradeRun(commands, { rollbackFails: true }),
    readFileFn: ubuntuRead,
    checkpoint: async (name) => {
      if (name === 'after-package-upgrade') throw new Error('injected');
    },
  });

  await assert.rejects(
    manager.upgrade(),
    (error) => error instanceof PassengerManagerError && error.code === 'passenger_upgrade_rollback_failed',
  );
});

test('Passenger manager parses only the supported Ubuntu identity, scoped repository and APT candidate', () => {
  assert.deepEqual(
    passengerManagerInternals.parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n'),
    { id: 'ubuntu', versionId: '24.04', codename: 'noble' },
  );
  assert.equal(passengerManagerInternals.nginxPackageOwner('nginx:amd64: /usr/sbin/nginx\n'), 'nginx');
  assert.match(passengerManagerInternals.repositoryContent(), /signed-by=/);
  assert.match(passengerManagerInternals.repositoryContent(), / noble main\n$/);
  assert.equal(
    passengerManagerInternals.parseAptPolicy('Installed: 1:6.1.3-1\nCandidate: 1:6.1.4-1\n'),
    '1:6.1.4-1',
  );
  assert.equal(passengerManagerInternals.parseAptPolicy('Candidate: (none)\n'), null);
});
