import assert from 'node:assert/strict';
import test from 'node:test';
import { PowerDnsAuthoritativeManagerError } from '../src/powerdns-authoritative-manager.js';
import {
  apiKey,
  configFor,
  createFakeHost,
  currentSecondaryDns,
  hostWithRollbackSnapshot,
  intent,
  otherApiKey,
  paths,
  previousSecondaryDns,
  rollbackRequest,
} from './powerdns-fake-host.js';

function managerError(code) {
  return (error) => error instanceof PowerDnsAuthoritativeManagerError && error.code === code;
}

const previousConfig = configFor(previousSecondaryDns);
const currentConfig = configFor(currentSecondaryDns);

// Which managed config each service restart since `from` activated.
function activations(host, from) {
  return host.restarts.slice(from).map((config) => {
    if (config === previousConfig) return 'previous';
    if (config === currentConfig) return 'current';
    return 'other';
  });
}

// Rewinds a completed rollback to "interrupted", as after a crash before the journal update.
function interruptRollback(host) {
  host.editJournal({
    status: 'rolling_back',
    lastError: { code: 'powerdns_explicit_rollback_started', message: 'Operator-authorized PowerDNS rollback started from an exact snapshot' },
  });
}

test('PowerDNS rollback snapshot is private, operation-bound and persisted before the apply mutates files', async () => {
  const host = createFakeHost();
  const manager = host.manager();
  await manager.apply(intent({ secondaryDns: [...previousSecondaryDns] }));
  const snapshotAtFirstWrite = [];
  host.onRun = (file, args) => {
    if (file === '/usr/bin/chown' && args[0] === 'root:pdns') snapshotAtFirstWrite.push(host.files.has(paths.snapshot) && JSON.parse(host.text(paths.snapshot)).operationId);
  };
  host.clock = Date.parse('2026-09-17T10:00:00.000Z');

  await manager.apply(intent());

  assert.deepEqual(snapshotAtFirstWrite, ['operation-2']);
  const { rollback } = await manager.operation();
  assert.deepEqual(rollback.previousSecondaryDns, [...previousSecondaryDns]);
  assert.equal(rollback.available, true);
  assert.equal(rollback.reason, null);
  assert.match(rollback.snapshotDigest, /^[a-f0-9]{64}$/);
  assert.equal(rollback.snapshotCreatedAt, '2026-09-17T10:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(rollback), /content|apiKey|scrypt/);

  const persisted = JSON.parse(host.text(paths.snapshot));
  assert.equal(persisted.operationId, 'operation-2');
  assert.equal(typeof persisted.config.content, 'string');
  assert.equal(typeof persisted.receipt.content, 'string');
  assert.doesNotMatch(JSON.stringify(persisted), new RegExp(apiKey));
  assert.deepEqual(host.meta(paths.snapshot), { uid: 0, gid: 0, mode: 0o600 });
  assert.deepEqual((await host.manager().operation()).rollback, rollback);
});

test('PowerDNS rollback snapshot keeps the original capture when an interrupted operation is retried', async () => {
  const host = createFakeHost();
  const manager = host.manager();
  await manager.apply(intent({ secondaryDns: [...previousSecondaryDns] }));
  host.failActivations = 1;
  await assert.rejects(manager.apply(intent()), managerError('powerdns_apply_outcome_uncertain'));
  const original = host.text(paths.snapshot);
  const operation = await manager.operation();
  host.clock += 60_000;

  await manager.retry(intent(), { operationId: operation.id, expectedUpdatedAt: operation.updatedAt });

  assert.equal(host.text(paths.snapshot), original);
  assert.deepEqual(JSON.parse(original).previousSecondaryDns, [...previousSecondaryDns]);
});

test('PowerDNS rollback is unavailable when the previous config has no receipt', async () => {
  const host = createFakeHost();
  host.put(paths.config, previousConfig, { gid: 113, mode: 0o640 });
  const manager = host.manager();

  await manager.apply(intent());

  const { rollback } = await manager.operation();
  assert.equal(rollback.available, false);
  assert.equal(rollback.reason, 'powerdns_rollback_previous_receipt_missing');
  assert.equal(rollback.snapshotDigest, null);
  assert.equal(rollback.previousSecondaryDns, null);
  assert.equal(Number.isFinite(Date.parse(rollback.snapshotCreatedAt)), true);
});

test('PowerDNS credential rotation applies but marks the previous secret unrecoverable', async () => {
  const host = createFakeHost();
  const manager = host.manager();
  await manager.apply(intent({ apiKey: otherApiKey, apiKeyRevision: 1 }));

  assert.equal((await manager.apply(intent())).satisfied, true);

  const { rollback } = await manager.operation();
  assert.equal(rollback.available, false);
  assert.equal(rollback.reason, 'powerdns_rollback_previous_credential_unavailable');
});

test('PowerDNS rollback restores the exact snapshot after restart and resumes idempotently', async () => {
  const { host, operation } = await hostWithRollbackSnapshot();
  const previous = JSON.parse(host.text(paths.snapshot));
  const restarts = host.restarts.length;
  const sockets = host.socketChecks;
  const hashes = host.hashes;
  const restarted = host.manager();

  const result = await restarted.rollback(intent(), rollbackRequest(operation));

  assert.equal(result.satisfied, true);
  assert.deepEqual(result.sockets, { satisfied: true, udp53: true, tcp53: true, recursive: false });
  assert.equal(host.socketChecks, sockets + 1);
  assert.deepEqual(result.rollback, { operationId: operation.id, snapshotDigest: operation.rollback.snapshotDigest, alreadyRestored: false });
  assert.equal(host.bytes(paths.config).toString('base64'), previous.config.content);
  assert.equal(host.bytes(paths.receipt).toString('base64'), previous.receipt.content);
  assert.deepEqual(host.meta(paths.config), { uid: 0, gid: 113, mode: 0o640 });
  assert.deepEqual(host.meta(paths.receipt), { uid: 0, gid: 0, mode: 0o600 });
  assert.deepEqual(activations(host, restarts), ['previous']);
  assert.equal(host.commands('/usr/sbin/pdns_server', '--config=check').length > 0, true);
  assert.equal(host.commands('/usr/bin/apt-get').length, 0);
  assert.equal(host.hashes, hashes);

  interruptRollback(host);
  const resumed = await host.manager().rollback(intent(), rollbackRequest(await restarted.operation()));
  assert.equal(resumed.rollback.alreadyRestored, true);
  assert.deepEqual(activations(host, restarts), ['previous']);
});

test('PowerDNS rollback persists private current-state compensation and completes mixed files after restart', async () => {
  const { host, manager, operation } = await hostWithRollbackSnapshot();
  const current = { config: host.bytes(paths.config), receipt: host.bytes(paths.receipt) };
  const previousSnapshot = JSON.parse(host.text(paths.snapshot));
  const previous = {
    config: Buffer.from(previousSnapshot.config.content, 'base64'),
    receipt: Buffer.from(previousSnapshot.receipt.content, 'base64'),
  };
  host.clock = Date.parse('2026-09-17T13:00:00.000Z');
  await manager.rollback(intent(), rollbackRequest(operation));

  const compensation = JSON.parse(host.text(paths.compensation));
  assert.equal(compensation.operationId, operation.id);
  assert.equal(compensation.rollbackSnapshotDigest, operation.rollback.snapshotDigest);
  assert.equal(compensation.createdAt, '2026-09-17T13:00:00.000Z');
  assert.match(compensation.compensationDigest, /^[a-f0-9]{64}$/);
  assert.equal(Buffer.from(compensation.config.content, 'base64').equals(current.config), true);
  assert.equal(typeof compensation.receipt.content, 'string');
  assert.doesNotMatch(JSON.stringify(compensation), new RegExp(apiKey));
  assert.deepEqual(host.meta(paths.compensation), { uid: 0, gid: 0, mode: 0o600 });

  for (const [config, receipt] of [[previous.config, current.receipt], [current.config, previous.receipt]]) {
    host.put(paths.config, config, { gid: 113, mode: 0o640 });
    host.put(paths.receipt, receipt);
    interruptRollback(host);
    const restarted = host.manager();
    const result = await restarted.rollback(intent(), rollbackRequest(await restarted.operation()));
    assert.equal(result.rollback.alreadyRestored, false);
    assert.equal(host.bytes(paths.config).equals(previous.config), true);
    assert.equal(host.bytes(paths.receipt).equals(previous.receipt), true);
  }
});

test('PowerDNS rollback requires socket policy and compensates an unhealthy restored service', async () => {
  const { host, manager, operation } = await hostWithRollbackSnapshot();
  const restarts = host.restarts.length;
  const sockets = host.socketChecks;
  host.socketResults.push({ satisfied: false, reason: 'powerdns_tcp_unavailable' });

  await assert.rejects(manager.rollback(intent(), rollbackRequest(operation)), managerError('powerdns_tcp_unavailable'));

  assert.equal(host.socketChecks, sockets + 2);
  assert.equal(host.text(paths.config), currentConfig);
  assert.equal(JSON.parse(host.text(paths.receipt)).secondaryDns[0], currentSecondaryDns[0]);
  assert.deepEqual(activations(host, restarts), ['previous', 'current']);
  const journal = host.journal();
  assert.equal(journal.status, 'rollback_failed');
  assert.equal(journal.lastError.code, 'powerdns_tcp_unavailable');
});

test('PowerDNS rollback rechecks live files after persisting compensation', async () => {
  const { host, manager, operation } = await hostWithRollbackSnapshot();
  const restarts = host.restarts.length;
  host.onRename = (_from, to) => {
    if (to === paths.compensation) host.put(paths.config, 'external-config-drift\n', { gid: 113, mode: 0o640 });
  };

  await assert.rejects(manager.rollback(intent(), rollbackRequest(operation)), managerError('powerdns_rollback_current_state_changed'));

  assert.equal(host.text(paths.config), 'external-config-drift\n');
  assert.deepEqual(activations(host, restarts), []);
  assert.equal(host.journal().status, 'rollback_failed');
});

test('PowerDNS rollback rejects a non-private persisted compensation before mutation', async () => {
  const { host, manager, operation } = await hostWithRollbackSnapshot();
  await manager.rollback(intent(), rollbackRequest(operation));
  const restored = host.bytes(paths.config);
  host.files.get(paths.compensation).mode = 0o644;
  interruptRollback(host);

  await assert.rejects(
    manager.rollback(intent(), rollbackRequest(await manager.operation())),
    managerError('powerdns_rollback_compensation_unsafe'),
  );
  assert.equal(host.bytes(paths.config).equals(restored), true);
});

test('PowerDNS rollback rejects a non-private snapshot file', async () => {
  const { host, manager, operation } = await hostWithRollbackSnapshot();
  host.files.get(paths.snapshot).mode = 0o640;

  await assert.rejects(manager.rollback(intent(), rollbackRequest(operation)), managerError('powerdns_rollback_snapshot_unsafe'));
  assert.equal(host.text(paths.config), currentConfig);
});

test('PowerDNS rollback compensates a failed previous-state activation back to the verified current state', async () => {
  const { host, manager, operation } = await hostWithRollbackSnapshot();
  const restarts = host.restarts.length;
  host.apiUnhealthyFor = (config) => config === previousConfig;

  await assert.rejects(manager.rollback(intent(), rollbackRequest(operation)), managerError('powerdns_rollback_api_unhealthy'));

  assert.equal(host.text(paths.config), currentConfig);
  assert.equal(JSON.parse(host.text(paths.receipt)).secondaryDns[0], currentSecondaryDns[0]);
  assert.deepEqual(activations(host, restarts), ['previous', 'current']);
  assert.equal(host.journal().status, 'rollback_failed');
});

test('PowerDNS rollback reports compensation failure and blocks further apply', async () => {
  const { host, manager, operation } = await hostWithRollbackSnapshot();
  const restarts = host.restarts.length;
  host.onRename = (_from, to) => {
    if (to === paths.compensation) host.apiUnhealthyFor = () => true;
  };

  await assert.rejects(manager.rollback(intent(), rollbackRequest(operation)), managerError('powerdns_rollback_compensation_failed'));

  assert.equal(host.text(paths.config), currentConfig);
  assert.deepEqual(activations(host, restarts), ['previous', 'current']);
  const failed = await manager.operation();
  assert.equal(failed.status, 'rollback_failed');
  assert.equal(failed.failure.code, 'powerdns_rollback_compensation_failed');
  assert.equal(failed.rollback.status, 'failed');
  await assert.rejects(manager.apply(intent()), managerError('powerdns_rollback_recovery_pending'));
});

test('PowerDNS rollback refuses to overwrite unverified current drift', async () => {
  const { host, manager, operation } = await hostWithRollbackSnapshot();
  const restarts = host.restarts.length;
  host.put(paths.config, 'manual-current-drift\n', { gid: 113, mode: 0o640 });

  await assert.rejects(manager.rollback(intent(), rollbackRequest(operation)), managerError('powerdns_rollback_current_state_unverified'));

  assert.equal(host.text(paths.config), 'manual-current-drift\n');
  assert.deepEqual(activations(host, restarts), []);
  assert.equal(host.files.has(paths.compensation), false);
});
