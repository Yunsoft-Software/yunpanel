import assert from 'node:assert/strict';
import test from 'node:test';
import { createNodeRestartManager, NodeRestartError } from '../src/node-restart-manager.js';

const APPLICATION_ID = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const RELEASE_ID = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
const OTHER_RELEASE = 'ff830043-9752-4640-83b4-3a1998de78a0';

function restartSpec() {
  return {
    applicationId: APPLICATION_ID,
    releaseId: RELEASE_ID,
    runtime: {
      nodeMajor: 24,
      installMode: 'ci',
      buildScript: 'build',
      startMode: 'node',
      entryFile: 'dist/server.js',
      port: 3100,
      healthPath: '/health',
      healthTimeoutSeconds: 10,
      restartPolicy: 'on-failure',
    },
  };
}

function createHarness({ currentRelease = RELEASE_ID, healthy = true, restartFails = false } = {}) {
  const commands = [];
  const run = async (file, args) => {
    commands.push({ file, args });
    if (file === '/usr/bin/systemctl' && args[0] === '--version') return { stdout: 'systemd 255\n' };
    if (file === '/usr/bin/systemctl' && args[0] === 'restart') {
      if (restartFails) {
        const error = new Error('restart failed');
        error.code = 1;
        throw error;
      }
      return { stdout: '' };
    }
    throw new Error('unexpected command');
  };

  const manager = createNodeRestartManager({
    appRoot: '/apps',
    run,
    systemctlPaths: ['/usr/bin/systemctl'],
    readlinkFn: async () => `releases/${currentRelease}`,
    waitForHealth: async () => healthy,
  });
  return { manager, commands };
}

test('healthy Node restart is bound to the current managed release', async () => {
  const harness = createHarness();
  const result = await harness.manager.restartNode(restartSpec());

  assert.equal(result.releaseId, RELEASE_ID);
  assert.equal(result.port, 3100);
  assert.equal(result.healthPath, '/health');
  assert.equal(result.healthy, true);
  assert.equal(result.restarted, true);
  assert.ok(result.serviceName.startsWith('yunpanel-node-'));
  assert.equal(harness.commands.filter((entry) => entry.args[0] === 'restart').length, 1);
});

test('Node restart rejects release drift before touching systemd', async () => {
  const harness = createHarness({ currentRelease: OTHER_RELEASE });

  await assert.rejects(
    harness.manager.restartNode(restartSpec()),
    (error) => error instanceof NodeRestartError && error.code === 'node_restart_release_drift',
  );
  assert.equal(harness.commands.length, 0);
});

test('Node restart reports failed health checks after systemd restart', async () => {
  const harness = createHarness({ healthy: false });

  await assert.rejects(
    harness.manager.restartNode(restartSpec()),
    (error) => error instanceof NodeRestartError && error.code === 'node_restart_health_failed',
  );
  assert.equal(harness.commands.filter((entry) => entry.args[0] === 'restart').length, 1);
});

test('Node restart wraps systemd command failures without leaking command details', async () => {
  const harness = createHarness({ restartFails: true });

  await assert.rejects(
    harness.manager.restartNode(restartSpec()),
    (error) => error instanceof NodeRestartError && error.code === 'node_restart_command_failed',
  );
});
