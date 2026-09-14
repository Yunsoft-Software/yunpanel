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
const environmentInclude = `/etc/yunpanel/passenger-env/${applicationId}.conf`;
const environmentContent = [
  'NODE_ENV="production"',
  'HOST="127.0.0.1"',
  'PORT="3123"',
  `YUNPANEL_APPLICATION_ID="${applicationId}"`,
  'SECRET_VALUE="not-returned"',
  '',
].join('\n');

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

function healthyBinding(overrides = {}) {
  return {
    satisfied: true,
    sourcePath: environmentPath,
    sourceSha256: createHash('sha256').update(environmentContent).digest('hex'),
    environmentInclude,
    includeSha256: 'b'.repeat(64),
    includeBytes: 123,
    variableCount: 4,
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
  passengerEnvironmentInspect = async () => healthyBinding(),
  passengerInspect = null,
} = {}) {
  return createNodePassengerMigrationPreview({
    statusInspector: { inspectNodeStatus: async () => source },
    passengerSiteManager: {
      inspect: passengerInspect ?? (async () => target),
    },
    passengerEnvironment: { inspect: passengerEnvironmentInspect },
    readFileFn,
  });
}

test('Node Passenger migration preview proves exact env binding and target without mutation', async () => {
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
    passengerEnvironment: {
      inspect: async (input) => {
        bindingInput = input;
        return healthyBinding();
      },
    },
    readFileFn: async () => environmentContent,
  });

  const input = spec();
  const result = await previewer.preview(input);
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
  assert.deepEqual(bindingInput, {
    applicationId,
    runtime: input.runtime,
    expectedSourceSha256: result.environment.sha256,
  });
  assert.equal(result.target.environmentBinding.sourcePath, environmentPath);
  assert.equal(result.target.environmentBinding.environmentInclude, environmentInclude);
  assert.equal(targetIntent.appRoot, currentRoot);
  assert.equal(targetIntent.documentRoot, currentRoot);
  assert.equal(targetIntent.startupFile, 'server.js');
  assert.equal(targetIntent.nodeCandidates[0], '/opt/yunpanel/node-runtimes/v24/bin/node');
  assert.equal(targetIntent.environmentInclude, environmentInclude);
  assert.match(targetIntent.unixUser, /^yunapp-[a-f0-9]{12}$/);
});

test('Node Passenger migration preview blocks when durable env include is not ready', async () => {
  const previewer = manager({
    passengerEnvironmentInspect: async () => ({
      satisfied: false,
      reason: 'passenger_environment_include_missing',
      sourcePath: environmentPath,
      environmentInclude,
    }),
  });

  const result = await previewer.preview(spec());
  assert.equal(result.ready, false);
  assert.deepEqual(result.preservation, { release: true, health: true, environment: false });
  assert.deepEqual(result.blockers, [{
    code: 'passenger_environment_unready',
    detail: 'passenger_environment_include_missing',
  }]);
});

test('Node Passenger migration preview rejects a satisfied env binding from another source path', async () => {
  const previewer = manager({
    passengerEnvironmentInspect: async () => healthyBinding({ sourcePath: `/etc/yunpanel/apps/other.env` }),
  });
  const result = await previewer.preview(spec());
  assert.equal(result.ready, false);
  assert.equal(result.preservation.environment, false);
  assert.ok(result.blockers.some((entry) => entry.code === 'passenger_environment_source_mismatch'));
});

test('Node Passenger migration preview rejects a satisfied env binding targeting another include', async () => {
  const previewer = manager({
    passengerEnvironmentInspect: async () => healthyBinding({
      environmentInclude: `/etc/yunpanel/passenger-env/11111111-1111-4111-8111-111111111111.conf`,
    }),
  });
  const result = await previewer.preview(spec());
  assert.equal(result.ready, false);
  assert.equal(result.preservation.environment, false);
  assert.ok(result.blockers.some((entry) => entry.code === 'passenger_environment_include_mismatch'));
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
  assert.ok(result.blockers.some((entry) => entry.code === 'passenger_environment_include_mismatch'));
});

test('Node Passenger migration preview treats a missing source environment as a blocker without inspecting Passenger env binding', async () => {
  const error = new Error('missing');
  error.code = 'ENOENT';
  let bindingCalls = 0;
  const previewer = manager({
    readFileFn: async () => { throw error; },
    passengerEnvironmentInspect: async () => {
      bindingCalls += 1;
      return healthyBinding();
    },
  });
  const result = await previewer.preview(spec());
  assert.equal(result.ready, false);
  assert.equal(bindingCalls, 0);
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
