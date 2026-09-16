import assert from 'node:assert/strict';
import test from 'node:test';
import { createDnsZoneDnssecService } from '../src/dns-zone-dnssec.js';

const domainId = '8bc307db-9e2d-4c3f-91ea-49e740d259a9';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const apiKey = 'a'.repeat(43);

function serviceWith(authoritative) {
  return createDnsZoneDnssecService({
    domainRegistry: {
      getDomain: async () => ({
        id: domainId,
        serverId,
        primaryDomain: 'example.com',
        parentDomainId: null,
      }),
    },
    powerDnsSecretRegistry: {
      materializeForServer: async () => ({ serverId, revision: 1, apiKey }),
    },
    localServerId: serverId,
    manager: {
      inspect: async () => authoritative,
      enable: async () => { throw new Error('must not mutate'); },
      disable: async () => { throw new Error('must not mutate'); },
    },
    parentDsInspector: {
      inspect: async () => ({
        version: 2,
        domain: 'example.com',
        status: 'absent',
        records: [],
        nameservers: ['a.gtld-servers.net'],
        errorCode: null,
        checkedAt: '2026-09-16T00:55:00.000Z',
      }),
    },
  });
}

test('dnssec=true without active signing material is not reported ready or publishable', async () => {
  const service = serviceWith({
    adapter: 'powerdns-authoritative-api',
    zoneName: 'example.com',
    dnssec: true,
    serial: 2026091601,
    keys: [],
    ds: [],
    keyCount: 0,
    activeKeyCount: 0,
    ready: false,
  });

  const status = await service.status({ domainId });
  assert.equal(status.dnssec, true);
  assert.equal(status.localReady, false);
  assert.equal(status.status, 'signing_material_incomplete');
  assert.equal(status.secureReady, false);
  assert.deepEqual(status.registrar.addDs, []);

  const preview = await service.preview({ domainId, enabled: true });
  assert.equal(preview.noChanges, false);
  assert.equal(preview.applyAllowed, false);
  assert.equal(preview.confirmation, null);
  assert.equal(preview.blockers.some((entry) => entry.code === 'dnssec_signing_material_incomplete'), true);
});
