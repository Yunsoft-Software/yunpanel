import assert from 'node:assert/strict';
import test from 'node:test';
import { createPowerDnsSecretRegistry, PowerDnsSecretRegistryError } from '../src/powerdns-secret-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const firstKey = 'A'.repeat(43);
const secondKey = 'B'.repeat(43);

function registry(keys = [firstKey, secondKey]) {
  let index = 0;
  return createPowerDnsSecretRegistry({
    masterKey: Buffer.alloc(32, 7),
    serverExists: async (id) => id === serverId,
    generateApiKey: () => keys[index++],
    now: (() => {
      let value = Date.parse('2026-09-15T00:00:00.000Z');
      return () => (value += 1000);
    })(),
  });
}

test('PowerDNS API secret remains hidden from public state and materializes only through the private accessor', async () => {
  const store = registry();
  const created = await store.ensureForServer(serverId);
  assert.equal(created.configured, true);
  assert.equal(created.revision, 1);
  assert.equal(Object.hasOwn(created, 'apiKey'), false);

  const materialized = await store.materializeForServer(serverId);
  assert.deepEqual(materialized, { serverId, revision: 1, apiKey: firstKey });

  const read = await store.getForServer(serverId);
  assert.equal(read.configured, true);
  assert.equal(Object.hasOwn(read, 'apiKey'), false);
});

test('PowerDNS API secret rotation requires exact revision-bound confirmation', async () => {
  const store = registry();
  await store.ensureForServer(serverId);

  await assert.rejects(
    store.rotateForServer(serverId, { expectedRevision: 1, confirmation: 'wrong' }),
    (error) => error instanceof PowerDnsSecretRegistryError
      && error.code === 'powerdns_secret_confirmation_invalid'
      && error.status === 409,
  );

  const rotated = await store.rotateForServer(serverId, {
    expectedRevision: 1,
    confirmation: `rotate-powerdns-api-key:${serverId}:1`,
  });
  assert.equal(rotated.revision, 2);
  const materialized = await store.materializeForServer(serverId);
  assert.equal(materialized.apiKey, secondKey);
  assert.equal(materialized.revision, 2);
});

test('PowerDNS secret registry rejects missing master key and unknown server identities', async () => {
  assert.throws(
    () => createPowerDnsSecretRegistry({ masterKey: null }),
    (error) => error instanceof PowerDnsSecretRegistryError && error.code === 'powerdns_secret_store_unavailable',
  );

  const store = registry();
  await assert.rejects(
    store.ensureForServer('11111111-1111-4111-8111-111111111111'),
    (error) => error instanceof PowerDnsSecretRegistryError && error.code === 'powerdns_server_not_found' && error.status === 404,
  );
});
