import assert from 'node:assert/strict';
import test from 'node:test';
import { DnsZoneTemplateRegistryError } from '../src/dns-zone-template-registry.js';
import { createDnsZoneTemplateRollbackService } from '../src/dns-zone-template-rollback.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const targetRecords = Object.freeze([
  Object.freeze({ key: 'apex-ipv4', owner: '@', type: 'A', ttl: null, values: Object.freeze(['<server-ipv4>']), condition: 'always' }),
]);

function fixture({ targetExists = true, currentVersion = 3 } = {}) {
  const calls = [];
  const registry = {
    ensureForServer: async (id) => {
      calls.push(['ensure', id]);
      return { serverId: id, version: currentVersion, records: [] };
    },
    getVersion: async (id, version) => {
      calls.push(['getVersion', id, version]);
      return targetExists ? {
        serverId: id,
        schemaVersion: 1,
        version,
        records: targetRecords,
        createdAt: '2026-09-14T00:00:00.000Z',
      } : null;
    },
    preview: async (input) => {
      calls.push(['preview', input]);
      return {
        serverId: input.serverId,
        currentVersion: input.expectedVersion,
        nextVersion: input.expectedVersion + 1,
        records: input.records,
        previewDigest: 'a'.repeat(64),
        confirmation: 'apply-dns-zone-template:base',
        existingZonesAutomaticApply: false,
      };
    },
    update: async (input) => {
      calls.push(['update', input]);
      return {
        serverId: input.serverId,
        schemaVersion: 1,
        version: input.expectedVersion + 1,
        records: input.records,
        createdAt: '2026-09-15T06:50:00.000Z',
        updatedAt: '2026-09-15T06:50:00.000Z',
      };
    },
  };
  return { calls, service: createDnsZoneTemplateRollbackService({ registry }) };
}

test('DNS zone template rollback previews a historical version as a new version', async () => {
  const { service } = fixture();
  const preview = await service.preview({ serverId, expectedVersion: 3, targetVersion: 1 });

  assert.equal(preview.currentVersion, 3);
  assert.equal(preview.targetVersion, 1);
  assert.equal(preview.nextVersion, 4);
  assert.deepEqual(preview.records, targetRecords);
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    preview.confirmation,
    `rollback-dns-zone-template:${serverId}:3:1:${preview.previewDigest}`,
  );
  assert.equal(preview.existingZonesAutomaticApply, false);
});

test('DNS zone template rollback applies target records through normal versioned update', async () => {
  const { calls, service } = fixture();
  const preview = await service.preview({ serverId, expectedVersion: 3, targetVersion: 1 });
  const updated = await service.apply({
    serverId,
    expectedVersion: 3,
    targetVersion: 1,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });

  assert.equal(updated.version, 4);
  assert.deepEqual(updated.rollback, { fromVersion: 3, targetVersion: 1, createdVersion: 4 });
  const updateCall = calls.find((entry) => entry[0] === 'update');
  assert.deepEqual(updateCall, ['update', {
    serverId,
    expectedVersion: 3,
    records: targetRecords,
    previewDigest: 'a'.repeat(64),
    confirmation: 'apply-dns-zone-template:base',
  }]);
});

test('DNS zone template rollback fails closed when current version changed', async () => {
  const { service } = fixture({ currentVersion: 4 });
  await assert.rejects(
    service.preview({ serverId, expectedVersion: 3, targetVersion: 1 }),
    (error) => error instanceof DnsZoneTemplateRegistryError
      && error.code === 'dns_template_revision_conflict'
      && error.status === 409,
  );
});

test('DNS zone template rollback rejects missing history and stale confirmation', async () => {
  const missing = fixture({ targetExists: false }).service;
  await assert.rejects(
    missing.preview({ serverId, expectedVersion: 3, targetVersion: 1 }),
    (error) => error instanceof DnsZoneTemplateRegistryError
      && error.code === 'dns_template_version_not_found'
      && error.status === 404,
  );

  const { calls, service } = fixture();
  const preview = await service.preview({ serverId, expectedVersion: 3, targetVersion: 1 });
  await assert.rejects(
    service.apply({
      serverId,
      expectedVersion: 3,
      targetVersion: 1,
      previewDigest: preview.previewDigest,
      confirmation: 'wrong',
    }),
    (error) => error instanceof DnsZoneTemplateRegistryError
      && error.code === 'dns_template_rollback_confirmation_invalid'
      && error.status === 409,
  );
  assert.equal(calls.some((entry) => entry[0] === 'update'), false);
});
