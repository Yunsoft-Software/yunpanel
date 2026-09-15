import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createServerDnsIdentityRegistry,
  ServerDnsIdentityRegistryError,
} from '../src/server-dns-identity-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';

function settings(overrides = {}) {
  return {
    publicIpv4: '203.0.113.20',
    publicIpv6: '2001:db8::20',
    ns1: { hostname: 'ns1.example.test', ipv4: '203.0.113.20', ipv6: '2001:db8::20', local: true },
    ns2: { hostname: 'ns2.example.test', ipv4: '203.0.113.21', ipv6: '2001:db8::21', local: false },
    soa: { rname: 'hostmaster.example.test', refresh: 3600, retry: 900, expire: 1209600, minimum: 300, ttl: 300 },
    dnssecDefault: true,
    secondaryDns: ['203.0.113.21'],
    ...overrides,
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-dns-identity-'));
  const filePath = path.join(root, 'dns-identity.json');
  const registry = createServerDnsIdentityRegistry({
    filePath,
    now: () => Date.parse('2026-09-15T04:20:00.000+03:00'),
    serverExists: async (id) => id === serverId,
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  await registry.init();
  return { filePath, registry };
}

test('DNS identity preview is revisioned and update requires exact digest confirmation', async (t) => {
  const { filePath, registry } = await fixture(t);
  const preview = await registry.preview({ serverId, settings: settings() });

  assert.equal(preview.currentRevision, 0);
  assert.equal(preview.nextRevision, 1);
  assert.equal(preview.settings.soa.primaryNs, 'ns1.example.test');
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(preview.confirmation, `update-server-dns:${serverId}:0:${preview.previewDigest}`);
  assert.equal(preview.impact.existingZoneSyncAutomatic, false);
  assert.equal(preview.impact.delegationMayChange, true);

  await assert.rejects(
    registry.update({ serverId, expectedRevision: 0, settings: settings(), previewDigest: preview.previewDigest, confirmation: 'wrong' }),
    (error) => error instanceof ServerDnsIdentityRegistryError && error.code === 'dns_identity_preview_stale',
  );

  const saved = await registry.update({
    serverId,
    expectedRevision: 0,
    settings: settings(),
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.equal(saved.revision, 1);
  assert.equal(saved.settings.publicIpv4, '203.0.113.20');
  assert.equal(saved.settings.ns2.local, false);
  assert.deepEqual(saved.settings.secondaryDns, ['203.0.113.21']);

  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.records[0].revision, 1);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});

test('same-host ns1/ns2 is accepted but explicitly warns about missing redundancy', async (t) => {
  const { registry } = await fixture(t);
  const preview = await registry.preview({
    serverId,
    settings: settings({
      ns2: { hostname: 'ns2.example.test', ipv4: '203.0.113.20', ipv6: '2001:db8::20', local: true },
      secondaryDns: [],
    }),
  });
  assert.equal(preview.warnings.some((entry) => entry.code === 'dns_nameserver_redundancy_missing'), true);
});

test('external ns2 without transfer target is visible as a warning instead of fake healthy redundancy', async (t) => {
  const { registry } = await fixture(t);
  const preview = await registry.preview({ serverId, settings: settings({ secondaryDns: [] }) });
  assert.equal(preview.warnings.some((entry) => entry.code === 'dns_secondary_transfer_target_missing'), true);
});

test('DNS identity rejects noncanonical names, invalid addresses and duplicate NS names', async (t) => {
  const { registry } = await fixture(t);
  const invalid = [
    settings({ ns1: { hostname: 'NS1.Example.Test', ipv4: '203.0.113.20', ipv6: null, local: true } }),
    settings({ publicIpv4: '999.1.1.1' }),
    settings({ ns2: { hostname: 'ns1.example.test', ipv4: '203.0.113.21', ipv6: null, local: false } }),
  ];
  for (const value of invalid) {
    await assert.rejects(
      registry.preview({ serverId, settings: value }),
      (error) => error instanceof ServerDnsIdentityRegistryError,
    );
  }
});

test('DNS identity detects stale revision and no-op updates', async (t) => {
  const { registry } = await fixture(t);
  const first = await registry.preview({ serverId, settings: settings() });
  await registry.update({ serverId, expectedRevision: 0, settings: settings(), previewDigest: first.previewDigest, confirmation: first.confirmation });

  await assert.rejects(
    registry.preview({ serverId, settings: settings() }),
    (error) => error instanceof ServerDnsIdentityRegistryError && error.code === 'dns_identity_no_changes',
  );

  const nextSettings = settings({ dnssecDefault: false });
  const next = await registry.preview({ serverId, settings: nextSettings });
  await assert.rejects(
    registry.update({ serverId, expectedRevision: 0, settings: nextSettings, previewDigest: next.previewDigest, confirmation: next.confirmation }),
    (error) => error instanceof ServerDnsIdentityRegistryError && error.code === 'dns_identity_revision_conflict',
  );
});
