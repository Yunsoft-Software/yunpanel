import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNodeStatusInspector,
  NodeStatusError,
  parseNodeServiceProperties,
} from '../src/node-status-inspector.js';

const APPLICATION_ID = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const RELEASE_ID = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
const OTHER_RELEASE = 'ff830043-9752-4640-83b4-3a1998de78a0';

function statusSpec() {
  return {
    applicationId: APPLICATION_ID,
    releaseId: RELEASE_ID,
    runtime: {
      nodeMajor: 24,
      installMode: 'ci',
      buildScript: 'build',
      start: { mode: 'node', entryFile: 'dist/server.js', script: null },
      port: 3100,
      healthPath: '/health',
      healthTimeoutSeconds: 10,
      restartPolicy: 'on-failure',
    },
  };
}

test('parses bounded systemd process properties', () => {
  assert.deepEqual(parseNodeServiceProperties([
    'LoadState=loaded',
    'ActiveState=active',
    'SubState=running',
    'NRestarts=3',
    'MainPID=12345',
  ].join('\n')), {
    loadState: 'loaded',
    activeState: 'active',
    subState: 'running',
    restartCount: 3,
    mainPid: 12345,
  });
});

test('inspects only the deterministic managed Node service and health endpoint', async () => {
  const commands = [];
  const inspector = createNodeStatusInspector({
    appRoot: '/apps',
    systemctlPaths: ['/usr/bin/systemctl'],
    readlinkFn: async () => `releases/${RELEASE_ID}`,
    run: async (file, args) => {
      commands.push({ file, args });
      if (args[0] === '--version') return { stdout: 'systemd 255\n' };
      if (args[0] === 'show') {
        return {
          stdout: 'LoadState=loaded\nActiveState=active\nSubState=running\nNRestarts=2\nMainPID=4321\n',
        };
      }
      throw new Error('unexpected command');
    },
    healthCheck: async ({ port, healthPath }) => port === 3100 && healthPath === '/health',
  });

  const result = await inspector.inspectNodeStatus(statusSpec());
  assert.equal(result.releaseId, RELEASE_ID);
  assert.equal(result.activeState, 'active');
  assert.equal(result.subState, 'running');
  assert.equal(result.restartCount, 2);
  assert.equal(result.mainPid, 4321);
  assert.equal(result.healthy, true);
  assert.equal(result.inspectionError, false);
  assert.ok(result.serviceName.startsWith('yunpanel-node-'));
  assert.equal(commands.filter((entry) => entry.args[0] === 'show').length, 1);
});

test('inactive services return unhealthy state without probing the application port', async () => {
  let healthCalls = 0;
  const inspector = createNodeStatusInspector({
    appRoot: '/apps',
    systemctlPaths: ['/usr/bin/systemctl'],
    readlinkFn: async () => `releases/${RELEASE_ID}`,
    run: async (file, args) => {
      if (args[0] === '--version') return { stdout: 'systemd 255\n' };
      return { stdout: 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nNRestarts=4\nMainPID=0\n' };
    },
    healthCheck: async () => {
      healthCalls += 1;
      return true;
    },
  });

  const result = await inspector.inspectNodeStatus(statusSpec());
  assert.equal(result.activeState, 'inactive');
  assert.equal(result.healthy, false);
  assert.equal(healthCalls, 0);
});

test('status inspection rejects current-release drift before systemd inspection', async () => {
  let runCalls = 0;
  const inspector = createNodeStatusInspector({
    appRoot: '/apps',
    readlinkFn: async () => `releases/${OTHER_RELEASE}`,
    run: async () => {
      runCalls += 1;
      return { stdout: '' };
    },
  });

  await assert.rejects(
    inspector.inspectNodeStatus(statusSpec()),
    (error) => error instanceof NodeStatusError && error.code === 'node_status_release_drift',
  );
  assert.equal(runCalls, 0);
});
