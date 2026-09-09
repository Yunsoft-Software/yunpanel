import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSystemPackageManager,
  SystemPackageManagerError,
  systemPackageManagerInternals,
} from '../src/index.js';

test('APT policy parsing reports installed and candidate YunPanel versions', () => {
  const state = systemPackageManagerInternals.packageState(systemPackageManagerInternals.parsePolicy(`
yunpanel:
  Installed: 0.1.0-1
  Candidate: 0.2.0-1
  Version table:
 *** 0.1.0-1 100
`));
  assert.deepEqual(state, {
    packageName: 'yunpanel',
    installed: true,
    installedVersion: '0.1.0-1',
    candidateVersion: '0.2.0-1',
    updateAvailable: true,
  });
});

test('upgrade refreshes APT, upgrades only YunPanel and schedules the configured services', async () => {
  const calls = [];
  let installedVersion = '0.1.0-1';
  const manager = createSystemPackageManager({
    now: () => 123456,
    restartDelaySeconds: 10,
    restartUnits: ['yunpanel-api.service', 'yunpanel-web.service'],
    run: async (file, args) => {
      calls.push({ file, args });
      if (file === '/usr/bin/apt-cache') return { stdout: `Installed: ${installedVersion}\nCandidate: 0.2.0-1\n` };
      if (file === '/usr/bin/apt-get' && args[0] === 'install') installedVersion = '0.2.0-1';
      return { stdout: '' };
    },
  });

  const result = await manager.upgrade();
  assert.equal(result.previousVersion, '0.1.0-1');
  assert.equal(result.installedVersion, '0.2.0-1');
  assert.equal(result.upgraded, true);
  assert.deepEqual(calls.find((call) => call.file === '/usr/bin/apt-get' && call.args[0] === 'install')?.args, [
    'install', '--only-upgrade', '--yes', '--no-install-recommends', 'yunpanel',
  ]);
  assert.deepEqual(calls.at(-1).args, [
    '--unit=yunpanel-upgrade-restart-123456',
    '--on-active=10s',
    '--timer-property=AccuracySec=1s',
    '/bin/systemctl',
    'restart',
    'yunpanel-api.service',
    'yunpanel-web.service',
  ]);
});

test('legacy default restart list remains compatible while the agent exists', () => {
  assert.deepEqual(systemPackageManagerInternals.defaultRestartUnits, [
    'yunpanel-api.service', 'yunpanel-web.service', 'yun-agent.service',
  ]);
});

test('restart unit selection rejects arbitrary systemd units', () => {
  assert.throws(() => createSystemPackageManager({ restartUnits: ['ssh.service'] }), /unsupported service unit/);
  assert.throws(() => createSystemPackageManager({ restartUnits: ['yunpanel-api.service', 'yunpanel-api.service'] }), /unsupported service unit/);
});

test('upgrade is a no-op when the installed package is current', async () => {
  const calls = [];
  const manager = createSystemPackageManager({
    run: async (file, args) => {
      calls.push({ file, args });
      if (file === '/usr/bin/apt-cache') return { stdout: 'Installed: 0.2.0-1\nCandidate: 0.2.0-1\n' };
      return { stdout: '' };
    },
  });
  const result = await manager.upgrade();
  assert.equal(result.upgraded, false);
  assert.equal(calls.some((call) => call.args[0] === 'install'), false);
  assert.equal(calls.some((call) => call.file === '/usr/bin/systemd-run'), false);
});

test('upgrade fails closed when YunPanel is not APT-managed', async () => {
  const manager = createSystemPackageManager({
    run: async () => ({ stdout: 'Installed: (none)\nCandidate: (none)\n' }),
  });
  await assert.rejects(
    manager.upgrade(),
    (error) => error instanceof SystemPackageManagerError && error.code === 'yunpanel_not_packaged',
  );
});
