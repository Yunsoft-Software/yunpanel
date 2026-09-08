import assert from 'node:assert/strict';
import test from 'node:test';
import { createNodeRollbackManager, NodeRollbackError } from '../src/node-rollback-manager.js';

const APPLICATION_ID = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const TARGET_RELEASE = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
const CURRENT_RELEASE = 'ff830043-9752-4640-83b4-3a1998de78a0';

function rollbackSpec() {
  return {
    applicationId: APPLICATION_ID,
    releaseId: TARGET_RELEASE,
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

function createHarness({ healthResults = [true], failFirstRestart = false } = {}) {
  const commands = [];
  const links = [];
  const environments = [];
  let healthIndex = 0;
  let restartCalls = 0;

  const run = async (file, args) => {
    commands.push({ file, args });
    if (file === '/usr/bin/systemctl' && args[0] === '--version') return { stdout: 'systemd 255\n' };
    if (file === '/usr/bin/systemctl' && args[0] === 'restart') {
      restartCalls += 1;
      if (failFirstRestart && restartCalls === 1) {
        const error = new Error('restart failed');
        error.code = 1;
        throw error;
      }
      return { stdout: '' };
    }
    throw new Error('unexpected command');
  };

  const manager = createNodeRollbackManager({
    appRoot: '/apps',
    run,
    systemctlPaths: ['/usr/bin/systemctl'],
    lstatFn: async () => ({
      isDirectory: () => true,
      isSymbolicLink: () => false,
    }),
    readlinkFn: async () => `releases/${CURRENT_RELEASE}`,
    renameFn: async () => {},
    rmFn: async () => {},
    symlinkFn: async (target, linkPath) => links.push({ target, linkPath }),
    waitForHealth: async () => healthResults[Math.min(healthIndex++, healthResults.length - 1)],
    writeEnvironment: async (input) => environments.push(input),
  });

  return { manager, commands, links, environments };
}

test('healthy Node rollback materializes desired environment before activating the retained release', async () => {
  const harness = createHarness({ healthResults: [true] });
  const result = await harness.manager.rollbackNode({
    ...rollbackSpec(),
    environment: { API_TOKEN: 'secret-value' },
  });

  assert.equal(result.releaseId, TARGET_RELEASE);
  assert.equal(result.previousReleaseId, CURRENT_RELEASE);
  assert.equal(result.port, 3100);
  assert.equal(result.healthPath, '/health');
  assert.equal(result.healthy, true);
  assert.equal(result.active, true);
  assert.ok(result.serviceName.startsWith('yunpanel-node-'));
  assert.equal(harness.environments.length, 1);
  assert.deepEqual(harness.environments[0].environment, { API_TOKEN: 'secret-value' });
  assert.ok(harness.links.some((entry) => entry.target === `releases/${TARGET_RELEASE}`));
  assert.equal(harness.commands.filter((entry) => entry.args[0] === 'restart').length, 1);
});

test('unhealthy rollback restores the previously active release before reporting failure', async () => {
  const harness = createHarness({ healthResults: [false, true] });

  await assert.rejects(
    harness.manager.rollbackNode(rollbackSpec()),
    (error) => error instanceof NodeRollbackError && error.code === 'node_rollback_health_failed',
  );

  assert.equal(harness.environments.length, 1);
  assert.ok(harness.links.some((entry) => entry.target === `releases/${TARGET_RELEASE}`));
  assert.ok(harness.links.some((entry) => entry.target === `releases/${CURRENT_RELEASE}`));
  assert.equal(harness.commands.filter((entry) => entry.args[0] === 'restart').length, 2);
});

test('failed service restart restores the previous release', async () => {
  const harness = createHarness({ healthResults: [true], failFirstRestart: true });

  await assert.rejects(
    harness.manager.rollbackNode(rollbackSpec()),
    (error) => error instanceof NodeRollbackError && error.code === 'node_rollback_command_failed',
  );

  assert.equal(harness.environments.length, 1);
  assert.ok(harness.links.some((entry) => entry.target === `releases/${CURRENT_RELEASE}`));
  assert.equal(harness.commands.filter((entry) => entry.args[0] === 'restart').length, 2);
});

test('reports restore failure if both target and previous releases are unhealthy', async () => {
  const harness = createHarness({ healthResults: [false, false] });

  await assert.rejects(
    harness.manager.rollbackNode(rollbackSpec()),
    (error) => error instanceof NodeRollbackError && error.code === 'node_rollback_restore_failed',
  );
  assert.equal(harness.environments.length, 1);
});
