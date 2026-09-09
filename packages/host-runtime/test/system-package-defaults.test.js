import test from 'node:test';
import assert from 'node:assert/strict';
import { createSystemPackageManager, systemPackageManager, systemPackageManagerInternals } from '../src/system-package-manager.js';

function fixture(restartUnits) {
  const calls = [];
  let version = '0.1.0-1';
  const manager = createSystemPackageManager({
    ...(restartUnits ? { restartUnits } : {}),
    now: () => 123456,
    run: async (file, args) => {
      calls.push({ file, args });
      if (file === '/usr/bin/apt-cache') return { stdout: `Installed: ${version}\nCandidate: 0.2.0-1\n` };
      if (file === '/usr/bin/apt-get' && args[0] === 'install') version = '0.2.0-1';
      return { stdout: '' };
    },
  });
  return { manager, calls };
}

test('import and default construction accept the existing legacy service list', () => {
  assert.equal(typeof systemPackageManager.inspect, 'function');
  assert.equal(typeof createSystemPackageManager().upgrade, 'function');
  assert.deepEqual(systemPackageManagerInternals.normalizeRestartUnits(systemPackageManagerInternals.defaultRestartUnits), [
    'yunpanel-api.service', 'yunpanel-web.service', 'yun-agent.service',
  ]);
});

test('legacy default upgrade schedules exactly the existing service identities', async () => {
  const { manager, calls } = fixture();
  const result = await manager.upgrade();
  assert.equal(result.upgraded, true);
  assert.deepEqual(calls.at(-1), { file: '/usr/bin/systemd-run', args: [
    '--unit=yunpanel-upgrade-restart-123456', '--on-active=10s', '--timer-property=AccuracySec=1s',
    '/bin/systemctl', 'restart', 'yunpanel-api.service', 'yunpanel-web.service', 'yun-agent.service',
  ] });
});

test('local backend restart override still excludes the agent', async () => {
  const { manager, calls } = fixture(['yunpanel-api.service', 'yunpanel-web.service']);
  await manager.upgrade();
  assert.deepEqual(calls.at(-1).args.slice(5), ['yunpanel-api.service', 'yunpanel-web.service']);
});

test('the exception does not permit arbitrary or lookalike service names', () => {
  for (const unit of ['ssh.service', 'nginx.service', 'yun-agent-other.service', 'yun-agent.service/other', 'yun-agent.service\n', 'yun-agent.service;id', '--all', '', null]) {
    assert.throws(() => createSystemPackageManager({ restartUnits: [unit] }), /unsupported service unit/);
  }
  assert.throws(() => createSystemPackageManager({ restartUnits: ['yun-agent.service', 'yun-agent.service'] }), /unsupported service unit/);
});

test('normalization returns a defensive copy without mutating defaults', () => {
  const units = systemPackageManagerInternals.normalizeRestartUnits(systemPackageManagerInternals.defaultRestartUnits);
  units.push('unrelated.service');
  assert.equal(systemPackageManagerInternals.defaultRestartUnits.length, 3);
  assert.equal(systemPackageManagerInternals.normalizeRestartUnits(systemPackageManagerInternals.defaultRestartUnits).length, 3);
});
