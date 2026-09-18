import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTtydRuntimeManager,
  TtydRuntimeError,
  ttydRuntimeInternals,
} from '../src/ttyd-runtime-manager.js';

function fileStat({ uid = 0, gid = 0, mode = 0o755 } = {}) {
  return {
    uid, gid, mode,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

function fixture({ installed = true, masked = true, active = false, uid = 0, mode = 0o755 } = {}) {
  const calls = [];
  let packageInstalled = installed;
  let serviceMasked = masked;
  let serviceActive = active;

  const run = async (file, args) => {
    calls.push([file, [...args]]);
    if (file === '/usr/bin/dpkg-query') {
      if (!packageInstalled) throw Object.assign(new Error('not installed'), { code: 1 });
      return { stdout: 'install ok installed\t1.7.4-1build2', stderr: '' };
    }
    if (file === '/usr/bin/ttyd' && args[0] === '--version') {
      return { stdout: 'ttyd version 1.7.4\n', stderr: '' };
    }
    if (file === '/usr/bin/systemctl' && args[0] === 'show') {
      return {
        stdout: [
          'LoadState=loaded',
          `ActiveState=${serviceActive ? 'active' : 'inactive'}`,
          `UnitFileState=${serviceMasked ? 'masked' : 'enabled'}`,
        ].join('\n'),
        stderr: '',
      };
    }
    if (file === '/usr/bin/systemctl' && args[0] === 'mask') {
      serviceMasked = true;
      if (args.includes('--now')) serviceActive = false;
      return { stdout: '', stderr: '' };
    }
    if (file === '/usr/bin/apt-get') {
      packageInstalled = true;
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
  };

  return {
    calls,
    manager: createTtydRuntimeManager({
      run,
      lstatFn: async () => fileStat({ uid, mode }),
      getuid: () => 0,
    }),
  };
}

test('ttyd runtime accepts only installed binary with masked inactive distro service', async () => {
  const fx = fixture();
  const result = await fx.manager.inspect();

  assert.equal(result.satisfied, true);
  assert.equal(result.packageName, 'ttyd');
  assert.equal(result.packageVersion, '1.7.4-1build2');
  assert.equal(result.binaryPath, '/usr/bin/ttyd');
  assert.equal(result.binaryVersion, '1.7.4');
  assert.equal(result.distroService, 'ttyd.service');
  assert.equal(result.distroServiceMasked, true);
  assert.equal(result.distroServiceActive, false);
});

test('ttyd apply masks distro service before package install and verifies it again with --now', async () => {
  const fx = fixture({ installed: false, masked: false });
  const result = await fx.manager.apply();

  assert.equal(result.satisfied, true);
  assert.equal(result.changed, true);

  const firstMask = fx.calls.findIndex(([file, args]) =>
    file === '/usr/bin/systemctl' && args.join(' ') === 'mask ttyd.service');
  const install = fx.calls.findIndex(([file]) => file === '/usr/bin/apt-get');
  const finalMask = fx.calls.findIndex(([file, args]) =>
    file === '/usr/bin/systemctl' && args.join(' ') === 'mask --now ttyd.service');

  assert.ok(firstMask >= 0);
  assert.ok(install > firstMask);
  assert.ok(finalMask > install);
  assert.deepEqual(
    fx.calls.find(([file]) => file === '/usr/bin/apt-get')?.[1],
    ['install', '--yes', '--no-install-recommends', 'ttyd'],
  );
});

test('ttyd inspect rejects active or enabled distro service and unsafe binary', async () => {
  for (const options of [
    { active: true },
    { masked: false },
  ]) {
    const fx = fixture(options);
    const result = await fx.manager.inspect();
    assert.equal(result.satisfied, false);
    assert.equal(result.reason, 'ttyd_service_not_masked');
  }

  for (const options of [
    { uid: 1000 },
    { mode: 0o775 },
  ]) {
    const fx = fixture(options);
    await assert.rejects(
      fx.manager.inspect(),
      (error) => error instanceof TtydRuntimeError
        && error.code === 'ttyd_binary_unsafe',
    );
  }
});

test('ttyd apply requires the root panel service and never starts the distro unit', async () => {
  const calls = [];
  const manager = createTtydRuntimeManager({
    getuid: () => 1000,
    lstatFn: async () => fileStat(),
    run: async (file, args) => {
      calls.push([file, args]);
      if (file === '/usr/bin/dpkg-query') throw Object.assign(new Error('missing'), { code: 1 });
      return { stdout: '', stderr: '' };
    },
  });

  await assert.rejects(
    manager.apply(),
    (error) => error instanceof TtydRuntimeError
      && error.code === 'ttyd_root_runtime_required',
  );
  assert.equal(calls.some(([file, args]) =>
    file === '/usr/bin/systemctl' && ['start', 'enable'].includes(args[0])), false);
});

test('ttyd runtime parser pins the expected command and service identity', () => {
  assert.equal(ttydRuntimeInternals.paths.TTYD, '/usr/bin/ttyd');
  assert.equal(ttydRuntimeInternals.packageName, 'ttyd');
  assert.equal(ttydRuntimeInternals.serviceUnit, 'ttyd.service');
  assert.deepEqual(
    ttydRuntimeInternals.parseServiceState(
      'LoadState=loaded\nActiveState=inactive\nUnitFileState=masked\n',
    ),
    {
      loadState: 'loaded',
      activeState: 'inactive',
      unitFileState: 'masked',
    },
  );
});
