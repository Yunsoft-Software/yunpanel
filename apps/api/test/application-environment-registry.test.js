import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ApplicationEnvironmentRegistryError,
  createApplicationEnvironmentRegistry,
} from '../src/application-environment-registry.js';

const APPLICATION_ID = '9d4a4727-1aba-4d35-95fe-21db67042ce9';

function createRegistry(options = {}) {
  return createApplicationEnvironmentRegistry({
    masterKey: Buffer.alloc(32, 7),
    applicationExists: async (applicationId) => applicationId === APPLICATION_ID,
    ...options,
  });
}

test('stores secret values encrypted and never exposes them in list metadata', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-env-'));
  const filePath = path.join(directory, 'environment.json');
  try {
    const registry = createRegistry({ filePath });
    await registry.setVariable({ applicationId: APPLICATION_ID, key: 'API_URL', value: 'https://example.test', secret: false });
    await registry.setVariable({ applicationId: APPLICATION_ID, key: 'API_TOKEN', value: 'super-secret-token', secret: true });

    const listed = await registry.listVariables(APPLICATION_ID);
    assert.equal(listed.length, 2);
    assert.equal(listed.find((entry) => entry.key === 'API_URL').value, 'https://example.test');
    const secret = listed.find((entry) => entry.key === 'API_TOKEN');
    assert.equal(secret.secret, true);
    assert.equal(JSON.stringify(secret).includes('super-secret-token'), false);

    const materialized = await registry.materialize(APPLICATION_ID);
    assert.deepEqual(materialized, {
      API_URL: 'https://example.test',
      API_TOKEN: 'super-secret-token',
    });

    const persisted = await readFile(filePath, 'utf8');
    assert.equal(persisted.includes('super-secret-token'), false);
    assert.match(persisted, /"ciphertext"/);
    assert.match(persisted, /"tag"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('secret writes fail closed when no master key is configured', async () => {
  const registry = createApplicationEnvironmentRegistry({
    masterKey: null,
    applicationExists: async () => true,
  });

  await assert.rejects(
    registry.setVariable({ applicationId: APPLICATION_ID, key: 'API_TOKEN', value: 'secret', secret: true }),
    (error) => error instanceof ApplicationEnvironmentRegistryError && error.code === 'secret_store_unavailable',
  );
  await assert.rejects(
    registry.setDeploymentCredential({
      applicationId: APPLICATION_ID,
      credential: { type: 'github_token', token: 'github_pat_private_missing_key' },
    }),
    (error) => error instanceof ApplicationEnvironmentRegistryError && error.code === 'secret_store_unavailable',
  );
  assert.equal((await registry.deploymentCredential(APPLICATION_ID)).configured, false);

  const plain = await registry.setVariable({ applicationId: APPLICATION_ID, key: 'PUBLIC_URL', value: 'https://example.test', secret: false });
  assert.equal(plain.value, 'https://example.test');
});

test('Git credentials share encrypted storage but never enter application environment materialization', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-git-credential-'));
  const filePath = path.join(directory, 'environment.json');
  const token = 'github_pat_private_registry_value';
  try {
    const registry = createRegistry({ filePath });
    const saved = await registry.setDeploymentCredential({
      applicationId: APPLICATION_ID,
      credential: { type: 'github_token', token },
    });
    assert.deepEqual({ configured: saved.configured, type: saved.type }, { configured: true, type: 'github_token' });
    assert.equal(JSON.stringify(saved).includes(token), false);
    assert.deepEqual(await registry.materializeDeploymentCredential(APPLICATION_ID), { type: 'github_token', token });
    assert.deepEqual(await registry.materialize(APPLICATION_ID), {});
    assert.deepEqual(await registry.listVariables(APPLICATION_ID), []);
    const persisted = await readFile(filePath, 'utf8');
    assert.equal(persisted.includes(token), false);
    assert.match(persisted, /YUNPANEL_GIT_CREDENTIAL/);

    const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${'A'.repeat(96)}\n-----END OPENSSH PRIVATE KEY-----\n`;
    const replaced = await registry.setDeploymentCredential({
      applicationId: APPLICATION_ID,
      credential: { type: 'ssh_deploy_key', privateKey },
    });
    assert.equal(replaced.type, 'ssh_deploy_key');
    assert.deepEqual(await registry.materializeDeploymentCredential(APPLICATION_ID), { type: 'ssh_deploy_key', privateKey });
    await registry.deleteDeploymentCredential(APPLICATION_ID);
    assert.deepEqual(await registry.deploymentCredential(APPLICATION_ID), {
      configured: false, type: null, createdAt: null, updatedAt: null,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reserved environment variables cannot override YunPanel runtime state', async () => {
  const registry = createRegistry();
  await assert.rejects(
    registry.setVariable({ applicationId: APPLICATION_ID, key: 'PORT', value: '9999', secret: false }),
    (error) => error instanceof ApplicationEnvironmentRegistryError && error.code === 'reserved_environment_key',
  );
  await assert.rejects(
    registry.setVariable({ applicationId: APPLICATION_ID, key: 'YUNPANEL_GIT_CREDENTIAL', value: 'leak', secret: false }),
    (error) => error instanceof ApplicationEnvironmentRegistryError && error.code === 'reserved_environment_key',
  );
});

test('environment registry checks application ownership before reads and writes', async () => {
  const registry = createRegistry();
  const unknownId = 'ff830043-9752-4640-83b4-3a1998de78a0';
  await assert.rejects(
    registry.listVariables(unknownId),
    (error) => error instanceof ApplicationEnvironmentRegistryError && error.code === 'application_not_found',
  );
});
