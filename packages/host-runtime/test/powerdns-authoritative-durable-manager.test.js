import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPowerDnsAuthoritativeDurableManager,
} from '../src/powerdns-authoritative-durable-manager.js';
import { PowerDnsAuthoritativeManagerError } from '../src/powerdns-authoritative-manager.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const apiKey = 'A'.repeat(43);
const appliedAt = '2026-09-16T12:00:00.000Z';

function intent(overrides = {}) {
  return {
    serverId,
    apiKey,
    apiKeyRevision: 2,
    secondaryDns: ['203.0.113.20'],
    ...overrides,
  };
}

function satisfied(overrides = {}) {
  return {
    satisfied: true,
    serverId,
    apiKeyRevision: 2,
    secondaryDns: ['203.0.113.20'],
    packages: [{ installed: true, version: '4.8.3-1ubuntu1' }],
    receipt: { appliedAt },
    ...overrides,
  };
}

function unsatisfied(reason = 'powerdns_service_inactive') {
  return { satisfied: false, reason };
}

function memoryJournal() {
  const files = new Map();
  return {
    files,
    async chmodFn() {},
    async mkdirFn() {},
    async readFileFn(path) {
      if (!files.has(path)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(path);
    },
    async renameFn(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
    async writeFileFn(path, content) { files.set(path, content); },
  };
}

test('PowerDNS durable manager persists applying evidence before host mutation and succeeds with verified evidence', async () => {
  const journal = memoryJournal();
  const operationPath = '/state/powerdns-operation.json';
  let applyCalls = 0;
  const manager = createPowerDnsAuthoritativeDurableManager({
    manager: {
      async inspect() { return unsatisfied(); },
      async apply() {
        applyCalls += 1;
        const applying = JSON.parse(journal.files.get(operationPath));
        assert.equal(applying.status, 'applying');
        assert.equal(applying.apiKey, undefined);
        return satisfied();
      },
    },
    operationPath,
    now: () => Date.parse(appliedAt),
    idFactory: () => 'operation-1',
    ...journal,
  });

  assert.equal((await manager.apply(intent())).satisfied, true);
  assert.equal(applyCalls, 1);
  const persisted = JSON.parse(journal.files.get(operationPath));
  assert.equal(persisted.status, 'succeeded');
  assert.equal(persisted.result.satisfied, true);
  assert.equal(persisted.result.packages[0].version, '4.8.3-1ubuntu1');
  assert.equal(persisted.apiKey, undefined);
  assert.deepEqual(await manager.operation(), {
    version: 1,
    id: 'operation-1',
    serverId,
    credentialRevision: 2,
    secondaryDns: ['203.0.113.20'],
    status: 'succeeded',
    evidence: persisted.result,
    failure: null,
    recovery: { required: false, automaticReplayBlocked: false, reason: null },
    createdAt: appliedAt,
    updatedAt: appliedAt,
  });
});

test('PowerDNS durable manager never replays an interrupted applying mutation before recovery inspection proves completion', async () => {
  const journal = memoryJournal();
  const operationPath = '/state/powerdns-operation.json';
  let applyCalls = 0;
  let inspectCalls = 0;
  const manager = createPowerDnsAuthoritativeDurableManager({
    manager: {
      async inspect() {
        inspectCalls += 1;
        return unsatisfied();
      },
      async apply() {
        applyCalls += 1;
        throw new PowerDnsAuthoritativeManagerError(
          'powerdns_service_activation_failed',
          'systemctl result is ambiguous',
        );
      },
    },
    operationPath,
    now: () => Date.parse(appliedAt),
    idFactory: () => 'operation-2',
    ...journal,
  });

  await assert.rejects(
    manager.apply(intent()),
    (error) => error instanceof PowerDnsAuthoritativeManagerError
      && error.code === 'powerdns_apply_outcome_uncertain',
  );
  assert.equal(applyCalls, 1);
  assert.equal(JSON.parse(journal.files.get(operationPath)).status, 'applying');
  const operation = await manager.operation();
  assert.equal(operation.status, 'applying');
  assert.equal(operation.recovery.required, true);
  assert.equal(operation.recovery.automaticReplayBlocked, true);
  assert.equal(operation.recovery.reason, 'powerdns_service_activation_failed');
  assert.deepEqual(operation.failure, { code: 'powerdns_service_activation_failed' });
  assert.equal(Object.hasOwn(operation.failure, 'message'), false);

  await assert.rejects(
    manager.apply(intent()),
    (error) => error instanceof PowerDnsAuthoritativeManagerError
      && error.code === 'powerdns_recovery_pending',
  );
  assert.equal(applyCalls, 1);
  assert.ok(inspectCalls >= 3);
});

test('PowerDNS durable manager closes an interrupted operation from inspect evidence without replaying mutation', async () => {
  const journal = memoryJournal();
  const operationPath = '/state/powerdns-operation.json';
  let applyCalls = 0;
  let ready = false;
  const manager = createPowerDnsAuthoritativeDurableManager({
    manager: {
      async inspect() { return ready ? satisfied() : unsatisfied(); },
      async apply() {
        applyCalls += 1;
        throw new PowerDnsAuthoritativeManagerError(
          'powerdns_service_activation_failed',
          'activation outcome unknown',
        );
      },
    },
    operationPath,
    now: () => Date.parse(appliedAt),
    idFactory: () => 'operation-3',
    ...journal,
  });

  await assert.rejects(manager.apply(intent()), (error) => error.code === 'powerdns_apply_outcome_uncertain');
  assert.equal(applyCalls, 1);

  ready = true;
  const operation = await manager.operation();
  const recovered = await manager.resolve(intent(), {
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
  });
  assert.equal(recovered.satisfied, true);
  assert.equal(applyCalls, 1);
  const persisted = JSON.parse(journal.files.get(operationPath));
  assert.equal(persisted.status, 'succeeded');
  assert.equal(persisted.result.receiptAppliedAt, appliedAt);
});

test('PowerDNS recovery resolution rejects a stale journal fence before host inspection', async () => {
  const journal = memoryJournal();
  const operationPath = '/state/powerdns-operation.json';
  let inspectCalls = 0;
  const manager = createPowerDnsAuthoritativeDurableManager({
    manager: {
      async inspect() { inspectCalls += 1; return unsatisfied(); },
      async apply() {
        throw new PowerDnsAuthoritativeManagerError('powerdns_service_activation_failed', 'ambiguous');
      },
    },
    operationPath,
    now: () => Date.parse(appliedAt),
    idFactory: () => 'operation-stale',
    ...journal,
  });

  await assert.rejects(manager.apply(intent()), (error) => error.code === 'powerdns_apply_outcome_uncertain');
  const beforeResolve = inspectCalls;
  await assert.rejects(
    manager.resolve(intent(), { operationId: 'another-operation', expectedUpdatedAt: appliedAt }),
    (error) => error.code === 'powerdns_recovery_stale',
  );
  assert.equal(inspectCalls, beforeResolve);
  assert.equal((await manager.operation()).status, 'applying');
});

test('PowerDNS durable manager records config validation rollback as a deterministic failed operation', async () => {
  const journal = memoryJournal();
  const operationPath = '/state/powerdns-operation.json';
  const manager = createPowerDnsAuthoritativeDurableManager({
    manager: {
      async inspect() { return unsatisfied('powerdns_config_missing'); },
      async apply() {
        throw new PowerDnsAuthoritativeManagerError('powerdns_config_invalid', 'candidate rejected');
      },
    },
    operationPath,
    now: () => Date.parse(appliedAt),
    idFactory: () => 'operation-4',
    ...journal,
  });

  await assert.rejects(
    manager.apply(intent()),
    (error) => error instanceof PowerDnsAuthoritativeManagerError && error.code === 'powerdns_config_invalid',
  );
  const persisted = JSON.parse(journal.files.get(operationPath));
  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.lastError.code, 'powerdns_config_invalid');
});
