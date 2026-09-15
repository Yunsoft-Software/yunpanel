import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDnsZoneTemplateRegistry,
  dnsZoneTemplateInternals,
  DnsZoneTemplateRegistryError,
} from '../src/dns-zone-template-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';

function cloneDefaults() {
  return dnsZoneTemplateInternals.defaultRecords.map((entry) => ({
    ...entry,
    values: [...entry.values],
  }));
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-dns-template-'));
  const filePath = path.join(root, 'dns-zone-template.json');
  const registry = createDnsZoneTemplateRegistry({
    filePath,
    now: () => Date.parse('2026-09-15T05:20:00.000+03:00'),
    serverExists: async (id) => id === serverId,
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  await registry.init();
  return { filePath, registry };
}

test('DNS zone template creates a versioned core template with nameservers in one RRset', async (t) => {
  const { filePath, registry } = await fixture(t);
  const template = await registry.ensureForServer(serverId);

  assert.equal(template.version, 1);
  assert.deepEqual(template.records.find((entry) => entry.key === 'apex-nameservers')?.values, ['<ns1>', '<ns2>']);
  assert.deepEqual(template.records.map((entry) => entry.type), ['NS', 'A', 'AAAA', 'CNAME']);

  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(persisted.servers[0].currentVersion, 1);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});

test('DNS zone template accepts and normalizes MX, TXT, CAA and SRV records', async (t) => {
  const { registry } = await fixture(t);
  const current = await registry.ensureForServer(serverId);
  const records = [
    ...cloneDefaults(),
    { key: 'mail-exchanger', owner: '@', type: 'MX', ttl: 300, values: ['0010   <mail-host>'], condition: 'always' },
    { key: 'apex-spf', owner: '@', type: 'TXT', ttl: 300, values: ['v=spf1 a mx -all'], condition: 'always' },
    { key: 'apex-caa', owner: '@', type: 'CAA', ttl: 300, values: ['000 ISSUE letsencrypt.org'], condition: 'always' },
    { key: 'submission-service', owner: '_submission._tcp', type: 'SRV', ttl: 300, values: ['000 001 00587 <mail-host>'], condition: 'always' },
  ];
  const preview = await registry.preview({ serverId, expectedVersion: current.version, records });

  assert.equal(preview.existingZonesAutomaticApply, false);
  assert.deepEqual(preview.records.find((entry) => entry.type === 'MX')?.values, ['10 <mail-host>']);
  assert.deepEqual(preview.records.find((entry) => entry.type === 'TXT')?.values, ['v=spf1 a mx -all']);
  assert.deepEqual(preview.records.find((entry) => entry.type === 'CAA')?.values, ['0 issue letsencrypt.org']);
  assert.deepEqual(preview.records.find((entry) => entry.type === 'SRV')?.values, ['0 1 587 <mail-host>']);

  const saved = await registry.update({
    serverId,
    expectedVersion: current.version,
    records,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.equal(saved.version, 2);
  assert.equal((await registry.getVersion(serverId, 1))?.version, 1);
  assert.equal((await registry.getVersion(serverId, 2))?.version, 2);
});

test('DNS zone template rejects invalid MX, CAA and SRV numeric fields', async (t) => {
  const { registry } = await fixture(t);
  const current = await registry.ensureForServer(serverId);
  const invalidRecords = [
    { key: 'mail-exchanger', owner: '@', type: 'MX', ttl: 300, values: ['65536 <mail-host>'], condition: 'always' },
    { key: 'apex-caa', owner: '@', type: 'CAA', ttl: 300, values: ['256 issue letsencrypt.org'], condition: 'always' },
    { key: 'submission-service', owner: '_submission._tcp', type: 'SRV', ttl: 300, values: ['0 1 70000 <mail-host>'], condition: 'always' },
  ];

  for (const record of invalidRecords) {
    await assert.rejects(
      registry.preview({ serverId, expectedVersion: current.version, records: [...cloneDefaults(), record] }),
      (error) => error instanceof DnsZoneTemplateRegistryError && error.code === 'invalid_dns_template_record',
    );
  }
});

test('DNS zone template keeps CNAME coexistence fail-closed', async (t) => {
  const { registry } = await fixture(t);
  const current = await registry.ensureForServer(serverId);
  const records = [
    ...cloneDefaults(),
    { key: 'www-text', owner: 'www', type: 'TXT', ttl: 300, values: ['invalid alongside cname'], condition: 'always' },
  ];

  await assert.rejects(
    registry.preview({ serverId, expectedVersion: current.version, records }),
    (error) => error instanceof DnsZoneTemplateRegistryError && error.code === 'invalid_dns_template_records',
  );
});

test('DNS zone template update requires the exact preview confirmation', async (t) => {
  const { registry } = await fixture(t);
  const current = await registry.ensureForServer(serverId);
  const records = [
    ...cloneDefaults(),
    { key: 'apex-spf', owner: '@', type: 'TXT', ttl: 300, values: ['v=spf1 -all'], condition: 'always' },
  ];
  const preview = await registry.preview({ serverId, expectedVersion: current.version, records });

  await assert.rejects(
    registry.update({
      serverId,
      expectedVersion: current.version,
      records,
      previewDigest: preview.previewDigest,
      confirmation: 'wrong',
    }),
    (error) => error instanceof DnsZoneTemplateRegistryError && error.code === 'dns_template_confirmation_invalid',
  );
});
