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

  const plain = await registry.setVariable({ applicationId: APPLICATION_ID, key: 'PUBLIC_URL', value: 'https://example.test', secret: false });
  assert.equal(plain.value, 'https://example.test');
});

test('reserved environment variables cannot override YunPanel runtime state', async () => {
  const registry = createRegistry();
  await assert.rejects(
    registry.setVariable({ applicationId: APPLICATION_ID, key: 'PORT', value: '9999', secret: false }),
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
