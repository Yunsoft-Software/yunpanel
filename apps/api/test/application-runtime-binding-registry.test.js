import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApplicationRuntimeBindingRegistry } from '../src/application-runtime-binding-registry.js';

const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const serverId = '57f8611c-0af7-4d2f-8291-2fe7dbab22fe';
const websiteId = '5c1c0247-139f-45d2-a6ac-c8a4bb00bc75';
const domainId = 'f05764d6-d5e8-4d2a-9bdd-493111b24478';
const operationId = 'd2fe443b-0fa6-4f98-a061-6f41b7f2684e';
const releaseId = 'ff830043-9752-4640-83b4-3a1998de78a0';
const checksum = 'a'.repeat(64);

function activation(overrides = {}) {
  return {
    applicationId,
    serverId,
    adapter: 'passenger',
    state: 'active',
    sourceOperationId: operationId,
    releaseId,
    websiteId,
    websiteRevision: 3,
    domains: [{ domainId, desiredRevision: 4, nginxChecksum: checksum }],
    ...overrides,
  };
}

test('runtime binding activation is revision-bound and idempotent for the same operation evidence', async () => {
  let clock = Date.parse('2026-09-14T18:00:00.000Z');
  const registry = createApplicationRuntimeBindingRegistry({ now: () => clock });
  const first = await registry.activate(activation(), { expectedRevision: 0 });
  assert.equal(first.revision, 1);
  assert.equal(first.adapter, 'passenger');
  assert.equal(first.state, 'active');

  clock += 1_000;
  const retry = await registry.activate(activation(), { expectedRevision: 0 });
  assert.deepEqual(retry, first);

  await assert.rejects(
    registry.activate(activation({ sourceOperationId: '1af41a08-a03d-41dc-afef-a9d1af96785d' }), { expectedRevision: 0 }),
    (error) => error?.code === 'runtime_binding_revision_conflict',
  );
});

test('runtime binding captures cleanup-required Passenger state without pretending migration is complete', async () => {
  const registry = createApplicationRuntimeBindingRegistry();
  const record = await registry.activate(activation({ state: 'cleanup_required' }), { expectedRevision: 0 });
  assert.equal(record.adapter, 'passenger');
  assert.equal(record.state, 'cleanup_required');
});

test('runtime binding requires exact Website, Domain revision, release and Nginx evidence', async () => {
  const registry = createApplicationRuntimeBindingRegistry();
  for (const candidate of [
    activation({ websiteRevision: 0 }),
    activation({ releaseId: 'not-a-uuid' }),
    activation({ domains: [] }),
    activation({ domains: [{ domainId, desiredRevision: 4, nginxChecksum: 'bad' }] }),
  ]) {
    await assert.rejects(registry.activate(candidate, { expectedRevision: 0 }));
  }
  assert.equal(await registry.getBinding(applicationId), null);
});

test('runtime binding persists only durable evidence and reloads it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-runtime-binding-'));
  const filePath = path.join(directory, 'bindings.json');
  const registry = createApplicationRuntimeBindingRegistry({ filePath });
  await registry.init();
  const created = await registry.activate(activation(), { expectedRevision: 0 });

  const raw = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.bindings.length, 1);
  assert.equal(Object.hasOwn(raw.bindings[0], 'environment'), false);

  const reloaded = createApplicationRuntimeBindingRegistry({ filePath });
  await reloaded.init();
  assert.deepEqual(await reloaded.getBinding(applicationId), created);
});
