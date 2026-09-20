import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDockerComposeProjectRegistry,
  dockerComposeProjectRegistryInternals,
  DockerComposeProjectRegistryError,
} from '../src/docker-compose-project-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const projectId = '0bb78242-03a6-429f-9d17-7725c521437c';
const first = 'services:\n  web:\n    image: nginx:1.27\n';
const second = 'services:\n  web:\n    image: nginx:1.28\n';

function validation(document) {
  return {
    version: 1,
    projectName: 'shop_app',
    composeSha256: createHash('sha256').update(document).digest('hex'),
    composeBytes: Buffer.byteLength(document),
    serviceCount: 1,
    services: [{
      name: 'web',
      imageConfigured: true,
      buildConfigured: false,
      storageMounts: [
        { kind: 'named_volume', source: 'data', sourceScope: 'project', target: '/data', readOnly: false },
        { kind: 'bind', source: './config', sourceScope: 'project', target: '/app/config', readOnly: true },
        { kind: 'bind', source: '/srv/shared', sourceScope: 'host', target: '/shared', readOnly: false },
        { kind: 'ephemeral', source: null, sourceScope: null, target: '/run/cache', readOnly: false },
      ],
    }],
    networks: ['default'],
    volumes: ['data'],
    secretCount: 0,
    configCount: 0,
    validated: true,
    sideEffects: false,
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-compose-project-'));
  const filePath = path.join(root, 'projects.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = createDockerComposeProjectRegistry({
    filePath,
    masterKey: randomBytes(32),
    serverExists: async (id) => id === serverId,
    now: () => Date.parse('2026-09-13T05:00:00.000Z'),
  });
  await registry.init();
  return { filePath, registry };
}

test('compose project persists encrypted desired document and safe storage summary', async (t) => {
  const { filePath, registry } = await fixture(t);
  const project = await registry.createProject({
    projectId, serverId, projectName: 'shop_app', document: first, validation: validation(first),
  });
  assert.equal(project.revision, 1);
  assert.equal(Object.hasOwn(project, 'document'), false);
  assert.deepEqual(project.services[0].storageMounts, [
    { kind: 'bind', source: './config', sourceScope: 'project', target: '/app/config', readOnly: true },
    { kind: 'named_volume', source: 'data', sourceScope: 'project', target: '/data', readOnly: false },
    { kind: 'ephemeral', source: null, sourceScope: null, target: '/run/cache', readOnly: false },
    { kind: 'bind', source: '/srv/shared', sourceScope: 'host', target: '/shared', readOnly: false },
  ]);
  const persisted = await readFile(filePath, 'utf8');
  assert.doesNotMatch(persisted, /nginx:1\.27|services:/i);
  assert.match(persisted, /"storageMounts"/);
  assert.equal((await registry.materializeProject(projectId, { expectedRevision: 1 })).document, first);
});

test('compose project update requires current revision and matching validation digest', async (t) => {
  const { registry } = await fixture(t);
  await registry.createProject({ projectId, serverId, projectName: 'shop_app', document: first, validation: validation(first) });
  const updated = await registry.updateProject(projectId, {
    expectedRevision: 1, document: second, validation: validation(second),
  });
  assert.equal(updated.revision, 2);
  assert.deepEqual(updated.services[0].storageMounts, validation(second).services[0].storageMounts.sort((left, right) => left.target.localeCompare(right.target)));
  await assert.rejects(
    registry.updateProject(projectId, { expectedRevision: 1, document: first, validation: validation(first) }),
    (error) => error instanceof DockerComposeProjectRegistryError && error.code === 'docker_compose_project_revision_conflict',
  );
  await assert.rejects(
    registry.updateProject(projectId, {
      expectedRevision: 2,
      document: first,
      validation: { ...validation(first), composeSha256: 'a'.repeat(64) },
    }),
    (error) => error instanceof DockerComposeProjectRegistryError && error.code === 'docker_compose_validation_invalid',
  );
});

test('legacy service summaries restart with empty published ports and storage mounts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-compose-project-migration-'));
  const filePath = path.join(root, 'projects.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const masterKey = randomBytes(32);
  const timestamp = '2026-09-13T05:00:00.000Z';
  await writeFile(filePath, JSON.stringify({
    version: 1,
    projects: [{
      id: projectId,
      serverId,
      projectName: 'shop_app',
      revision: 1,
      composeSha256: createHash('sha256').update(first).digest('hex'),
      composeBytes: Buffer.byteLength(first),
      services: [{ name: 'web', imageConfigured: true, buildConfigured: false }],
      networks: ['default'],
      volumes: [],
      secretCount: 0,
      configCount: 0,
      encryptedDocument: dockerComposeProjectRegistryInternals.encryptDocument(masterKey, projectId, 1, first),
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
  }, null, 2), { encoding: 'utf8', mode: 0o600 });
  const registry = createDockerComposeProjectRegistry({
    filePath,
    masterKey,
    serverExists: async (id) => id === serverId,
  });
  await registry.init();
  const project = await registry.getProject(projectId);
  assert.deepEqual(project.services[0].publishedPorts, []);
  assert.deepEqual(project.services[0].storageMounts, []);
  const migrated = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(migrated.projects[0].services[0].publishedPorts, []);
  assert.deepEqual(migrated.projects[0].services[0].storageMounts, []);
});

test('compose project registry enforces project scope for all declared networks', async (t) => {
  const { registry } = await fixture(t);
  const valid = {
    ...validation(first),
    networkDetails: [{ name: 'default', scope: 'project' }],
  };
  const project = await registry.createProject({
    projectId, serverId, projectName: 'shop_app', document: first, validation: valid,
  });
  assert.equal(project.projectName, 'shop_app');

  const invalid = {
    ...validation(second),
    networkDetails: [
      { name: 'default', scope: 'project' },
      { name: 'shared_host_net', scope: 'host' },
    ],
  };
  await assert.rejects(
    registry.updateProject(projectId, {
      expectedRevision: 1,
      document: second,
      validation: invalid,
    }),
    (error) => error instanceof DockerComposeProjectRegistryError
      && error.code === 'docker_compose_validation_invalid'
      && error.message.includes('project scope'),
  );
});

