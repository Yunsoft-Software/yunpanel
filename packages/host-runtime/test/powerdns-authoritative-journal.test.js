import assert from 'node:assert/strict';
import test from 'node:test';
import { PowerDnsAuthoritativeManagerError } from '../src/powerdns-authoritative-manager.js';
import {
  configFor,
  createFakeHost,
  hostWithRollbackSnapshot,
  intent,
  paths,
  previousSecondaryDns,
  rollbackRequest,
  serverId,
} from './powerdns-fake-host.js';

const appliedAt = '2026-09-16T12:00:00.000Z';

function managerError(code) {
  return (error) => error instanceof PowerDnsAuthoritativeManagerError && error.code === code;
}

function enableCount(host) {
  return host.commands('/usr/bin/systemctl', 'enable').length;
}

// Activation reports failure once although the unit may have started: the outcome is unknown.
async function uncertainApply(host, manager) {
  host.failActivations = 1;
  await assert.rejects(manager.apply(intent()), managerError('powerdns_apply_outcome_uncertain'));
  return manager.operation();
}

test('PowerDNS journal persists applying evidence before host mutation and succeeds with verified evidence', async () => {
  const host = createFakeHost();
  const seen = [];
  host.onRun = (file, args) => {
    if (file === '/usr/bin/dpkg-query' || file === '/usr/bin/stat' || args[0] === 'is-active') return;
    seen.push(host.files.has(paths.journal) ? host.journal() : null);
  };
  const manager = host.manager();

  assert.equal((await manager.apply(intent())).satisfied, true);

  assert.ok(seen.length > 0);
  assert.ok(seen.every((journal) => journal?.status === 'applying' && journal.apiKey === undefined));
  const persisted = host.journal();
  assert.equal(persisted.status, 'succeeded');
  assert.equal(persisted.result.satisfied, true);
  assert.equal(persisted.result.packages[0].version, '4.8.3-1ubuntu1');
  assert.equal(persisted.apiKey, undefined);
  assert.deepEqual(await manager.operation(), {
    version: 2,
    id: 'operation-1',
    serverId,
    credentialRevision: 2,
    secondaryDns: ['203.0.113.20'],
    status: 'succeeded',
    evidence: persisted.result,
    failure: null,
    recovery: { required: false, automaticReplayBlocked: false, reason: null },
    createdAt: appliedAt,
    updatedAt: '2026-09-16T12:00:00.001Z',
    rollback: {
      status: 'idle',
      available: false,
      reason: 'powerdns_rollback_previous_config_missing',
      snapshotDigest: null,
      previousSecondaryDns: null,
      snapshotCreatedAt: appliedAt,
      automaticReplayBlocked: false,
    },
  });
});

test('PowerDNS journal never replays an interrupted applying mutation before recovery inspection proves completion', async () => {
  const host = createFakeHost();
  const manager = host.manager();

  const operation = await uncertainApply(host, manager);

  assert.equal(enableCount(host), 1);
  assert.equal(host.journal().status, 'applying');
  assert.equal(operation.status, 'applying');
  assert.equal(operation.recovery.required, true);
  assert.equal(operation.recovery.automaticReplayBlocked, true);
  assert.equal(operation.recovery.reason, 'powerdns_service_activation_failed');
  assert.deepEqual(operation.failure, { code: 'powerdns_service_activation_failed' });
  assert.equal(Object.hasOwn(operation.failure, 'message'), false);

  const inspections = host.commands('/usr/bin/dpkg-query').length;
  await assert.rejects(manager.apply(intent()), managerError('powerdns_recovery_pending'));
  assert.equal(enableCount(host), 1);
  assert.equal(host.configWrites(), 1);
  assert.ok(host.commands('/usr/bin/dpkg-query').length > inspections);
});

test('PowerDNS journal closes an interrupted operation from inspect evidence without replaying mutation', async () => {
  const host = createFakeHost();
  const manager = host.manager();
  host.inactiveChecks = 2;
  await assert.rejects(manager.apply(intent()), managerError('powerdns_apply_outcome_uncertain'));
  assert.equal(host.journal().lastError.code, 'powerdns_apply_unverified');
  const operation = await manager.operation();
  const sockets = host.socketChecks;

  const recovered = await manager.resolve(intent(), { operationId: operation.id, expectedUpdatedAt: operation.updatedAt });

  assert.equal(recovered.satisfied, true);
  assert.equal(recovered.sockets.udp53, true);
  assert.equal(host.socketChecks, sockets + 1);
  assert.equal(enableCount(host), 1);
  assert.equal(host.configWrites(), 1);
  const persisted = host.journal();
  assert.equal(persisted.status, 'succeeded');
  assert.equal(persisted.result.receiptAppliedAt, appliedAt);
});

test('PowerDNS recovery resolution rejects a stale journal fence before host inspection', async () => {
  const host = createFakeHost();
  const manager = host.manager();
  await uncertainApply(host, manager);
  const calls = host.calls.length;

  await assert.rejects(
    manager.resolve(intent(), { operationId: 'another-operation', expectedUpdatedAt: appliedAt }),
    managerError('powerdns_recovery_stale'),
  );
  assert.equal(host.calls.length, calls);
  assert.equal((await manager.operation()).status, 'applying');
});

test('PowerDNS explicit retry inspects first and persists authorization before replaying mutation', async () => {
  const host = createFakeHost();
  const manager = host.manager();
  const operation = await uncertainApply(host, manager);
  const events = [];
  host.onRun = (file, args) => {
    if (file === '/usr/bin/dpkg-query') events.push('inspect');
    if (file === '/usr/bin/systemctl' && args[0] === 'enable') {
      const persisted = host.journal();
      assert.equal(persisted.lastError.code, 'powerdns_explicit_retry_started');
      assert.notEqual(persisted.updatedAt, operation.updatedAt);
      events.push('apply');
    }
  };

  const result = await manager.retry(intent(), { operationId: operation.id, expectedUpdatedAt: operation.updatedAt });

  assert.equal(result.satisfied, true);
  assert.equal(result.sockets.tcp53, true);
  assert.equal(events[0], 'inspect');
  assert.equal(events.filter((event) => event === 'apply').length, 1);
  assert.equal(enableCount(host), 2);
  assert.equal(host.journal().id, operation.id);
  assert.equal((await manager.operation()).status, 'succeeded');
});

test('PowerDNS explicit retry fails closed when preflight inspection is unavailable', async () => {
  const host = createFakeHost();
  const manager = host.manager();
  const operation = await uncertainApply(host, manager);
  host.lstatErrors.add(paths.config);

  await assert.rejects(
    manager.retry(intent(), { operationId: operation.id, expectedUpdatedAt: operation.updatedAt }),
    managerError('powerdns_recovery_inspection_unavailable'),
  );
  assert.equal(enableCount(host), 1);
  assert.equal((await manager.operation()).status, 'applying');
});

test('PowerDNS journal serializes concurrent apply requests before host mutation', async () => {
  const host = createFakeHost();
  let releaseApply;
  const gate = new Promise((resolve) => { releaseApply = resolve; });
  host.onRun = async (file, args) => {
    if (file === '/usr/bin/systemctl' && args[0] === 'enable') await gate;
  };
  const manager = host.manager();

  const first = manager.apply(intent());
  const second = manager.apply(intent());
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(enableCount(host), 1);
  releaseApply();
  const results = await Promise.all([first, second]);

  assert.equal(enableCount(host), 1);
  assert.equal(results.every((result) => result.satisfied === true), true);
  assert.equal((await manager.operation()).status, 'succeeded');
});

test('PowerDNS journal records rollback snapshot preflight failure without uncertain replay state', async () => {
  const host = createFakeHost();
  host.put(paths.config, configFor(previousSecondaryDns), { gid: 113, mode: 0o640 });
  host.put(paths.receipt, 'not-json\n');

  await assert.rejects(host.manager().apply(intent()), managerError('powerdns_rollback_snapshot_failed'));

  const persisted = host.journal();
  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.lastError.code, 'powerdns_rollback_snapshot_failed');
  assert.equal(host.text(paths.config), configFor(previousSecondaryDns));
  assert.equal(host.hashes, 0);
});

test('PowerDNS journal records explicit rollback before host mutation and keeps previous-state evidence', async () => {
  const { host, manager, operation } = await hostWithRollbackSnapshot();
  assert.deepEqual(operation.rollback, {
    status: 'idle',
    available: true,
    reason: null,
    snapshotDigest: operation.rollback.snapshotDigest,
    previousSecondaryDns: [...previousSecondaryDns],
    snapshotCreatedAt: '2026-09-16T12:01:00.000Z',
    automaticReplayBlocked: false,
  });
  assert.match(operation.rollback.snapshotDigest, /^[a-f0-9]{64}$/);
  const statusAtRestore = [];
  host.onRename = (_from, to) => {
    if (to === paths.config) statusAtRestore.push(host.journal().status);
  };

  const result = await manager.rollback(intent(), rollbackRequest(operation));

  assert.equal(result.satisfied, true);
  assert.deepEqual(statusAtRestore, ['rolling_back']);
  const persisted = host.journal();
  assert.equal(persisted.version, 2);
  assert.equal(persisted.status, 'rolled_back');
  assert.deepEqual(persisted.result.secondaryDns, [...previousSecondaryDns]);
  const completed = await manager.operation();
  assert.equal(completed.status, 'rolled_back');
  assert.equal(completed.rollback.status, 'succeeded');
  assert.equal(completed.rollback.available, false);
  assert.equal(completed.rollback.reason, 'powerdns_rollback_already_completed');

  const repeated = await manager.rollback(intent(), rollbackRequest(operation, { expectedUpdatedAt: completed.updatedAt }));
  assert.deepEqual(repeated.secondaryDns, [...previousSecondaryDns]);
  assert.equal(repeated.sockets.satisfied, true);
  assert.equal(host.journal().updatedAt, completed.updatedAt);
});

test('PowerDNS journal rejects a stale rollback snapshot without changing succeeded state', async () => {
  const { host, manager, operation } = await hostWithRollbackSnapshot();
  const config = host.bytes(paths.config);
  const restarts = host.restarts.length;

  await assert.rejects(
    manager.rollback(intent(), rollbackRequest(operation, { snapshotDigest: 'c'.repeat(64) })),
    managerError('powerdns_rollback_snapshot_stale'),
  );
  assert.equal(host.journal().status, 'succeeded');
  assert.equal(host.bytes(paths.config).equals(config), true);
  assert.equal(host.restarts.length, restarts);
});

test('PowerDNS journal resumes only an explicit interrupted rollback after restart', async () => {
  const { host, operation } = await hostWithRollbackSnapshot();
  host.editJournal({
    status: 'rolling_back',
    lastError: {
      code: 'powerdns_explicit_rollback_started',
      message: 'Operator-authorized PowerDNS rollback started from an exact snapshot',
    },
    updatedAt: '2026-09-16T12:01:01.000Z',
  });
  host.clock = Date.parse('2026-09-16T12:01:02.000Z');

  const restarted = host.manager();
  const interrupted = await restarted.operation();
  assert.equal(interrupted.status, 'rolling_back');
  assert.equal(interrupted.recovery.required, true);
  assert.equal(interrupted.rollback.automaticReplayBlocked, true);
  await assert.rejects(restarted.apply(intent()), managerError('powerdns_rollback_recovery_pending'));

  await restarted.rollback(intent(), rollbackRequest(interrupted));
  assert.equal((await restarted.operation()).status, 'rolled_back');
  assert.equal(operation.id, interrupted.id);
});

test('PowerDNS journal reads a legacy version-one journal into version two state', async () => {
  const host = createFakeHost();
  const manager = host.manager();
  await manager.apply(intent());
  host.editJournal({ version: 1 });

  const operation = await manager.operation();
  assert.equal(operation.version, 2);
  assert.equal(operation.status, 'succeeded');
  assert.equal(host.journal().version, 1);
});

test('PowerDNS journal refuses a changed intent while another apply is interrupted', async () => {
  const host = createFakeHost();
  const manager = host.manager();
  await uncertainApply(host, manager);

  await assert.rejects(
    manager.apply(intent({ secondaryDns: [...previousSecondaryDns] })),
    managerError('powerdns_operation_conflict'),
  );
  assert.equal(enableCount(host), 1);
});
