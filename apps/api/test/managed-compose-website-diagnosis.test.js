import assert from 'node:assert/strict';
import test from 'node:test';
import { DockerComposeObserverError } from '@yunpanel/host-runtime';
import {
  createManagedComposeWebsiteDiagnosisService,
  ManagedComposeWebsiteDiagnosisError,
} from '../src/managed-compose-website-diagnosis.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const websiteId = 'db20d91a-ec70-4d79-bc75-1f70de76d1ea';
const projectId = '70b6a777-5fdf-4e64-89e8-14bf2e34953e';

function binding() {
  return { projectId, serviceName: 'web', targetPort: 3000, protocol: 'tcp' };
}

function website(overrides = {}) {
  return {
    id: websiteId,
    serverId,
    runtimeType: 'docker',
    applicationId: null,
    dockerWorkloadId: null,
    managedComposeBinding: binding(),
    proxyTarget: null,
    ...overrides,
  };
}

function project(overrides = {}) {
  return {
    id: projectId,
    serverId,
    projectName: 'shop_app',
    services: [{
      name: 'web',
      publishedPorts: [{ hostIp: '0.0.0.0', publishedPort: 49152, targetPort: 3000, protocol: 'tcp' }],
    }],
    ...overrides,
  };
}

function runtime(overrides = {}) {
  return {
    version: 1,
    projectName: 'shop_app',
    service: 'web',
    status: 'running',
    containerCount: 1,
    containers: [{
      id: 'a'.repeat(64),
      name: 'secret-ish-container-name',
      image: 'private.example/image:latest',
      statusText: 'Up 1 minute',
      runtime: {
        status: 'running', running: true, paused: false, restarting: false,
        oomKilled: false, dead: false, exitCode: 0,
        health: { status: 'healthy', failingStreak: 0 },
      },
    }],
    ...overrides,
  };
}

function service({ websiteValue = website(), projectValue = project(), runtimeValue = runtime(), inspectError = null } = {}) {
  return createManagedComposeWebsiteDiagnosisService({
    websiteRegistry: { async getWebsite(id) { return id === websiteId ? websiteValue : null; } },
    dockerComposeProjectRegistry: { async getProject(id) { return id === projectId ? projectValue : null; } },
    dockerComposeObserver: {
      async inspect(input) {
        assert.deepEqual(input, { projectName: projectValue?.projectName, service: 'web' });
        if (inspectError) throw inspectError;
        return runtimeValue;
      },
    },
    localServerId: serverId,
  });
}

test('healthy managed Compose Website reports ready target and secret-free runtime summary', async () => {
  const result = await service().diagnose(websiteId);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.target, { ready: true, host: '127.0.0.1', port: 49152 });
  assert.deepEqual(result.runtime, {
    status: 'running',
    containerCount: 1,
    unhealthyCount: 0,
    restartingCount: 0,
    oomKilledCount: 0,
    deadCount: 0,
    exitedCount: 0,
    nonZeroExitCount: 0,
    exitCodes: [0],
  });
  assert.deepEqual(result.issues, []);
  assert.equal(JSON.stringify(result).includes('secret-ish-container-name'), false);
  assert.equal(JSON.stringify(result).includes('private.example'), false);
});

test('missing published target and absent service produce independent actionable issues', async () => {
  const result = await service({
    projectValue: project({ services: [{ name: 'web', publishedPorts: [] }] }),
    runtimeValue: runtime({ status: 'absent', containerCount: 0, containers: [] }),
  }).diagnose(websiteId);

  assert.equal(result.status, 'action_required');
  assert.equal(result.target.ready, false);
  assert.deepEqual(result.issues.map((item) => [item.code, item.action]), [
    ['nginx_target_not_published', 'publish_selected_target_port'],
    ['compose_service_absent', 'start_or_redeploy_service'],
  ]);
});

test('unhealthy restarting OOM service reports bounded runtime evidence and actions', async () => {
  const result = await service({
    runtimeValue: runtime({
      status: 'degraded',
      containerCount: 1,
      containers: [{
        runtime: {
          status: 'exited', running: false, paused: false, restarting: true,
          oomKilled: true, dead: false, exitCode: 137,
          health: { status: 'unhealthy', failingStreak: 4 },
        },
      }],
    }),
  }).diagnose(websiteId);

  assert.equal(result.status, 'action_required');
  assert.equal(result.runtime.oomKilledCount, 1);
  assert.equal(result.runtime.unhealthyCount, 1);
  assert.equal(result.runtime.restartingCount, 1);
  assert.equal(result.runtime.nonZeroExitCount, 1);
  assert.deepEqual(result.runtime.exitCodes, [137]);
  assert.deepEqual(result.issues.map((item) => item.code), [
    'compose_service_oom_killed',
    'compose_service_unhealthy',
    'compose_service_restarting',
    'compose_service_exited',
  ]);
});

test('non-loopback target is diagnosed without hiding healthy runtime state', async () => {
  const result = await service({
    projectValue: project({
      services: [{
        name: 'web',
        publishedPorts: [{ hostIp: '192.0.2.10', publishedPort: 49152, targetPort: 3000, protocol: 'tcp' }],
      }],
    }),
  }).diagnose(websiteId);

  assert.equal(result.status, 'action_required');
  assert.equal(result.runtime.status, 'running');
  assert.deepEqual(result.issues.map((item) => [item.code, item.action]), [
    ['nginx_target_not_loopback', 'publish_selected_target_port_on_loopback'],
  ]);
});

test('runtime inspection failure becomes a safe action rather than leaking observer details', async () => {
  const result = await service({
    inspectError: new DockerComposeObserverError(
      'docker_compose_inspection_failed',
      'secret=/run/private should never be returned',
      503,
    ),
  }).diagnose(websiteId);

  assert.equal(result.status, 'action_required');
  assert.deepEqual(result.issues, [{
    code: 'compose_runtime_inspection_unavailable',
    severity: 'error',
    action: 'check_docker_service',
    message: 'Compose service runtime state could not be inspected.',
  }]);
  assert.equal(JSON.stringify(result).includes('/run/private'), false);
});

test('starting service reports attention rather than false readiness', async () => {
  const result = await service({
    runtimeValue: runtime({
      status: 'starting',
      containers: [{
        runtime: {
          status: 'running', running: true, paused: false, restarting: false,
          oomKilled: false, dead: false, exitCode: 0,
          health: { status: 'starting', failingStreak: 0 },
        },
      }],
    }),
  }).diagnose(websiteId);
  assert.equal(result.status, 'attention');
  assert.equal(result.issues[0].code, 'compose_service_starting');
});

test('diagnosis rejects a non-managed Website and remote Website identity', async () => {
  await assert.rejects(
    service({ websiteValue: website({ managedComposeBinding: null, runtimeType: 'proxy' }) }).diagnose(websiteId),
    (error) => error instanceof ManagedComposeWebsiteDiagnosisError
      && error.code === 'managed_compose_binding_required'
      && error.status === 409,
  );
  await assert.rejects(
    service({ websiteValue: website({ serverId: 'c8e93a53-6b7b-41bb-a55f-eddb6fe6aa23' }) }).diagnose(websiteId),
    (error) => error instanceof ManagedComposeWebsiteDiagnosisError
      && error.code === 'website_not_found'
      && error.status === 404,
  );
});
