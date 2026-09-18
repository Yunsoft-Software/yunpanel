import assert from 'node:assert/strict';
import test from 'node:test';
import { createSftpSiteManager, SftpSiteManagerError } from '../src/sftp-site-manager.js';

const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const unixUser = 'yunapp-4dc352e64a14';
const sourceDirectory = `/var/lib/yunpanel/data/${applicationId}`;
const chrootRoot = '/var/lib/yunpanel/sftp-chroots';
const chrootDirectory = `${chrootRoot}/${applicationId}`;
const mountDirectory = `${chrootDirectory}/site`;
const sshdConfigPath = `/etc/ssh/sshd_config.d/90-yunpanel-sftp-${unixUser}.conf`;
const unitName = `var-lib-yunpanel-sftp\\x2dchroots-${applicationId}-site.mount`;
const unitPath = `/etc/systemd/system/${unitName}`;

function intent() {
  return { websiteId, applicationId, unixUser };
}

function fakeHost() {
  const files = new Map();
  const dirs = new Map();
  const activeUnits = new Set();
  const calls = [];
  const removals = [];
  const writeFileFn = async (target, content, options = {}) => {
    files.set(target, { content: String(content), mode: options.mode ?? 0o600 });
  };
  const readFileFn = async (target) => {
    const value = files.get(target);
    if (!value) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
    return value.content;
  };
  const renameFn = async (source, target) => {
    const value = files.get(source);
    if (!value) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
    files.set(target, value);
    files.delete(source);
  };
  const rmFn = async (target, options = {}) => {
    removals.push([target, { ...options }]);
    files.delete(target);
    dirs.delete(target);
  };
  const mkdirFn = async () => {};
  const lstatFn = async (target) => {
    const value = dirs.get(target);
    if (!value) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
    return {
      uid: value.uid,
      gid: value.gid,
      mode: value.mode,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    };
  };
  const run = async (file, args) => {
    calls.push([file, [...args]]);
    if (file === '/usr/bin/systemd-escape') return { stdout: `${unitName}\n` };
    if (file === '/usr/bin/install') {
      const target = args.at(-1);
      dirs.set(target, { uid: 0, gid: 0, mode: 0o755 });
      return { stdout: '' };
    }
    if (file === '/usr/sbin/sshd' && args[0] === '-t') return { stdout: '' };
    if (file === '/usr/bin/systemctl' && args[0] === 'daemon-reload') return { stdout: '' };
    if (file === '/usr/bin/systemctl' && args[0] === 'enable') {
      activeUnits.add(args.at(-1));
      return { stdout: '' };
    }
    if (file === '/usr/bin/systemctl' && args[0] === 'disable') {
      activeUnits.delete(args.at(-1));
      return { stdout: '' };
    }
    if (file === '/usr/bin/systemctl' && args[0] === 'reload') return { stdout: '' };
    if (file === '/usr/bin/systemctl' && args[0] === 'is-active') {
      if (!activeUnits.has(args.at(-1))) { const error = new Error('inactive'); error.code = 3; throw error; }
      return { stdout: '' };
    }
    throw new Error(`unexpected command ${file} ${args.join(' ')}`);
  };
  return { files, dirs, activeUnits, calls, removals, run, writeFileFn, readFileFn, renameFn, rmFn, mkdirFn, lstatFn };
}

function manager(host) {
  return createSftpSiteManager({
    identityManager: {
      inspect: async (value) => {
        assert.deepEqual(value, { user: unixUser, homeDirectory: sourceDirectory, websiteId, applicationId });
        return { satisfied: true, user: unixUser, uid: 1201, gid: 1201, homeDirectory: sourceDirectory };
      },
    },
    run: host.run,
    writeFileFn: host.writeFileFn,
    readFileFn: host.readFileFn,
    renameFn: host.renameFn,
    rmFn: host.rmFn,
    mkdirFn: host.mkdirFn,
    lstatFn: host.lstatFn,
  });
}

test('SFTP apply creates a root-owned chroot, persistent bind mount and validated OpenSSH Match rule', async () => {
  const host = fakeHost();
  const value = manager(host);

  const result = await value.apply(intent(), { operationId });

  assert.equal(result.satisfied, true);
  assert.equal(result.adapter, 'openssh-internal-sftp');
  assert.equal(result.sourceDirectory, sourceDirectory);
  assert.equal(result.chrootDirectory, chrootDirectory);
  assert.equal(result.mountDirectory, mountDirectory);
  assert.equal(result.passwordAuthentication, false);
  assert.equal(result.publicKeyAuthentication, true);
  assert.equal(result.umask, '0027');
  assert.deepEqual(host.dirs.get(chrootRoot), { uid: 0, gid: 0, mode: 0o755 });
  assert.deepEqual(host.dirs.get(chrootDirectory), { uid: 0, gid: 0, mode: 0o755 });
  assert.match(host.files.get(sshdConfigPath).content, new RegExp(`Match User ${unixUser}`));
  assert.match(host.files.get(sshdConfigPath).content, /ForceCommand internal-sftp -d \/site -u 0027/);
  assert.match(host.files.get(sshdConfigPath).content, /Match all\n$/);
  assert.match(host.files.get(unitPath).content, new RegExp(`What=${sourceDirectory}`));
  assert.equal(host.activeUnits.has(unitName), true);
  assert.equal(host.calls.some(([file, args]) => file === '/usr/sbin/sshd' && args[0] === '-t'), true);
  assert.equal(host.calls.some(([file, args]) => file === '/usr/bin/systemctl' && args[0] === 'reload' && args[1] === 'ssh.service'), true);
});

test('SFTP apply is idempotent for the same durable operation', async () => {
  const host = fakeHost();
  const value = manager(host);
  await value.apply(intent(), { operationId });
  const second = await value.apply(intent(), { operationId });
  assert.equal(second.satisfied, true);
  assert.equal(second.unitName, unitName);
});

test('SFTP provisioning refuses foreign pre-existing artifacts without an ownership receipt', async () => {
  const host = fakeHost();
  host.files.set(sshdConfigPath, { content: 'Match User attacker\n', mode: 0o600 });
  const value = manager(host);

  await assert.rejects(
    value.apply(intent(), { operationId }),
    (error) => error instanceof SftpSiteManagerError && error.code === 'sftp_artifact_conflict',
  );
  assert.equal(host.activeUnits.size, 0);
});

test('SFTP compensation removes receipt-owned config and unit while preserving unowned chroot directories', async () => {
  const host = fakeHost();
  const value = manager(host);
  await value.apply(intent(), { operationId });

  const result = await value.compensate(intent(), { operationId });

  assert.equal(result.satisfied, true);
  assert.equal(result.removed, true);
  assert.equal(host.files.has(sshdConfigPath), false);
  assert.equal(host.files.has(unitPath), false);
  assert.equal(host.activeUnits.has(unitName), false);
  assert.equal(host.dirs.has(chrootDirectory), true);
  assert.equal(host.dirs.has(mountDirectory), true);
  assert.equal(host.removals.some(([target]) => [chrootDirectory, mountDirectory].includes(target)), false);
});

test('SFTP compensation fails closed after managed SSH config drift', async () => {
  const host = fakeHost();
  const value = manager(host);
  await value.apply(intent(), { operationId });
  host.files.get(sshdConfigPath).content = 'Match User changed\n';

  await assert.rejects(
    value.compensate(intent(), { operationId }),
    (error) => error instanceof SftpSiteManagerError && error.code === 'sftp_compensation_drift',
  );
  assert.equal(host.activeUnits.has(unitName), true);
});


test('SFTP migration preview reports exact artifact state without exposing config contents or mutating host state', async () => {
  const host = fakeHost();
  const value = manager(host);
  await value.apply(intent(), { operationId });
  const callsBefore = host.calls.length;

  const preview = await value.previewMigration(intent(), { operationId });

  assert.equal(preview.version, 1);
  assert.equal(preview.satisfied, true);
  assert.equal(preview.current.receiptState, 'active');
  assert.equal(preview.current.sshdConfig.present, true);
  assert.equal(preview.current.sshdConfig.matchesDesired, true);
  assert.match(preview.current.sshdConfig.sha256, /^[a-f0-9]{64}$/);
  assert.equal(preview.current.mountUnit.active, true);
  assert.equal(preview.current.chrootDirectory.mode, '0755');
  assert.equal(preview.desired.sourceDirectory, sourceDirectory);
  assert.equal(preview.desired.chrootDirectory, chrootDirectory);
  assert.deepEqual(preview.differences, []);
  assert.equal(JSON.stringify(preview).includes('ForceCommand'), false);
  assert.equal(JSON.stringify(preview).includes(`Match User ${unixUser}`), false);

  const previewCalls = host.calls.slice(callsBefore);
  assert.equal(previewCalls.some(([file, args]) => file === '/usr/bin/install'
    || (file === '/usr/bin/systemctl' && ['enable', 'disable', 'reload', 'daemon-reload'].includes(args[0]))), false);
});

test('SFTP migration preview keeps legacy state blocked when ownership receipt and artifacts are absent', async () => {
  const host = fakeHost();
  const value = manager(host);

  const preview = await value.previewMigration(intent(), { operationId });

  assert.equal(preview.satisfied, false);
  assert.equal(preview.current.receiptState, null);
  assert.equal(preview.current.sshdConfig.present, false);
  assert.equal(preview.current.mountUnit.present, false);
  assert.equal(preview.current.mountUnit.active, false);
  assert.equal(preview.current.chrootDirectory.present, false);
  assert.equal(preview.differences.includes('sftp_receipt_missing'), true);
  assert.equal(preview.differences.includes('sftp_sshd_config_missing'), true);
  assert.equal(preview.differences.includes('sftp_mount_unit_missing'), true);
  assert.equal(preview.differences.includes('sftp_mount_inactive'), true);
  assert.equal(host.calls.some(([file, args]) => file === '/usr/bin/install'
    || (file === '/usr/bin/systemctl' && ['enable', 'disable', 'reload', 'daemon-reload'].includes(args[0]))), false);
});
