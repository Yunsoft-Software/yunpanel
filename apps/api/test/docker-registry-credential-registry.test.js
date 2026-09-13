import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDockerRegistryCredentialRegistry,
  DockerRegistryCredentialRegistryError,
} from '../src/docker-registry-credential-registry.js';

const projectId = '0bb78242-03a6-429f-9d17-7725c521437c';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-registry-credential-'));
  const filePath = path.join(root, 'registry.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = createDockerRegistryCredentialRegistry({
    filePath,
    masterKey: randomBytes(32),
    projectExists: async (id) => id === projectId,
    now: () => Date.parse('2026-09-13T06:00:00.000Z'),
  });
  await registry.init();
  return { filePath, registry };
}

test('registry credential public state excludes username and credential material', async (t) => {
  const { filePath, registry } = await fixture(t);
  const saved = await registry.setCredential(projectId, {
    registryHost: 'INDEX.DOCKER.IO',
    expectedRevision: 0,
    username: 'yunpanel-user',
    secret: 'opaque-value',
  });
  assert.equal(saved.registryHost, 'docker.io');
  assert.equal(saved.revision, 1);
  assert.equal(saved.configured, true);
  assert.equal(Object.hasOwn(saved, 'username'), false);
  const persisted = await readFile(filePath, 'utf8');
  assert.doesNotMatch(persisted, /yunpanel-user|opaque-value/);
  const materialized = await registry.materializeCredential(projectId, 'docker.io', { expectedRevision: 1 });
  assert.equal(materialized.username, 'yunpanel-user');
  assert.equal(materialized.secret, 'opaque-value');
});

test('registry credential updates reject stale revisions and URL-shaped registry hosts', async (t) => {
  const { registry } = await fixture(t);
  await registry.setCredential(projectId, {
    registryHost: 'ghcr.io', expectedRevision: 0, username: 'user', secret: 'value-1',
  });
  await assert.rejects(
    registry.setCredential(projectId, {
      registryHost: 'ghcr.io', expectedRevision: 0, username: 'user', secret: 'value-2',
    }),
    (error) => error instanceof DockerRegistryCredentialRegistryError && error.code === 'docker_registry_credential_revision_conflict',
  );
  await assert.rejects(
    registry.getCredential(projectId, 'https://ghcr.io/path'),
    (error) => error instanceof DockerRegistryCredentialRegistryError && error.code === 'docker_registry_host_invalid',
  );
});
