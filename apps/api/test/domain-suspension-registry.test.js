import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDomainRegistry, DomainRegistryError } from '../src/domain-registry.js';

const domainId = '12345678-1234-4234-8234-123456789012';
const operationId = '22345678-1234-4234-8234-123456789012';
const otherOperationId = '32345678-1234-4234-8234-123456789012';
const checksum = 'a'.repeat(64);

async function activeDomain(registry) {
  const created = await registry.createDomain({
    domainId,
    serverId: 'local',
    primaryDomain: 'example.com',
    aliases: ['www.example.com'],
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 3000 },
  });
  await registry.markStaged(created.id, {
    checksum,
    configName: 'yunpanel-example.com.conf',
  });
  return registry.markApplied(created.id, { checksum });
}

test('Domain suspension persists exact operation ownership without changing desired/applied revision', async () => {
  let clock = Date.parse('2026-09-18T16:00:00.000Z');
  const registry = createDomainRegistry({ now: () => clock });
  const active = await activeDomain(registry);
  assert.equal(active.state, 'active');

  clock += 1000;
  const suspended = await registry.markSuspended(domainId, {
    expectedRevision: 1,
    checksum,
    operationId,
  });

  assert.equal(suspended.state, 'suspended');
  assert.equal(suspended.desiredRevision, 1);
  assert.equal(suspended.stagedRevision, 1);
  assert.equal(suspended.appliedRevision, 1);
  assert.equal(suspended.stagedChecksum, checksum);
  assert.equal(suspended.suspendedChecksum, checksum);
  assert.equal(suspended.suspensionOperationId, operationId);
  assert.equal(suspended.suspendedAt, '2026-09-18T16:00:01.000Z');
  assert.equal(suspended.lastSuspensionOperationId, null);
  assert.equal(suspended.lastResumedAt, null);
  assert.equal(suspended.diagnosis.code, 'domain_suspended');
});

test('suspended Domain blocks routing mutation and generic activation bypasses', async () => {
  const registry = createDomainRegistry();
  await activeDomain(registry);
  await registry.markSuspended(domainId, {
    expectedRevision: 1,
    checksum,
    operationId,
  });

  await assert.rejects(
    registry.previewDomainUpdate({
      domainId,
      changes: { canonicalRedirect: true },
    }),
    (error) => error instanceof DomainRegistryError
      && error.code === 'domain_suspended_update_blocked',
  );
  await assert.rejects(
    registry.markStaged(domainId, {
      checksum: 'b'.repeat(64),
      configName: 'yunpanel-example.com.conf',
    }),
    (error) => error instanceof DomainRegistryError
      && error.code === 'domain_suspended_stage_blocked',
  );
  await assert.rejects(
    registry.markApplied(domainId, { checksum }),
    (error) => error instanceof DomainRegistryError
      && error.code === 'domain_suspended_activation_blocked',
  );
});

test('resume clears current suspension state but keeps last operation ownership for crash reconciliation', async () => {
  let clock = Date.parse('2026-09-18T16:00:00.000Z');
  const registry = createDomainRegistry({ now: () => clock });
  await activeDomain(registry);
  clock += 1000;
  await registry.markSuspended(domainId, {
    expectedRevision: 1,
    checksum,
    operationId,
  });
  clock += 1000;
  const resumed = await registry.markResumed(domainId, {
    expectedRevision: 1,
    checksum,
    operationId,
  });

  assert.equal(resumed.state, 'active');
  assert.equal(resumed.suspensionOperationId, null);
  assert.equal(resumed.suspendedAt, null);
  assert.equal(resumed.suspendedChecksum, null);
  assert.equal(resumed.lastSuspensionOperationId, operationId);
  assert.equal(resumed.lastResumedAt, '2026-09-18T16:00:02.000Z');
  assert.equal(resumed.lastAppliedAt, '2026-09-18T16:00:02.000Z');

  const idempotent = await registry.markResumed(domainId, {
    expectedRevision: 1,
    checksum,
    operationId,
  });
  assert.equal(idempotent.state, 'active');

  await assert.rejects(
    registry.markResumed(domainId, {
      expectedRevision: 1,
      checksum,
      operationId: otherOperationId,
    }),
    (error) => error instanceof DomainRegistryError
      && error.code === 'domain_resume_state_drift',
  );
});

test('suspend and resume reject revision, checksum and operation ownership drift', async () => {
  const registry = createDomainRegistry();
  await activeDomain(registry);

  for (const input of [
    { expectedRevision: 2, checksum, operationId },
    { expectedRevision: 1, checksum: 'b'.repeat(64), operationId },
  ]) {
    await assert.rejects(
      registry.markSuspended(domainId, input),
      (error) => error instanceof DomainRegistryError
        && error.code === 'domain_suspension_state_drift',
    );
  }

  await registry.markSuspended(domainId, {
    expectedRevision: 1,
    checksum,
    operationId,
  });
  await assert.rejects(
    registry.markSuspended(domainId, {
      expectedRevision: 1,
      checksum,
      operationId: otherOperationId,
    }),
    (error) => error instanceof DomainRegistryError
      && error.code === 'domain_suspension_state_drift',
  );
  await assert.rejects(
    registry.markResumed(domainId, {
      expectedRevision: 1,
      checksum,
      operationId: otherOperationId,
    }),
    (error) => error instanceof DomainRegistryError
      && error.code === 'domain_resume_state_drift',
  );
});

test('suspended Domain and operation ownership survive registry restart', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-domain-suspension-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'domains.json');
  let clock = Date.parse('2026-09-18T16:00:00.000Z');
  const registry = createDomainRegistry({ filePath, now: () => clock });
  await activeDomain(registry);
  clock += 1000;
  await registry.markSuspended(domainId, {
    expectedRevision: 1,
    checksum,
    operationId,
  });

  const restarted = createDomainRegistry({ filePath, now: () => clock });
  await restarted.init();
  const suspended = await restarted.getDomain(domainId);
  assert.equal(suspended.state, 'suspended');
  assert.equal(suspended.suspensionOperationId, operationId);
  assert.equal(suspended.suspendedChecksum, checksum);

  clock += 1000;
  const resumed = await restarted.markResumed(domainId, {
    expectedRevision: 1,
    checksum,
    operationId,
  });
  assert.equal(resumed.state, 'active');
  assert.equal(resumed.lastSuspensionOperationId, operationId);
});

test('version 3 Domain state migrates with empty suspension metadata instead of inventing ownership', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-domain-suspension-v3-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'domains.json');
  const current = createDomainRegistry({ filePath });
  await activeDomain(current);

  const disk = JSON.parse(await readFile(filePath, 'utf8'));
  disk.version = 3;
  for (const item of disk.domains) {
    delete item.suspensionOperationId;
    delete item.suspendedAt;
    delete item.suspendedChecksum;
    delete item.lastSuspensionOperationId;
    delete item.lastResumedAt;
  }
  await writeFile(filePath, JSON.stringify(disk));

  const migrated = createDomainRegistry({ filePath });
  await migrated.init();
  const loaded = await migrated.getDomain(domainId);
  assert.equal(loaded.state, 'active');
  assert.equal(loaded.suspensionOperationId, null);
  assert.equal(loaded.suspendedAt, null);
  assert.equal(loaded.suspendedChecksum, null);
  assert.equal(loaded.lastSuspensionOperationId, null);
  assert.equal(loaded.lastResumedAt, null);
});

test('corrupt persisted suspension metadata fails closed', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-domain-suspension-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'domains.json');
  const registry = createDomainRegistry({ filePath });
  await activeDomain(registry);
  const disk = JSON.parse(await readFile(filePath, 'utf8'));
  disk.domains[0].state = 'suspended';
  disk.domains[0].suspensionOperationId = null;
  disk.domains[0].suspendedAt = null;
  disk.domains[0].suspendedChecksum = null;
  await writeFile(filePath, JSON.stringify(disk));

  const restarted = createDomainRegistry({ filePath });
  await assert.rejects(
    restarted.init(),
    (error) => error instanceof DomainRegistryError && error.code === 'invalid_domain_state',
  );
});
