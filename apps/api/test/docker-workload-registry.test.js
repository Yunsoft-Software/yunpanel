import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDockerWorkloadRegistry, DockerWorkloadRegistryError } from '../src/docker-workload-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const workloadId = '0bb78242-03a6-429f-9d17-7725c521437c';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-docker-workloads-'));
  const filePath = path.join(root, 'docker-workload-registry.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = createDockerWorkloadRegistry({
    filePath,
    now: () => Date.parse('2026-09-11T12:00:00.000Z'),
    serverExists: async (id) => id === serverId,
  });
  await registry.init();
  return { root, filePath, registry };
}

test('external Docker workload tracking persists a private explicit loopback endpoint', async (t) => {
  const { filePath, registry } = await fixture(t);
  const workload = await registry.createWorkload({
    workloadId,
    serverId,
    name: 'Compose API',
    managementMode: 'external',
    proxyTarget: { host: '[::1]', port: 8080, websocket: true },
  });
  assert.deepEqual(workload.proxyTarget, { host: '::1', port: 8080, websocket: true });
  assert.equal(workload.state, 'unverified');
  assert.equal(workload.revision, 1);
  assert.equal(workload.lastObservedAt, null);
  assert.equal((await stat(filePath)).mode & 0o077, 0);

  const persisted = await readFile(filePath, 'utf8');
  assert.doesNotMatch(persisted, /compose\.ya?ml|environment|secret|token/i);
  const reopened = createDockerWorkloadRegistry({ filePath, serverExists: async (id) => id === serverId });
  await reopened.init();
  assert.deepEqual(await reopened.getWorkload(workloadId), workload);
});

test('Docker workload identity is idempotent internally but endpoint allocation is unique', async (t) => {
  const { registry } = await fixture(t);
  const input = {
    workloadId,
    serverId,
    name: 'Compose API',
    managementMode: 'external',
    proxyTarget: { host: '127.0.0.1', port: 8080, websocket: false },
  };
  const created = await registry.createWorkload(input);
  assert.deepEqual(await registry.createWorkload(input), created);
  await assert.rejects(
    registry.createWorkload({ ...input, workloadId: '294dfeda-c5ba-4e2c-ab4f-e012c5c53880', name: 'Conflict' }),
    (error) => error instanceof DockerWorkloadRegistryError && error.code === 'docker_proxy_endpoint_conflict',
  );
  await assert.rejects(
    registry.createWorkload({ ...input, name: 'Changed' }),
    (error) => error instanceof DockerWorkloadRegistryError && error.code === 'docker_workload_identity_conflict',
  );
});

test('Docker workload tracking rejects remote targets and unsupported managed claims', async (t) => {
  const { registry } = await fixture(t);
  for (const [input, expected] of [
    [{ managementMode: 'managed', proxyTarget: { host: '127.0.0.1', port: 8080, websocket: true } }, 'docker_management_mode_unsupported'],
    [{ managementMode: 'external', proxyTarget: { host: 'example.com', port: 8080, websocket: true } }, 'invalid_docker_proxy_host'],
    [{ managementMode: 'external', proxyTarget: { host: '127.0.0.1', port: 80, websocket: true } }, 'invalid_docker_proxy_port'],
  ]) {
    await assert.rejects(
      registry.createWorkload({ workloadId, serverId, name: 'Unsafe', ...input }),
      (error) => error instanceof DockerWorkloadRegistryError && error.code === expected,
    );
  }
});

test('Docker workload observations are revisioned and degraded state needs safe metadata', async (t) => {
  const { registry } = await fixture(t);
  await registry.createWorkload({
    workloadId, serverId, name: 'Observed', managementMode: 'external',
    proxyTarget: { host: 'localhost', port: 8080, websocket: true },
  });
  const running = await registry.recordObservation(workloadId, { expectedRevision: 1, state: 'running' });
  assert.equal(running.revision, 2);
  assert.equal(running.state, 'running');
  assert.equal(running.lastObservedAt, '2026-09-11T12:00:00.000Z');
  await assert.rejects(
    registry.recordObservation(workloadId, { expectedRevision: 1, state: 'stopped' }),
    (error) => error instanceof DockerWorkloadRegistryError && error.code === 'docker_workload_revision_conflict',
  );
  await assert.rejects(
    registry.recordObservation(workloadId, { expectedRevision: 2, state: 'degraded', errorCode: 'TOKEN=secret' }),
    (error) => error instanceof DockerWorkloadRegistryError && error.code === 'invalid_docker_error_code',
  );
});

test('Docker workload startup fails closed for missing servers and corrupt state', async (t) => {
  const { filePath, registry } = await fixture(t);
  await registry.createWorkload({
    workloadId, serverId, name: 'Persistent', managementMode: 'external',
    proxyTarget: { host: '127.0.0.1', port: 8080, websocket: true },
  });
  await assert.rejects(
    createDockerWorkloadRegistry({ filePath, serverExists: async () => false }).init(),
    (error) => error instanceof DockerWorkloadRegistryError && error.code === 'docker_server_not_found' && error.status === 409,
  );
  const state = JSON.parse(await readFile(filePath, 'utf8'));
  state.workloads[0].proxyTarget.host = 'remote.example';
  await writeFile(filePath, JSON.stringify(state), { mode: 0o600 });
  await assert.rejects(createDockerWorkloadRegistry({ filePath }).init());
});
