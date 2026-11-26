import assert from 'node:assert/strict';
import test from 'node:test';
import { PowerDnsAuthoritativeManagerError } from '../src/powerdns-authoritative-manager.js';
import { createFakeHost, hostWithRollbackSnapshot, intent, rollbackRequest } from './powerdns-fake-host.js';

function managerError(code) {
  return (error) => error instanceof PowerDnsAuthoritativeManagerError && error.code === code;
}

async function appliedHost() {
  const host = createFakeHost();
  const manager = host.manager();
  await manager.apply(intent());
  return { host, manager, checks: host.socketChecks };
}

test('PowerDNS inspect includes DNS socket evidence only after host readiness passes', async () => {
  const { host, manager, checks } = await appliedHost();

  const result = await manager.inspect(intent());

  assert.equal(result.satisfied, true);
  assert.equal(result.sockets.udp53, true);
  assert.equal(result.sockets.tcp53, true);
  assert.equal(result.sockets.recursive, false);
  assert.equal(host.socketChecks, checks + 1);
});

test('PowerDNS inspect does not probe sockets while the host is not ready', async () => {
  const host = createFakeHost();

  const result = await host.manager().inspect(intent());

  assert.equal(result.satisfied, false);
  assert.equal(result.reason, 'powerdns_config_missing');
  assert.equal(host.socketChecks, 0);
});

test('PowerDNS inspect reports socket policy failure as not ready', async () => {
  const { host, manager } = await appliedHost();
  host.socketResults.push({ satisfied: false, reason: 'powerdns_recursion_policy_invalid' });

  const result = await manager.inspect(intent());

  assert.equal(result.satisfied, false);
  assert.equal(result.reason, 'powerdns_recursion_policy_invalid');
  assert.equal(result.sockets.satisfied, false);
});

test('PowerDNS inspect fails closed on invalid socket evidence', async () => {
  const { host, manager } = await appliedHost();
  host.socketResults.push(null);

  await assert.rejects(manager.inspect(intent()), managerError('powerdns_socket_health_invalid'));
});

test('PowerDNS operation status does not probe service sockets', async () => {
  const { host, manager, checks } = await appliedHost();

  assert.equal((await manager.operation()).status, 'succeeded');
  assert.equal(host.socketChecks, checks);
});

test('PowerDNS apply fails closed when UDP/TCP/recursion evidence is unhealthy', async () => {
  const host = createFakeHost();
  host.socketResults.push({ satisfied: false, reason: 'powerdns_tcp_unavailable' });

  await assert.rejects(host.manager().apply(intent()), managerError('powerdns_tcp_unavailable'));
  assert.equal(host.socketChecks, 1);
});

test('PowerDNS apply of an already converged host still requires healthy sockets', async () => {
  const { host, manager } = await appliedHost();
  host.socketResults.push({ satisfied: false });

  await assert.rejects(manager.apply(intent()), managerError('powerdns_socket_unhealthy'));
});

test('PowerDNS explicit retry requires healthy socket evidence after the replayed apply', async () => {
  const host = createFakeHost();
  const manager = host.manager();
  host.failActivations = 1;
  await assert.rejects(manager.apply(intent()), managerError('powerdns_apply_outcome_uncertain'));
  const operation = await manager.operation();
  host.socketResults.push({ satisfied: false, reason: 'powerdns_udp_unavailable' });

  await assert.rejects(
    manager.retry(intent(), { operationId: operation.id, expectedUpdatedAt: operation.updatedAt }),
    managerError('powerdns_udp_unavailable'),
  );
  assert.equal((await manager.operation()).status, 'succeeded');
});

test('PowerDNS rollback verifies sockets once inside the restore and reuses that evidence', async () => {
  const { host, manager, operation } = await hostWithRollbackSnapshot();
  const checks = host.socketChecks;

  const result = await manager.rollback(intent(), rollbackRequest(operation));

  assert.equal(result.sockets.recursive, false);
  assert.equal(host.socketChecks, checks + 1);
});
