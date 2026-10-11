import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPassengerManager, passengerManagerInternals as policy } from '../src/passenger-manager.js';

for (const stopBeforePackage of [false, true]) test(`Passenger repository remains readable under umask 0077 and absent packages are not purged: ${stopBeforePackage}`, async t => {
  const oldUmask = process.umask(0o077); t.after(() => process.umask(oldUmask));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yp-passenger-permissions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const mapped = file => path.join(root, path.basename(file));
  await fs.writeFile(mapped(policy.keyPath), 'public signing key', { mode: 0o600 });
  await fs.writeFile(mapped(policy.repositoryPath), policy.repositoryContent(), { mode: 0o600 });
  let installed = false, removed = false;
  const unavailable = { installed: false, healthy: false, installedVersion: null };
  const manager = createPassengerManager({
    inspector: { inspect: async () => installed ? { installed: true, healthy: true, installedVersion: '1:6.1.4-1' } : unavailable },
    lstatFn: file => fs.lstat(mapped(file)),
    readFileFn: (file, encoding) => file === '/etc/os-release' ? 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n' : fs.readFile(mapped(file), encoding),
    writeFileFn: (file, data, options) => fs.writeFile(mapped(file), data, options),
    chmodFn: (file, mode) => fs.chmod(mapped(file), mode),
    renameFn: (from, to) => fs.rename(mapped(from), mapped(to)),
    rmFn: (file, options) => fs.rm(mapped(file), options),
    mkdirFn: async () => {},
    symlinkFn: (target, file) => fs.symlink(target, mapped(file)),
    readlinkFn: file => fs.readlink(mapped(file)),
    run: async (file, args) => {
      if (file === '/usr/bin/dpkg-query') {
        if (args[0] === '-W') throw Object.assign(new Error('package absent'), { code: 1 });
        return { stdout: 'nginx:amd64: /usr/sbin/nginx\n' };
      }
      if (file === '/usr/bin/gpg') await fs.writeFile(mapped(args[args.indexOf('--output') + 1]), 'public signing key');
      if (file === '/usr/bin/apt-get' && args[0] === 'update') {
        for (const candidate of [policy.keyPath, policy.repositoryPath]) assert.equal((await fs.lstat(mapped(candidate))).mode & 0o777, 0o644);
      }
      if (file === '/usr/bin/apt-get' && args[0] === 'install' && args.includes(policy.packageName)) installed = true;
      if (file === '/usr/bin/apt-get' && args[0] === 'remove') removed = true;
      return { stdout: '' };
    },
    checkpoint: async name => { if (stopBeforePackage && name === 'after-repository') throw new Error('stop'); },
  });
  if (stopBeforePackage) await assert.rejects(manager.apply(), { code: 'passenger_failure_injected' });
  else assert.equal((await manager.apply()).healthy, true);
  assert.equal(removed, false);
  for (const candidate of [policy.keyPath, policy.repositoryPath]) assert.equal((await fs.lstat(mapped(candidate))).mode & 0o777, 0o644);
});
