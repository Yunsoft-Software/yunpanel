import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  createNodePassengerMigrationPreview,
  NodePassengerMigrationPreviewError,
} from '../src/node-passenger-migration-preview.js';

const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const releaseId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const currentRoot = `/var/lib/yunpanel/apps/${applicationId}/current`;
const environmentPath = `/etc/yunpanel/apps/${applicationId}.env`;
const environmentContent = 'NODE_ENV="production"\nYUNPANEL_APPLICATION_ID="6dcb8908-3f3e-43da-9452-15fd6b51ac76"\nSECRET_VALUE="not-returned"\n';

function spec(overrides = {}) {
  const runtime = {
    nodeMajor: 24,
    packageManager: 'npm',
    installMode: 'ci',
    buildScript: null,
    mode: 'production',
    documentRoot: '.',
    start: { mode: 'node', entryFile: 'server.js', script: null },
    port: 3123,
    healthPath: '/health',
    healthTimeoutSeconds: 30,
    restartPolicy: 'on-failure',
    ...(overrides.runtime ?? {}),
  };
  return {
    applicationId,
    releaseId,
    runtime,
    ...overrides,
  };
}

function healthySource(overrides = {}) {
  return {
    releaseId,
    serviceName: 'yunpanel-node-test.service',
    port: 3123,
    healthPath: '/health',
    loadState: 'loaded',
    activeState: 'active',
    subState: 'running',
    restartCount: 0,
    mainPid: 1234,
    healthy: true,
    inspectionError: false,
    ...overrides,
  };
}

function manager({
  source = healthySource(),
  target = { satisfied: true, releaseId },
  readFileFn = async (file, encoding) => {
    assert.equal(file, environmentPath);
    assert.equal(encoding, 'utf8');
    return environmentContent;
  },
  environmentBindingInspector = async () => ({ satisfied: true, reason: null }),
  passengerInspect = null,
} = {}) {
  return createNodePassengerMigrationPreview({
    statusInspector: { inspectNodeStatus: async () => source },
    passengerSiteManager: {
      inspect: passengerInspect ?? (async () => target),
    },
    readFileFn,
    environmentBindingInspector,
  });
}

test('Node Passenger migration preview proves release, health, environment and target without mutation', async () => {
  let targetIntent;
  let bindingInput;
  const previewer = createNodePassengerMigrationPreview({
    statusInspector: { inspectNodeStatus: async () => healthySource() },
    passengerSiteManager: {
      inspect: async (intent) => {
        targetIntent = intent;
        return { satisfied: true, releaseId };
      },
    },
    readFileFn: async () => environmentContent,
    environmentBindingInspector: async (input) => {
      bindingInput = input;
      return { satisfied: true };
    },
  });

  const result = await previewer.preview(spec());
  assert.equal(result.mode, 'read-only');
  assert.equal(result.mutationPerformed, false);
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.preservation, { release: true, health: true, environment: true });
  assert.equal(result.source.adapter, 'systemd');
  assert.equal(result.target.adapter, 'passenger');
  assert.equal(result.environment.path, environmentPath);
  assert.equal(result.environment.present, true);
  assert.equal(result.environment.sha256, createHash('sha256').update(environmentContent).digest('hex'));
  assert.equal(JSON.stringify(result).includes('not-returned'), false);
  assert.equal(bindingInput.environmentPath, environmentPath);
  assert.equal(bindingInput.environmentSha256, result.environment.sha256);
  assert.equal(targetIntent.appRoot, currentRoot);
  assert.equal(targetIntent.documentRoot, currentRoot);
  assert.equal(targetIntent.startupFile, 'server.js');
  assert.equal(targetIntent.nodeCandidates[0], '/opt/yunpanel/node-runtimes/v24/bin/node');
  assert.match(targetIntent.unixUser, /^yunapp-[a-f0-9]{12}$/);
});

test('Node Passenger migration preview blocks when Passenger environment binding is not proven', async () => {
  const previewer = manager({
    environmentBindingInspector: async () => ({
      satisfied: false,
      reason: 'passenger_environment_binding_unavailable',
    }),
  });

  const result = await previewer.preview(spec());
  assert.equal(result.ready, false);
  assert.deepEqual(result.preservation, { release: true, health: true, environment: false });
  assert.deepEqual(result.blockers, [{
    code: 'passenger_environment_unready',
    detail: 'passenger_environment_binding_unavailable',
  }]);
});

test('Node Passenger migration preview keeps an unhealthy systemd source blocked', async () => {
  const previewer = manager({ source: healthySource({ healthy: false }) });
  const result = await previewer.preview(spec());
  assert.equal(result.ready, false);
  assert.equal(result.preservation.health, false);
  assert.ok(result.blockers.some((entry) => entry.code === 'systemd_source_unhealthy' && entry.detail === 'health_check_failed'));
});

test('Node Passenger migration preview rejects npm start mode without probing a fake Passenger target', async () => {
  let passengerCalls = 0;
  const previewer = manager({
    passengerInspect: async () => {
      passengerCalls += 1;
      return { satisfied: true };
    },
  });
  const input = spec({
    runtime: {
      start: { mode: 'npm', entryFile: null, script: 'start' },
    },
  });

  const result = await previewer.preview(input);
  assert.equal(result.ready, false);
  assert.equal(result.target.intent, null);
  assert.equal(passengerCalls, 0);
  assert.ok(result.blockers.some((entry) => entry.code === 'passenger_start_mode_unsupported'));
});

test('Node Passenger migration preview treats a missing source environment as a blocker', async () => {
  const error = new Error('missing');
  error.code = 'ENOENT';
  const previewer = manager({ readFileFn: async () => { throw error; } });
  const result = await previewer.preview(spec());
  assert.equal(result.ready, false);
  assert.deepEqual(result.environment, {
    path: environmentPath,
    present: false,
    bytes: 0,
    sha256: null,
  });
  assert.ok(result.blockers.some((entry) => entry.code === 'systemd_environment_missing'));
});

test('Node Passenger migration preview fails closed when environment evidence cannot be read', async () => {
  const previewer = manager({
    readFileFn: async () => {
      const error = new Error('denied');
      error.code = 'EACCES';
      throw error;
    },
  });
  await assert.rejects(
    previewer.preview(spec()),
    (error) => error instanceof NodePassengerMigrationPreviewError
      && error.code === 'node_passenger_migration_environment_inspection_failed',
  );
});
