import assert from 'node:assert/strict';
import test from 'node:test';
import { createNodeProcessManager, NodeProcessError } from '../src/node-process-manager.js';

const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const releaseId = 'ff830043-9752-4640-83b4-3a1998de78a0';

function spec(action) {
  return { applicationId, releaseId, runtime: { nodeMajor: 24, port: 3100 }, action };
}

function harness({ states = [], healthy = true, waitHealthy = true, release = releaseId } = {}) {
  const commands = [];
  let stateIndex = 0;
  const manager = createNodeProcessManager({
    appRoot: '/apps',
    systemctlPaths: ['/usr/bin/systemctl'],
    readlinkFn: async () => `releases/${release}`,
    healthCheck: async () => healthy,
    waitForHealth: async () => waitHealthy,
    run: async (file, args, options) => {
      commands.push({ file, args, options });
      if (args[0] === '--version') return { stdout: 'systemd 255\n' };
      if (args[0] === 'show') {
        const state = states[Math.min(stateIndex++, states.length - 1)] ?? { active: false, enabled: false };
        return { stdout: [
          'LoadState=loaded',
          `ActiveState=${state.activeState ?? (state.active ? 'active' : 'inactive')}`,
          `SubState=${state.active ? 'running' : 'dead'}`,
          `UnitFileState=${state.unitFileState ?? (state.enabled ? 'enabled' : 'disabled')}`,
          `MainPID=${state.mainPid ?? (state.active ? '42' : '0')}`,
        ].join('\n') };
      }
      return { stdout: '' };
    },
  });
  return { manager, commands };
}

test('enable, disable, start and stop use exact systemd actions and verified state', async () => {
  for (const [action, state] of [
    ['enable', { enabled: true, active: false }],
    ['disable', { enabled: false, active: true }],
    ['start', { enabled: true, active: true }],
    ['stop', { enabled: true, active: false }],
  ]) {
    const stateHarness = harness({ states: [state] });
    const result = await stateHarness.manager.controlNodeProcess(spec(action));
    assert.equal(result.action, action);
    assert.equal(result.enabled, state.enabled);
    assert.equal(result.active, state.active);
    assert.equal(result.healthy, state.active);
    assert.ok(stateHarness.commands.some((entry) => entry.args[0] === action && entry.args[1] === result.serviceName));
    assert.equal(stateHarness.commands.some((entry) => entry.args.length > 2 && entry.args[0] === action), false);
  }
});

test('unhealthy start is stopped and reported without claiming an active process', async () => {
  const stateHarness = harness({
    states: [{ enabled: true, active: true }, { enabled: true, active: false }],
    waitHealthy: false,
  });
  await assert.rejects(
    stateHarness.manager.controlNodeProcess(spec('start')),
    (error) => error instanceof NodeProcessError && error.code === 'node_process_start_health_failed',
  );
  assert.ok(stateHarness.commands.some((entry) => entry.args[0] === 'stop'));
});

test('ambiguous disabled and stopped systemd states are rejected', async () => {
  const masked = harness({ states: [{ enabled: false, active: false, unitFileState: 'masked' }] });
  await assert.rejects(masked.manager.controlNodeProcess(spec('disable')), { code: 'node_process_disable_unconfirmed' });

  const failed = harness({ states: [{ enabled: true, active: false, activeState: 'failed' }] });
  await assert.rejects(failed.manager.controlNodeProcess(spec('stop')), { code: 'node_process_stop_unconfirmed' });
});
