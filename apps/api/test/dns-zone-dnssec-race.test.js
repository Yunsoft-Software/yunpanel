import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDnsZoneDnssecService,
  DnsZoneDnssecError,
} from '../src/dns-zone-dnssec.js';

const domainId = '8bc307db-9e2d-4c3f-91ea-49e740d259a9';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const apiKey = 'a'.repeat(43);
const ds = '12345 13 2 AABBCCDD';

function authoritative(dnssec) {
  return {
    zoneName: 'example.com',
    dnssec,
    serial: 2026091601,
    keys: dnssec ? [{ id: 1, keyType: 'csk', active: true, published: true, dnskey: '257 3 13 AAAA', ds: [ds], cds: [ds], algorithm: 'ECDSAP256SHA256', bits: 256 }] : [],
    ds: dnssec ? [ds] : [],
    keyCount: dnssec ? 1 : 0,
    activeKeyCount: dnssec ? 1 : 0,
    ready: dnssec,
  };
}

function parent(status, records = []) {
  return {
    domain: 'example.com',
    status,
    records,
    errorCode: null,
    checkedAt: '2026-09-16T00:30:00.000Z',
  };
}

function serviceWith({ current, parents }) {
  let parentIndex = 0;
  let disableCalls = 0;
  const service = createDnsZoneDnssecService({
    domainRegistry: {
      getDomain: async () => ({ id: domainId, serverId, primaryDomain: 'example.com', parentDomainId: null }),
    },
    powerDnsSecretRegistry: {
      materializeForServer: async () => ({ serverId, revision: 1, apiKey }),
    },
    localServerId: serverId,
    manager: {
      inspect: async () => current,
      enable: async () => authoritative(true),
      disable: async () => { disableCalls += 1; return authoritative(false); },
    },
    parentDsInspector: {
      inspect: async () => {
        const value = parents[Math.min(parentIndex, parents.length - 1)];
        parentIndex += 1;
        return value;
      },
    },
  });
  return { service, disableCalls: () => disableCalls };
}

test('DNSSEC disable stops if parent DS reappears after an allowed preview', async () => {
  const { service, disableCalls } = serviceWith({
    current: authoritative(true),
    parents: [parent('absent'), parent('absent'), parent('present', [ds])],
  });
  const preview = await service.preview({ domainId, enabled: false });
  assert.equal(preview.applyAllowed, true);

  await assert.rejects(
    service.apply({
      domainId,
      enabled: false,
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    }),
    (error) => error instanceof DnsZoneDnssecError && error.code === 'dnssec_parent_state_changed',
  );
  assert.equal(disableCalls(), 0);
});

test('DNSSEC enable blocks stale parent DS that cannot match local signing material', async () => {
  const { service } = serviceWith({
    current: authoritative(false),
    parents: [parent('present', ['54321 13 2 DDEEFF00'])],
  });
  const preview = await service.preview({ domainId, enabled: true });

  assert.equal(preview.applyAllowed, false);
  assert.equal(preview.confirmation, null);
  assert.equal(preview.blockers.some((entry) => entry.code === 'stale_parent_ds_before_enable'), true);
});
