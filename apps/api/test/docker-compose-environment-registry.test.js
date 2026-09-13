import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDockerComposeEnvironmentRegistry,
  DockerComposeEnvironmentRegistryError,
} from '../src/docker-compose-environment-registry.js';

const projectId = '0bb78242-03a6-429f-9d17-7725c521437c';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-compose-env-'));
  const filePath = path.join(root, 'environment.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = createDockerComposeEnvironmentRegistry({
    filePath,
    masterKey: randomBytes(32),
    projectExists: async (id) => id === projectId,
    now: () => Date.parse('2026-09-13T05:30:00.000Z'),
  });
  await registry.init();
  return { filePath, registry };
}

test('compose environment stores values privately and exposes only keys and revision', async (t) => {
  const { filePath, registry } = await fixture(t);
  assert.deepEqual(await registry.getEnvironment(projectId), {
    projectId,
    revision: 0,
    keys: [],
    variableCount: 0,
    configured: false,
    updatedAt: null,
  });
  const saved = await registry.replaceEnvironment(projectId, {
    expectedRevision: 0,
    variables: { API_TOKEN: 'alpha-value', NODE_ENV: 'production' },
  });
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.keys, ['API_TOKEN', 'NODE_ENV']);
  const persisted = await readFile(filePath, 'utf8');
  assert.doesNotMatch(persisted, /alpha-value|production/);
  const materialized = await registry.materializeEnvironment(projectId, { expectedRevision: 1 });
  assert.deepEqual(materialized.variables, { API_TOKEN: 'alpha-value', NODE_ENV: 'production' });
});

test('compose environment rejects stale revisions and invalid keys before mutation', async (t) => {
  const { registry } = await fixture(t);
  await registry.replaceEnvironment(projectId, { expectedRevision: 0, variables: { A: '1' } });
  await assert.rejects(
    registry.replaceEnvironment(projectId, { expectedRevision: 0, variables: { A: '2' } }),
    (error) => error instanceof DockerComposeEnvironmentRegistryError && error.code === 'docker_compose_environment_revision_conflict',
  );
  await assert.rejects(
    registry.replaceEnvironment(projectId, { expectedRevision: 1, variables: { 'BAD-KEY': '2' } }),
    (error) => error instanceof DockerComposeEnvironmentRegistryError && error.code === 'docker_compose_environment_invalid',
  );
  assert.equal((await registry.getEnvironment(projectId)).revision, 1);
});
