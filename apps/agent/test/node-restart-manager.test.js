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

function createHarness({
  currentRelease = RELEASE_ID,
  healthResults = [true],
  failFirstRestart = false,
  failAllRestarts = false,
} = {}) {
  const commands = [];
  const environments = [];
  let healthIndex = 0;
  let restartCalls = 0;
  let restores = 0;
  let commits = 0;

  const run = async (file, args) => {
    commands.push({ file, args });
    if (file === '/usr/bin/systemctl' && args[0] === '--version') return { stdout: 'systemd 255\n' };
    if (file === '/usr/bin/systemctl' && args[0] === 'restart') {
      restartCalls += 1;
      if (failAllRestarts || (failFirstRestart && restartCalls === 1)) {
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
    waitForHealth: async () => healthResults[Math.min(healthIndex++, healthResults.length - 1)],
    writeEnvironment: async (input) => {
      environments.push(input);
      return {
        restore: async () => { restores += 1; },
        commit: () => { commits += 1; },
      };
    },
  });
  return {
    manager,
    commands,
    environments,
    counts: {
      get restores() { return restores; },
      get commits() { return commits; },
    },
  };
}

test('healthy Node restart materializes and commits desired environment', async () => {
  const harness = createHarness();
  const result = await harness.manager.restartNode({
    ...restartSpec(),
    environment: { API_TOKEN: 'secret-value' },
  });

  assert.equal(result.releaseId, RELEASE_ID);
  assert.equal(result.port, 3100);
  assert.equal(result.healthPath, '/health');
  assert.equal(result.healthy, true);
  assert.equal(result.restarted, true);
  assert.ok(result.serviceName.startsWith('yunpanel-node-'));
  assert.equal(harness.environments.length, 1);
  assert.deepEqual(harness.environments[0].environment, { API_TOKEN: 'secret-value' });
  assert.equal(harness.counts.restores, 0);
  assert.equal(harness.counts.commits, 1);
  assert.equal(harness.commands.filter((entry) => entry.args[0] === 'restart').length, 1);
});

test('Node restart rejects release drift before touching environment or systemd', async () => {
  const harness = createHarness({ currentRelease: OTHER_RELEASE });

  await assert.rejects(
    harness.manager.restartNode(restartSpec()),
    (error) => error instanceof NodeRestartError && error.code === 'node_restart_release_drift',
  );
  assert.equal(harness.environments.length, 0);
  assert.equal(harness.commands.length, 0);
});

test('failed health check restores previous environment and service before reporting failure', async () => {
  const harness = createHarness({ healthResults: [false, true] });

  await assert.rejects(
    harness.manager.restartNode(restartSpec()),
    (error) => error instanceof NodeRestartError && error.code === 'node_restart_health_failed',
  );
  assert.equal(harness.environments.length, 1);
  assert.equal(harness.counts.restores, 1);
  assert.equal(harness.counts.commits, 0);
  assert.equal(harness.commands.filter((entry) => entry.args[0] === 'restart').length, 2);
});

test('systemd command failure restores previous environment and restarts service', async () => {
  const harness = createHarness({ failFirstRestart: true, healthResults: [true] });

  await assert.rejects(
    harness.manager.restartNode(restartSpec()),
    (error) => error instanceof NodeRestartError && error.code === 'node_restart_command_failed',
  );
  assert.equal(harness.counts.restores, 1);
  assert.equal(harness.commands.filter((entry) => entry.args[0] === 'restart').length, 2);
});

test('reports restore failure if previous environment cannot recover a healthy service', async () => {
  const harness = createHarness({ healthResults: [false, false] });

  await assert.rejects(
    harness.manager.restartNode(restartSpec()),
    (error) => error instanceof NodeRestartError && error.code === 'node_restart_restore_failed',
  );
  assert.equal(harness.counts.restores, 1);
  assert.equal(harness.commands.filter((entry) => entry.args[0] === 'restart').length, 2);
});
