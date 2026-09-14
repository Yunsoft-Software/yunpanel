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

const unavailable = Object.freeze({
  packageName: passengerManagerInternals.packageName,
  installed: false,
  installedVersion: null,
  passengerRoot: null,
  nginxPassengerRoots: Object.freeze([]),
  moduleLoaded: false,
  installValid: false,
  systemNodeVersion: null,
  healthy: false,
});

function regular(mode = 0o644) {
  return { mode, isFile: () => true, isSymbolicLink: () => false };
}

function link() {
  return { mode: 0o777, isFile: () => false, isSymbolicLink: () => true };
}

function ubuntu() {
  return 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n';
}

test('Passenger install failure restores managed config and removes a newly added Passenger package', async () => {
  const commands = [];
  const writes = [];
  const renames = [];
  const removals = [];
  const symlinks = [];
  let inspections = 0;
  const oldKey = Buffer.from('old-keyring');
  const oldRepository = 'deb [signed-by=/old/key.gpg] https://old.example.invalid noble main\n';

  const manager = createPassengerManager({
    inspector: { inspect: async () => { inspections += 1; return unavailable; } },
    run: async (file, args) => {
      commands.push([file, args]);
      if (file === '/usr/bin/dpkg-query') return { stdout: 'nginx:amd64: /usr/sbin/nginx\n' };
      return { stdout: '' };
    },
    readFileFn: async (file) => {
      if (file === '/etc/os-release') return ubuntu();
      if (file === passengerManagerInternals.keyPath) return oldKey;
      if (file === passengerManagerInternals.repositoryPath) return oldRepository;
      if (file.endsWith('.gpg')) return Buffer.from('new-keyring');
      throw enoent();
    },
    lstatFn: async (file) => {
      if (file === passengerManagerInternals.keyPath) return regular(0o640);
      if (file === passengerManagerInternals.repositoryPath) return regular(0o644);
      if (file === passengerManagerInternals.moduleLink) return link();
      throw enoent();
    },
    readlinkFn: async (file) => {
      if (file === passengerManagerInternals.moduleLink) return passengerManagerInternals.moduleSource;
      throw enoent();
    },
    mkdirFn: async () => {},
    writeFileFn: async (file, content, options) => { writes.push([file, content, options]); },
    renameFn: async (from, to) => { renames.push([from, to]); },
    rmFn: async (file, options) => { removals.push([file, options]); },
    symlinkFn: async (target, file) => { symlinks.push([target, file]); },
    checkpoint: async (name) => {
      if (name === 'after-package-install') throw new Error('injected');
    },
  });

  await assert.rejects(
    manager.apply(),
    (error) => error instanceof PassengerManagerError && error.code === 'passenger_failure_injected',
  );

  assert.equal(inspections, 2);
  assert.ok(commands.some(([file, args]) => file === '/usr/bin/apt-get'
    && args.join(' ') === `remove --yes --purge ${passengerManagerInternals.packageName}`));
  assert.ok(commands.some(([file, args]) => file === '/usr/sbin/nginx' && args.join(' ') === '-t'));
  assert.ok(commands.some(([file, args]) => file === '/usr/bin/systemctl' && args.join(' ') === 'restart nginx'));
  assert.ok(removals.some(([file]) => file === passengerManagerInternals.keyPath));
  assert.ok(removals.some(([file]) => file === passengerManagerInternals.repositoryPath));
  assert.ok(removals.some(([file]) => file === passengerManagerInternals.moduleLink));
  assert.ok(renames.some(([from, to]) => from.includes('.rollback.tmp') && to === passengerManagerInternals.keyPath));
  assert.ok(renames.some(([from, to]) => from.includes('.rollback.tmp') && to === passengerManagerInternals.repositoryPath));
  assert.ok(writes.some(([file, content, options]) => file.includes('.rollback.tmp')
    && Buffer.isBuffer(content) && content.equals(oldKey) && options.mode === 0o640));
  assert.ok(writes.some(([file, content, options]) => file.includes('.rollback.tmp')
    && content === oldRepository && options.mode === 0o644));
  assert.ok(symlinks.some(([target, file]) => target === passengerManagerInternals.moduleSource
    && file === passengerManagerInternals.moduleLink));
});

test('fresh-host rollback stays fail-closed instead of blindly removing a newly installed Nginx', async () => {
  const commands = [];
  let inspections = 0;
  const manager = createPassengerManager({
    inspector: { inspect: async () => { inspections += 1; return unavailable; } },
    run: async (file, args) => {
      commands.push([file, args]);
      if (file === '/usr/bin/dpkg-query') throw commandFailure(1);
      return { stdout: '' };
    },
    readFileFn: async (file) => {
      if (file === '/etc/os-release') return ubuntu();
      if (file.endsWith('.gpg')) return Buffer.from('new-keyring');
      throw enoent();
    },
    lstatFn: async () => { throw enoent(); },
    readlinkFn: async () => { throw enoent(); },
    mkdirFn: async () => {},
    writeFileFn: async () => {},
    renameFn: async () => {},
    rmFn: async () => {},
    symlinkFn: async () => {},
    checkpoint: async (name) => {
      if (name === 'after-package-install') throw new Error('injected');
    },
  });

  await assert.rejects(
    manager.apply(),
    (error) => error instanceof PassengerManagerError && error.code === 'passenger_install_rollback_incomplete',
  );
  assert.equal(inspections, 1);
  assert.ok(commands.some(([file, args]) => file === '/usr/bin/apt-get'
    && args.join(' ') === `remove --yes --purge ${passengerManagerInternals.packageName}`));
  assert.equal(commands.some(([file, args]) => file === '/usr/bin/apt-get'
    && args[0] === 'remove' && args.includes('nginx')), false);
});
