import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDnsZoneSecondaryStatusService,
  dnsZoneSecondaryHealthPolicy,
  DnsZoneSecondaryStatusError,
} from '../src/dns-zone-secondary-status.js';

const domainId = '8bc307db-9e2d-4c3f-91ea-49e740d259a9';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const apiKey = 'a'.repeat(43);

function service({ targets = ['203.0.113.20'], kind = 'Primary', serial = 2026091603, notifiedSerial = 2026091603, sync = null } = {}) {
  const calls = [];
  return {
    calls,
    service: createDnsZoneSecondaryStatusService({
      domainRegistry: {
        getDomain: async (id) => id === domainId ? { id: domainId, serverId, primaryDomain: 'example.com', parentDomainId: null } : null,
      },
      dnsIdentityRegistry: {
        getForServer: async () => ({ serverId, revision: 7, settings: { secondaryDns: targets } }),
      },
      powerDnsSecretRegistry: {
        materializeForServer: async () => ({ serverId, revision: 1, apiKey }),
      },
      localServerId: serverId,
      zoneManager: {
        getZone: async (zoneName, key) => {
          calls.push(['zone', zoneName, key]);
          return { zoneName, kind, serial, notifiedSerial, dnssec: false, rrsets: [] };
        },
      },
      secondaryInspector: {
        inspect: async (input) => {
          calls.push(['sync', input]);
          return sync ?? {
            version: 1,
            zoneName: input.zoneName,
            status: 'synced',
            ready: true,
            expectedSerial: input.expectedSerial,
            targets: input.targets.map((target) => ({ target, status: 'synced', ready: true, expectedSerial: input.expectedSerial, observedSerial: input.expectedSerial, errorCode: null })),
            checkedAt: '2026-09-16T02:00:00.000Z',
          };
        },
      },
    }),
  };
}

test('secondary DNS status separates PowerDNS notify evidence from observed secondary serial sync', async () => {
  const fx = service();
  const result = await fx.service.status({ domainId });
  assert.equal(result.configured, true);
  assert.equal(result.ready, true);
  assert.equal(result.status, 'synced');
  assert.equal(result.zoneKind, 'Primary');
  assert.deepEqual(result.notify, { serial: 2026091603, notifiedSerial: 2026091603, currentSerialNotified: true });
  assert.deepEqual(result.policy, { healthGate: 'pass', severity: 'healthy', recovery: 'none', automaticMutationAllowed: false });
  assert.equal(result.sync.targets[0].observedSerial, 2026091603);
  assert.deepEqual(fx.calls[1][1], { zoneName: 'example.com', expectedSerial: 2026091603, targets: ['203.0.113.20'] });
});

test('secondary DNS status does not call PowerDNS or dig when no secondary target is configured', async () => {
  const fx = service({ targets: [] });
  const result = await fx.service.status({ domainId });
  assert.equal(result.status, 'disabled');
  assert.equal(result.configured, false);
  assert.equal(result.ready, true);
  assert.deepEqual(result.policy, { healthGate: 'not_applicable', severity: 'info', recovery: 'none', automaticMutationAllowed: false });
  assert.deepEqual(fx.calls, []);
});

test('secondary DNS status flags legacy Native zones instead of claiming transfer readiness', async () => {
  const fx = service({ kind: 'Native' });
  const result = await fx.service.status({ domainId });
  assert.equal(result.ready, false);
  assert.equal(result.status, 'primary_kind_required');
  assert.equal(result.sync.status, 'synced');
  assert.deepEqual(result.policy, { healthGate: 'block', severity: 'error', recovery: 'manual_intervention', automaticMutationAllowed: false });
});

test('secondary DNS status preserves stale/unverifiable target evidence', async () => {
  const fx = service({
    notifiedSerial: 2026091602,
    sync: {
      version: 1,
      zoneName: 'example.com',
      status: 'drift',
      ready: false,
      expectedSerial: 2026091603,
      targets: [{ target: '203.0.113.20', status: 'stale', ready: false, expectedSerial: 2026091603, observedSerial: 2026091602, errorCode: null }],
      checkedAt: '2026-09-16T02:01:00.000Z',
    },
  });
  const result = await fx.service.status({ domainId });
  assert.equal(result.ready, false);
  assert.equal(result.status, 'drift');
  assert.equal(result.notify.currentSerialNotified, false);
  assert.equal(result.sync.targets[0].status, 'stale');
  assert.deepEqual(result.policy, { healthGate: 'block', severity: 'warning', recovery: 'observe_only', automaticMutationAllowed: false });
});

test('secondary DNS health policy escalates ahead serials without authorizing automatic mutation', () => {
  const policy = dnsZoneSecondaryHealthPolicy({
    configured: true,
    status: 'drift',
    ready: false,
    sync: { targets: [{ status: 'ahead' }] },
  });
  assert.deepEqual(policy, { healthGate: 'block', severity: 'error', recovery: 'observe_only', automaticMutationAllowed: false });
});

test('secondary DNS status enforces root local Domain ownership', async () => {
  const serviceInstance = createDnsZoneSecondaryStatusService({
    domainRegistry: { getDomain: async () => ({ id: domainId, serverId, primaryDomain: 'sub.example.com', parentDomainId: '759bb4fa-ecea-4e2d-8df4-3bf20ac41980' }) },
    dnsIdentityRegistry: { getForServer: async () => ({ serverId, revision: 1, settings: { secondaryDns: [] } }) },
    powerDnsSecretRegistry: { materializeForServer: async () => ({ serverId, apiKey }) },
    localServerId: serverId,
    zoneManager: { getZone: async () => null },
    secondaryInspector: { inspect: async () => ({}) },
  });
  await assert.rejects(
    serviceInstance.status({ domainId }),
    (error) => error instanceof DnsZoneSecondaryStatusError && error.code === 'dns_secondary_root_domain_required',
  );
});
