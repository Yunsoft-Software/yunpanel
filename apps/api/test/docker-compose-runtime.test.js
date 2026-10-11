import assert from 'node:assert/strict';
import test from 'node:test';
import { DOCKER_COMPOSE_OPERATIONS, OPERATIONS } from '@yunpanel/protocol';
import {
  createDockerComposeProjectRegistryBootstrap,
  dockerComposeRuntimeInternals,
} from '../src/docker-compose-runtime.js';

const projectId = '0bb78242-03a6-429f-9d17-7725c521437c';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';

function fixture({ allowed = true } = {}) {
  const calls = [];
  const baseOperations = {
    authorizeExecution: async (operation, execution) => { calls.push(['authorize', operation]); if (!allowed) throw Object.assign(new Error('Actor revoked'), {code:'panel_job_actor_forbidden'}); return Object.fromEntries(Object.entries(execution).filter(([key])=>key!=='authorization')); },
    operations: [OPERATIONS.SERVER_INSPECT],
    supports(operation) {
      return operation === OPERATIONS.SERVER_INSPECT;
    },
    async executeOperation(operation, payload, execution) {
      calls.push(['base', operation, payload, execution]);
      return { source: 'base', operation };
    },
  };
  const localOperation = {
    async execute(operation, payload, execution) {
      calls.push(['compose', operation, payload, execution]);
      return { source: 'compose', operation };
    },
  };
  return {
    calls,
    extended: dockerComposeRuntimeInternals.extendLocalOperations(baseOperations, localOperation),
  };
}

test('compose project registry bootstrap exposes the shared configured store identity', () => {
  const projectStore = '/tmp/yunpanel-compose-projects.json';
  const bootstrap = createDockerComposeProjectRegistryBootstrap({
    env: {
      YUNPANEL_DOCKER_COMPOSE_PROJECT_STORE: projectStore,
      YUNPANEL_SECRET_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    },
    serverRegistry: { async getServer() { return { id: serverId }; } },
  });

  assert.equal(bootstrap.paths.projects, projectStore);
  assert.equal(typeof bootstrap.projectRegistry.init, 'function');
  assert.equal(typeof bootstrap.projectRegistry.getProject, 'function');
  assert.equal(typeof bootstrap.projectRegistry.materializeProject, 'function');
});

test('compose state defaults beside the configured server registry instead of the package directory', () => {
  const bootstrap = createDockerComposeProjectRegistryBootstrap({
    env: {
      YUNPANEL_SERVER_STORE: '/var/lib/yunpanel/control-plane/server-registry.json',
      YUNPANEL_SECRET_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    },
    serverRegistry: { async getServer() { return { id: serverId }; } },
  });

  assert.deepEqual(bootstrap.paths, {
    projects: '/var/lib/yunpanel/control-plane/docker-compose-project-registry.json',
    environments: '/var/lib/yunpanel/control-plane/docker-compose-environment-registry.json',
    credentials: '/var/lib/yunpanel/control-plane/docker-registry-credential-registry.json',
  });
});

test('compose runtime extends rather than replaces existing local operations', async () => {
  const fx = fixture();
  assert.equal(fx.extended.supports(OPERATIONS.SERVER_INSPECT), true);
  for (const operation of DOCKER_COMPOSE_OPERATIONS) {
    assert.equal(fx.extended.supports(operation), true);
    assert.ok(fx.extended.operations.includes(operation));
  }
  assert.ok(fx.extended.operations.includes(OPERATIONS.SERVER_INSPECT));

  const execution = {
    jobId: 'docker-compose-job-0001',
    serverId,
    resourceType: 'docker_project',
    resourceId: projectId,
    authorization: { kind:'panel', actorId:'native-user', userId:'native-user', sessionId:'native-session', role:'owner', scope:'server', serverId },
  };
  const payload = { projectId };
  const result = await fx.extended.executeOperation(OPERATIONS.DOCKER_COMPOSE_START, payload, execution);
  assert.deepEqual(result, { source: 'compose', operation: OPERATIONS.DOCKER_COMPOSE_START });
  const forwarded = fx.calls.at(-1);
  assert.deepEqual(forwarded.slice(0, 3), ['compose', OPERATIONS.DOCKER_COMPOSE_START, payload]);
  const { authorize, ...publicExecution } = forwarded[3];
  assert.deepEqual(publicExecution, Object.fromEntries(Object.entries(execution).filter(([key]) => key !== 'authorization')));
  assert.equal(typeof authorize, 'function');
  await authorize();
  assert.deepEqual(fx.calls.at(-1), ['authorize', OPERATIONS.DOCKER_COMPOSE_START]);
});

test('non-compose operations remain delegated to the original local host runtime', async () => {
  const fx = fixture();
  const payload = { existing: true };
  const execution = { jobId: 'existing-operation-job' };
  const result = await fx.extended.executeOperation(OPERATIONS.SERVER_INSPECT, payload, execution);
  assert.deepEqual(result, { source: 'base', operation: OPERATIONS.SERVER_INSPECT });
  assert.deepEqual(fx.calls, [['base', OPERATIONS.SERVER_INSPECT, payload, execution]]);
});


test('revoked Docker authorization fails before materialization or host execution', async () => {
 const fx=fixture({allowed:false});await assert.rejects(fx.extended.executeOperation(OPERATIONS.DOCKER_COMPOSE_START,{projectId},{jobId:'native-job',serverId,resourceType:'docker_project',resourceId:projectId,authorization:{kind:'panel'}}),e=>e.code==='panel_job_actor_forbidden');
 assert.deepEqual(fx.calls,[['authorize',OPERATIONS.DOCKER_COMPOSE_START]]);
});
test('legacy Docker jobs without private live authorization cannot reach the native engine', async () => {
 const fx=fixture();await assert.rejects(fx.extended.executeOperation(OPERATIONS.DOCKER_COMPOSE_START,{projectId},{jobId:'legacy-job',serverId,resourceType:'docker_project',resourceId:projectId}),e=>e.code==='docker_compose_job_authorization_required');assert.deepEqual(fx.calls,[]);
});
