import assert from 'node:assert/strict';
import test from 'node:test';
import { createPowerDnsAuthoritativeReadyManager } from '../src/powerdns-authoritative-ready-manager.js';
import { PowerDnsAuthoritativeManagerError } from '../src/powerdns-authoritative-manager.js';

function base({ satisfied = true } = {}) {
  const calls = [];
  return {
    calls,
    manager: {
      async inspect(intent) { calls.push(['inspect', intent]); return { satisfied, adapter: 'powerdns-authoritative-gsqlite3' }; },
      async apply(intent) { calls.push(['apply', intent]); return { satisfied, adapter: 'powerdns-authoritative-gsqlite3' }; },
      async operation() { calls.push(['operation']); return { id: 'operation-1', status: 'applying' }; },
      async resolve(intent, recovery) { calls.push(['resolve', intent, recovery]); return { satisfied, adapter: 'powerdns-authoritative-gsqlite3' }; },
    },
  };
}

function sockets({ satisfied = true, reason = 'powerdns_udp_unavailable' } = {}) {
  const calls = [];
  return {
    calls,
    inspector: {
      async inspect() {
        calls.push('inspect');
        return satisfied
          ? { satisfied: true, udp53: true, tcp53: true, recursive: false }
          : { satisfied: false, reason };
      },
    },
  };
}

test('PowerDNS inspect includes DNS socket evidence only after base readiness passes', async () => {
  const runtime = base();
  const health = sockets();
  const manager = createPowerDnsAuthoritativeReadyManager({ manager: runtime.manager, socketInspector: health.inspector });
  const intent = { serverId: 'server-1' };

  const result = await manager.inspect(intent);
  assert.equal(result.satisfied, true);
  assert.equal(result.sockets.udp53, true);
  assert.equal(result.sockets.tcp53, true);
  assert.equal(result.sockets.recursive, false);
  assert.deepEqual(runtime.calls, [['inspect', intent]]);
  assert.deepEqual(health.calls, ['inspect']);
});

test('PowerDNS operation status passes through without probing service sockets', async () => {
  const runtime = base();
  const health = sockets();
  const manager = createPowerDnsAuthoritativeReadyManager({ manager: runtime.manager, socketInspector: health.inspector });

  assert.deepEqual(await manager.operation(), { id: 'operation-1', status: 'applying' });
  assert.deepEqual(runtime.calls, [['operation']]);
  assert.deepEqual(health.calls, []);
});

test('PowerDNS recovery resolution adds socket evidence without applying host mutation', async () => {
  const runtime = base();
  const health = sockets();
  const manager = createPowerDnsAuthoritativeReadyManager({ manager: runtime.manager, socketInspector: health.inspector });
  const intent = { serverId: 'server-1' };
  const recovery = { operationId: 'operation-1', expectedUpdatedAt: '2026-09-17T12:00:00.000Z' };

  const result = await manager.resolve(intent, recovery);
  assert.equal(result.satisfied, true);
  assert.equal(result.sockets.udp53, true);
  assert.deepEqual(runtime.calls, [['resolve', intent, recovery]]);
  assert.deepEqual(health.calls, ['inspect']);
});

test('PowerDNS inspect does not probe sockets while base service is not ready', async () => {
  const runtime = base({ satisfied: false });
  const health = sockets();
  const manager = createPowerDnsAuthoritativeReadyManager({ manager: runtime.manager, socketInspector: health.inspector });

  const result = await manager.inspect({});
  assert.equal(result.satisfied, false);
  assert.deepEqual(health.calls, []);
});

test('PowerDNS inspect reports socket policy failure as not ready', async () => {
  const runtime = base();
  const health = sockets({ satisfied: false, reason: 'powerdns_recursion_policy_invalid' });
  const manager = createPowerDnsAuthoritativeReadyManager({ manager: runtime.manager, socketInspector: health.inspector });

  const result = await manager.inspect({});
  assert.equal(result.satisfied, false);
  assert.equal(result.reason, 'powerdns_recursion_policy_invalid');
  assert.equal(result.sockets.satisfied, false);
});

test('PowerDNS apply fails closed when UDP/TCP/recursion evidence is unhealthy', async () => {
  const runtime = base();
  const health = sockets({ satisfied: false, reason: 'powerdns_tcp_unavailable' });
  const manager = createPowerDnsAuthoritativeReadyManager({ manager: runtime.manager, socketInspector: health.inspector });

  await assert.rejects(
    manager.apply({}),
    (error) => error instanceof PowerDnsAuthoritativeManagerError && error.code === 'powerdns_tcp_unavailable',
  );
});
