import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNodePassengerMigrationManager,
  NodePassengerMigrationManagerError,
} from '../src/node-passenger-migration-manager.js';

const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const releaseId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const operationId = '3cf62117-56b3-4db4-98d5-fd7282b2bb0c';
const environmentSha256 = 'a'.repeat(64);
const sourceChecksum = '1'.repeat(64);
const targetChecksum = '2'.repeat(64);

const node = Object.freeze({
  applicationId,
  releaseId,
  runtime: Object.freeze({
    nodeMajor: 24,
    packageManager: 'npm',
    installMode: 'ci',
    buildScript: null,
    mode: 'production',
    documentRoot: '.',
    start: Object.freeze({ mode: 'node', entryFile: 'server.js', script: null }),
    port: 3123,
    healthPath: '/health',
    healthTimeoutSeconds: 30,
    restartPolicy: 'on-failure',
  }),
});

const domain = Object.freeze({
  primaryDomain: 'example.com',
  aliases: Object.freeze(['www.example.com']),
  tls: null,
  canonicalRedirect: false,
  httpsRedirect: true,
  nginxSettings: Object.freeze({
    clientMaxBodySizeMb: 32,
    proxyTimeoutSeconds: 60,
    websocket: true,
    headers: Object.freeze([]),
  }),
});

function preview({ bound = false, sourceHealthy = true, blockers = null } = {}) {
  const effectiveBlockers = blockers ?? (bound ? [] : [{
    code: 'passenger_environment_unready',
    detail: 'passenger_environment_include_missing',
  }]);
  return Object.freeze({
    applicationId,
    releaseId,
    source: Object.freeze({
      adapter: 'systemd',
      serviceName: 'yunpanel-node-test.service',
      releaseId,
      activeState: sourceHealthy ? 'active' : 'inactive',
      subState: sourceHealthy ? 'running' : 'dead',
      healthy: sourceHealthy,
      healthPath: '/health',
      port: 3123,
    }),
    environment: Object.freeze({
      path: `/etc/yunpanel/apps/${applicationId}.env`,
      present: true,
      bytes: 120,
      sha256: environmentSha256,
    }),
    target: Object.freeze({
      adapter: 'passenger',
      intent: Object.freeze({
        adapter: 'passenger',
        applicationId,
        nodeMajor: 24,
        appRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
        documentRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
        startupFile: 'server.js',
        appEnv: 'production',
        unixUser: 'yunapp-0123456789ab',
        healthPath: '/health',
        healthTimeoutSeconds: 30,
        environmentInclude: `/etc/yunpanel/passenger-env/${applicationId}.conf`,
      }),
      inspection: Object.freeze({
        satisfied: true,
        releaseId,
        nodeBinary: '/opt/yunpanel/node-runtimes/v24/bin/node',
      }),
      environmentBinding: Object.freeze({
        satisfied: bound,
        reason: bound ? null : 'passenger_environment_include_missing',
      }),
    }),
    preservation: Object.freeze({
      release: true,
      health: sourceHealthy,
      environment: bound,
    }),
    ready: sourceHealthy && bound && effectiveBlockers.length === 0,
    blockers: Object.freeze(effectiveBlockers),
  });
}

function processState({ active = true, disabled = false } = {}) {
  return {
    releaseId,
    serviceName: 'yunpanel-node-test.service',
    action: 'stop',
    port: 3123,
    healthPath: '/health',
    loadState: 'loaded',
    activeState: active ? 'active' : 'inactive',
    subState: active ? 'running' : 'dead',
    unitFileState: disabled ? 'disabled' : 'enabled',
    mainPid: active ? 1234 : 0,
    enabled: !disabled,
    active,
    healthy: active,
  };
}

function harness({
  initialPreview = preview(),
  boundPreview = preview({ bound: true }),
  rollbackPreview = preview({ bound: true }),
  initialActiveChecksum = sourceChecksum,
  targetHealth = true,
  activationError = null,
  stopError = null,
  disableError = null,
  environmentOwned = true,
} = {}) {
  const events = [];
  let previewCalls = 0;
  let activeChecksum = initialActiveChecksum;
  const previewer = {
    preview: async () => {
      previewCalls += 1;
      events.push(`preview:${previewCalls}`);
      if (previewCalls === 1) return initialPreview;
      if (previewCalls === 2) return boundPreview;
      return rollbackPreview;
    },
  };
  const passengerEnvironment = {
    apply: async (input, options) => {
      events.push('env:apply');
      assert.equal(input.applicationId, applicationId);
      assert.equal(input.expectedSourceSha256, environmentSha256);
      assert.equal(options.operationId, operationId);
      return {
        satisfied: true,
        changed: true,
        ownedByOperation: environmentOwned,
        sourceSha256: environmentSha256,
      };
    },
    compensate: async () => {
      events.push('env:compensate');
      return { satisfied: true };
    },
  };
  const nginx = {
    stageDomain: async (spec) => {
      events.push(`nginx:stage:${spec.targetType}`);
      if (spec.targetType === 'proxy') {
        assert.equal(spec.target.upstreamPort, 3123);
        assert.equal(spec.nginxSettings.proxyTimeoutSeconds, 60);
        return { checksum: sourceChecksum, configName: 'yunpanel-example.com.conf' };
      }
      assert.equal(spec.targetType, 'passenger');
      assert.equal(spec.target.nodeBinary, '/opt/yunpanel/node-runtimes/v24/bin/node');
      assert.equal(spec.target.environmentInclude, `/etc/yunpanel/passenger-env/${applicationId}.conf`);
      assert.deepEqual(spec.nginxSettings, { clientMaxBodySizeMb: 32, headers: [] });
      return { checksum: targetChecksum, configName: 'yunpanel-example.com.conf' };
    },
    inspectActiveDomain: async ({ checksum }) => {
      events.push(`nginx:inspect:${checksum === sourceChecksum ? 'source' : 'target'}`);
      return { satisfied: activeChecksum === checksum, result: null };
    },
    activateDomain: async ({ checksum }) => {
      events.push('nginx:activate');
      assert.equal(checksum, targetChecksum);
      if (activationError) throw Object.assign(new Error('activation failed'), { code: activationError });
      activeChecksum = targetChecksum;
      return { checksum, active: true };
    },
    compensateDomain: async ({ checksum }) => {
      events.push('nginx:compensate');
      assert.equal(checksum, targetChecksum);
      activeChecksum = sourceChecksum;
      return { satisfied: true };
    },
  };
  let currentProcess = processState();
  const nodeProcess = {
    inspectNodeProcess: async () => {
      events.push('systemd:inspect');
      return currentProcess;
    },
    controlNodeProcess: async (input) => {
      events.push(`systemd:${input.action}`);
      if (input.action === 'stop') {
        if (stopError) throw Object.assign(new Error('stop failed'), { code: stopError });
        currentProcess = processState({ active: false, disabled: false });
        return currentProcess;
      }
      if (input.action === 'disable') {
        if (disableError) throw Object.assign(new Error('disable failed'), { code: disableError });
        currentProcess = processState({ active: false, disabled: true });
        return currentProcess;
      }
      throw new Error(`unexpected process action ${input.action}`);
    },
  };
  const waitForTargetHealth = async ({ hostname, healthPath }) => {
    events.push('target:health');
    assert.equal(hostname, 'example.com');
    assert.equal(healthPath, '/health');
    return targetHealth;
  };
  const manager = createNodePassengerMigrationManager({
    previewer,
    passengerEnvironment,
    nginx,
    nodeProcess,
    waitForTargetHealth,
  });
  return {
    manager,
    events,
    setProcessState: (value) => { currentProcess = value; },
  };
}

test('Node Passenger migration keeps systemd alive until Nginx target health succeeds', async () => {
  const h = harness();
  const result = await h.manager.migrate({ operationId, node, domain });
  assert.equal(result.satisfied, true);
  assert.equal(result.state, 'migrated');
  assert.equal(result.resumed, false);
  const healthIndex = h.events.indexOf('target:health');
  const stopIndex = h.events.indexOf('systemd:stop');
  const disableIndex = h.events.indexOf('systemd:disable');
  assert.ok(healthIndex >= 0);
  assert.ok(stopIndex > healthIndex);
  assert.ok(disableIndex > stopIndex);
  assert.ok(h.events.indexOf('env:apply') < h.events.indexOf('nginx:activate'));
  assert.equal(h.events.includes('nginx:compensate'), false);
});

test('Node Passenger migration rolls Nginx back before env compensation when target health fails', async () => {
  const h = harness({ targetHealth: false });
  await assert.rejects(
    h.manager.migrate({ operationId, node, domain }),
    (error) => error instanceof NodePassengerMigrationManagerError
      && error.code === 'node_passenger_migration_target_health_failed',
  );
  assert.ok(h.events.indexOf('nginx:compensate') > h.events.indexOf('target:health'));
  assert.ok(h.events.indexOf('env:compensate') > h.events.indexOf('nginx:compensate'));
  assert.equal(h.events.some((entry) => entry.startsWith('systemd:stop')), false);
  assert.equal(h.events.some((entry) => entry.startsWith('systemd:disable')), false);
});

test('Node Passenger migration preserves unowned env binding during target health rollback', async () => {
  const h = harness({ targetHealth: false, environmentOwned: false });
  await assert.rejects(
    h.manager.migrate({ operationId, node, domain }),
    (error) => error instanceof NodePassengerMigrationManagerError
      && error.code === 'node_passenger_migration_target_health_failed',
  );
  assert.equal(h.events.includes('nginx:compensate'), true);
  assert.equal(h.events.includes('env:compensate'), false);
});

test('Node Passenger migration compensates env after a safely rolled-back Nginx activation failure', async () => {
  const h = harness({ activationError: 'nginx_reload_failed' });
  await assert.rejects(
    h.manager.migrate({ operationId, node, domain }),
    (error) => error instanceof NodePassengerMigrationManagerError
      && error.code === 'node_passenger_migration_nginx_activation_failed',
  );
  assert.equal(h.events.includes('env:compensate'), true);
  assert.equal(h.events.includes('target:health'), false);
  assert.equal(h.events.some((entry) => entry.startsWith('systemd:stop')), false);
});

test('Node Passenger migration preserves env when Nginx rollback state is uncertain', async () => {
  const h = harness({ activationError: 'nginx_rollback_failed' });
  await assert.rejects(
    h.manager.migrate({ operationId, node, domain }),
    (error) => error instanceof NodePassengerMigrationManagerError
      && error.code === 'node_passenger_migration_nginx_state_uncertain',
  );
  assert.equal(h.events.includes('env:compensate'), false);
  assert.equal(h.events.some((entry) => entry.startsWith('systemd:stop')), false);
});

test('Node Passenger migration resumes an already active healthy target and only finishes systemd cleanup', async () => {
  const h = harness({
    initialPreview: preview({ bound: true, sourceHealthy: false, blockers: [{ code: 'systemd_source_unhealthy', detail: 'health_check_failed' }] }),
    initialActiveChecksum: targetChecksum,
  });
  h.setProcessState(processState({ active: false, disabled: false }));
  const result = await h.manager.migrate({ operationId, node, domain });
  assert.equal(result.satisfied, true);
  assert.equal(result.resumed, true);
  assert.equal(h.events.includes('nginx:activate'), false);
  assert.equal(h.events.includes('systemd:stop'), false);
  assert.equal(h.events.includes('systemd:disable'), true);
  assert.ok(h.events.indexOf('systemd:disable') > h.events.indexOf('target:health'));
});

test('Node Passenger migration keeps healthy Passenger traffic when legacy systemd cleanup fails', async () => {
  const h = harness({ stopError: 'node_process_command_failed' });
  const result = await h.manager.migrate({ operationId, node, domain });
  assert.equal(result.satisfied, false);
  assert.equal(result.state, 'passenger_active_cleanup_required');
  assert.equal(result.targetHealthy, true);
  assert.equal(result.cleanup.reason, 'systemd_stop_failed');
  assert.equal(h.events.includes('nginx:compensate'), false);
  assert.equal(h.events.includes('env:compensate'), false);
});

test('Node Passenger migration refuses route drift before environment or process mutation', async () => {
  const h = harness({ initialActiveChecksum: '9'.repeat(64) });
  await assert.rejects(
    h.manager.migrate({ operationId, node, domain }),
    (error) => error instanceof NodePassengerMigrationManagerError
      && error.code === 'node_passenger_migration_source_route_drift',
  );
  assert.equal(h.events.includes('env:apply'), false);
  assert.equal(h.events.includes('nginx:activate'), false);
  assert.equal(h.events.some((entry) => entry.startsWith('systemd:stop')), false);
});

test('Node Passenger migration blocks non-environment preflight failures before mutation', async () => {
  const blocked = preview({
    blockers: [{ code: 'passenger_target_unready', detail: 'passenger_runtime_unavailable' }],
  });
  const h = harness({ initialPreview: blocked });
  await assert.rejects(
    h.manager.migrate({ operationId, node, domain }),
    (error) => error instanceof NodePassengerMigrationManagerError
      && error.code === 'node_passenger_migration_preflight_blocked',
  );
  assert.equal(h.events.includes('env:apply'), false);
  assert.equal(h.events.includes('nginx:activate'), false);
});
