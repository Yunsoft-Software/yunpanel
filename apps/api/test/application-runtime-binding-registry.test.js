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
const passengerTarget = Object.freeze({
  appRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
  documentRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
  startupFile: 'server.js',
  nodeBinary: '/opt/yunpanel/node-runtimes/v24/bin/node',
  user: 'yunapp-0123456789ab',
  group: 'yunapp-0123456789ab',
  appEnv: 'production',
  environmentInclude: `/etc/yunpanel/passenger-env/${applicationId}.conf`,
});
const staticTarget = Object.freeze({
  publishRoot: `/var/www/yunpanel/apps/${applicationId}`,
  documentRoot: `/var/www/yunpanel/apps/${applicationId}/current`,
  user: 'yunapp-0123456789ab',
  group: 'yunapp-0123456789ab',
});

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
    passengerTarget,
    ...overrides,
  };
}

function staticActivation(overrides = {}) {
  return {
    applicationId,
    serverId,
    adapter: 'static',
    state: 'active',
    sourceOperationId: operationId,
    releaseId,
    websiteId,
    websiteRevision: 3,
    domains: [{ domainId, desiredRevision: 4, nginxChecksum: checksum }],
    staticTarget,
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
  assert.deepEqual(first.passengerTarget, passengerTarget);

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

test('native Passenger binding may omit a generated environment include', async () => {
  const registry = createApplicationRuntimeBindingRegistry();
  const record = await registry.activate(activation({
    passengerTarget: { ...passengerTarget, environmentInclude: null },
  }), { expectedRevision: 0 });
  assert.equal(record.passengerTarget.environmentInclude, null);
});

test('runtime binding requires exact Website, Domain revision, release, Nginx and Passenger target evidence', async () => {
  const registry = createApplicationRuntimeBindingRegistry();
  for (const candidate of [
    activation({ websiteRevision: 0 }),
    activation({ releaseId: 'not-a-uuid' }),
    activation({ domains: [] }),
    activation({ domains: [{ domainId, desiredRevision: 4, nginxChecksum: 'bad' }] }),
    activation({ passengerTarget: { ...passengerTarget, startupFile: '../escape.js' } }),
    activation({ passengerTarget: { ...passengerTarget, environmentInclude: 'relative.conf' } }),
    activation({ passengerTarget: null }),
  ]) {
    await assert.rejects(registry.activate(candidate, { expectedRevision: 0 }));
  }
  assert.equal(await registry.getBinding(applicationId), null);
});

test('direct-systemd binding cannot carry Passenger target evidence', async () => {
  const registry = createApplicationRuntimeBindingRegistry();
  await assert.rejects(registry.activate(activation({
    adapter: 'direct-systemd',
    passengerTarget,
  }), { expectedRevision: 0 }));
});

test('operation-owned Passenger binding removal is revision-bound and idempotent after removal', async () => {
  const registry = createApplicationRuntimeBindingRegistry();
  const created = await registry.activate(activation(), { expectedRevision: 0 });

  await assert.rejects(
    registry.removeOwnedPassenger(applicationId, {
      sourceOperationId: '1af41a08-a03d-41dc-afef-a9d1af96785d',
      expectedRevision: created.revision,
    }),
    (error) => error?.code === 'runtime_binding_ownership_conflict',
  );
  await assert.rejects(
    registry.removeOwnedPassenger(applicationId, {
      sourceOperationId: operationId,
      expectedRevision: created.revision + 1,
    }),
    (error) => error?.code === 'runtime_binding_revision_conflict',
  );

  const removed = await registry.removeOwnedPassenger(applicationId, {
    sourceOperationId: operationId,
    expectedRevision: created.revision,
  });
  assert.equal(removed.revision, created.revision);
  assert.equal(await registry.getBinding(applicationId), null);
  assert.equal(await registry.removeOwnedPassenger(applicationId, {
    sourceOperationId: operationId,
    expectedRevision: created.revision,
  }), null);
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
  assert.deepEqual(raw.bindings[0].passengerTarget, passengerTarget);

  const reloaded = createApplicationRuntimeBindingRegistry({ filePath });
  await reloaded.init();
  assert.deepEqual(await reloaded.getBinding(applicationId), created);
});

test('static runtime binding activation tracks durable release and rollback revision', async () => {
  const registry = createApplicationRuntimeBindingRegistry();
  const initial = await registry.activate(staticActivation(), { expectedRevision: 0 });
  assert.equal(initial.revision, 1);
  assert.equal(initial.adapter, 'static');
  assert.equal(initial.state, 'active');
  assert.deepEqual(initial.staticTarget, staticTarget);
  assert.equal(initial.passengerTarget, null);

  // Idempotent retry with same evidence
  const retry = await registry.activate(staticActivation(), { expectedRevision: 0 });
  assert.deepEqual(retry, initial);

  // Next release / rollback advances revision
  const nextReleaseId = '57f8611c-0af7-4d2f-8291-2fe7dbab22ff';
  const nextOperationId = 'e2fe443b-0fa6-4f98-a061-6f41b7f2684f';
  const rollback = await registry.activate(staticActivation({
    releaseId: nextReleaseId,
    sourceOperationId: nextOperationId,
  }), { expectedRevision: initial.revision });

  assert.equal(rollback.revision, 2);
  assert.equal(rollback.releaseId, nextReleaseId);
  assert.equal(rollback.sourceOperationId, nextOperationId);
});

test('static runtime binding rejects mismatched targets and invalid states', async () => {
  const registry = createApplicationRuntimeBindingRegistry();

  // Static cannot carry passengerTarget
  await assert.rejects(
    registry.activate(staticActivation({ passengerTarget }), { expectedRevision: 0 }),
    (error) => error?.code === 'runtime_binding_target_invalid',
  );

  // Passenger cannot carry staticTarget
  await assert.rejects(
    registry.activate(activation({ staticTarget }), { expectedRevision: 0 }),
    (error) => error?.code === 'runtime_binding_target_invalid',
  );

  // Static cannot be cleanup_required
  await assert.rejects(
    registry.activate(staticActivation({ state: 'cleanup_required' }), { expectedRevision: 0 }),
    (error) => error?.code === 'runtime_binding_state_invalid',
  );
});

test('operation-owned static binding removal is revision-bound and idempotent', async () => {
  const registry = createApplicationRuntimeBindingRegistry();
  const created = await registry.activate(staticActivation(), { expectedRevision: 0 });

  await assert.rejects(
    registry.removeOwnedStatic(applicationId, {
      sourceOperationId: '1af41a08-a03d-41dc-afef-a9d1af96785d',
      expectedRevision: created.revision,
    }),
    (error) => error?.code === 'runtime_binding_ownership_conflict',
  );

  const removed = await registry.removeOwnedStatic(applicationId, {
    sourceOperationId: operationId,
    expectedRevision: created.revision,
  });
  assert.equal(removed.revision, created.revision);
  assert.equal(await registry.getBinding(applicationId), null);
  assert.equal(await registry.removeOwnedStatic(applicationId, {
    sourceOperationId: operationId,
    expectedRevision: created.revision,
  }), null);
});


test('operation-owned direct-systemd binding removal is revision-bound and idempotent', async () => {
  const registry = createApplicationRuntimeBindingRegistry();
  const created = await registry.activate(activation({
    adapter: 'direct-systemd',
    passengerTarget: null,
  }), { expectedRevision: 0 });

  await assert.rejects(
    registry.removeOwnedDirectSystemd(applicationId, {
      sourceOperationId: '1af41a08-a03d-41dc-afef-a9d1af96785d',
      expectedRevision: created.revision,
    }),
    (error) => error?.code === 'runtime_binding_ownership_conflict',
  );
  await assert.rejects(
    registry.removeOwnedDirectSystemd(applicationId, {
      sourceOperationId: operationId,
      expectedRevision: created.revision + 1,
    }),
    (error) => error?.code === 'runtime_binding_revision_conflict',
  );

  const removed = await registry.removeOwnedDirectSystemd(applicationId, {
    sourceOperationId: operationId,
    expectedRevision: created.revision,
  });
  assert.equal(removed.adapter, 'direct-systemd');
  assert.equal(await registry.getBinding(applicationId), null);
  assert.equal(await registry.removeOwnedDirectSystemd(applicationId, {
    sourceOperationId: operationId,
    expectedRevision: created.revision,
  }), null);
});
