import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAcmeManager } from '@yunpanel/host-runtime';
import { createCertificateMaterialManager } from '../src/certificates/certificate-material-manager.js';
import {
  CertificateMaterialGcError,
  createCertificateMaterialGc,
  DEFAULT_CERTIFICATE_RETENTION_DAYS,
} from '../src/certificates/certificate-material-gc.js';

function createMockCertificateRegistry(certificates) {
  const certs = certificates.map((c) => ({ ...c }));
  return {
    async listCertificates() {
      return certs.map((c) => ({ ...c }));
    },
    async getCertificate(id) {
      const found = certs.find((c) => c.id === id);
      return found ? { ...found } : null;
    },
    async markMaterialPurged(id, { purgedAt }) {
      const found = certs.find((c) => c.id === id);
      if (!found) throw new Error('not found');
      if (found.state !== 'retired') throw new Error('not retired');
      if (found.materialPurgedAt !== null) {
        return { changed: false, certificate: { ...found } };
      }
      found.materialPurgedAt = purgedAt;
      found.updatedAt = purgedAt;
      return { changed: true, certificate: { ...found } };
    },
  };
}

function createMockDomainRegistry(domains = []) {
  return {
    async listDomains() {
      return domains.map((d) => ({ ...d }));
    },
  };
}

test('certificate GC rejects invalid configuration', () => {
  assert.throws(
    () => createCertificateMaterialGc({}),
    (err) => err instanceof CertificateMaterialGcError && err.code === 'invalid_certificate_registry',
  );
  assert.throws(
    () => createCertificateMaterialGc({
      certificateRegistry: { listCertificates: async () => [], markMaterialPurged: async () => {} },
      certificateMaterialManager: null,
    }),
    (err) => err instanceof CertificateMaterialGcError && err.code === 'invalid_certificate_material_manager',
  );
  assert.throws(
    () => createCertificateMaterialGc({
      certificateRegistry: { listCertificates: async () => [], markMaterialPurged: async () => {} },
      certificateMaterialManager: { removeCustom: async () => true },
      defaultRetentionDays: -1,
    }),
    (err) => err instanceof CertificateMaterialGcError && err.code === 'invalid_retention_days',
  );
});

test('inspectGcCandidates respects retention window (30 days default)', async () => {
  const now = Date.parse('2026-10-30T00:00:00.000Z');
  const retiredRecent = {
    id: 'cert-recent',
    domainId: 'd-1',
    serverId: 's-1',
    certName: 'recent.example.com',
    source: 'custom',
    purpose: 'web',
    state: 'retired',
    retiredAt: '2026-10-15T00:00:00.000Z', // 15 days ago -> retained
    materialPurgedAt: null,
    materialDigest: 'digest-1',
    certificatePath: '/custom/cert-recent/cert.pem',
    fullchainPath: '/custom/cert-recent/fullchain.pem',
    privateKeyPath: '/custom/cert-recent/privkey.pem',
  };
  const retiredOld = {
    id: 'cert-old',
    domainId: 'd-2',
    serverId: 's-1',
    certName: 'old.example.com',
    source: 'custom',
    purpose: 'web',
    state: 'retired',
    retiredAt: '2026-09-01T00:00:00.000Z', // 59 days ago -> eligible
    materialPurgedAt: null,
    materialDigest: 'digest-2',
    certificatePath: '/custom/cert-old/cert.pem',
    fullchainPath: '/custom/cert-old/fullchain.pem',
    privateKeyPath: '/custom/cert-old/privkey.pem',
  };

  const certificateRegistry = createMockCertificateRegistry([retiredRecent, retiredOld]);
  const gc = createCertificateMaterialGc({
    certificateRegistry,
    certificateMaterialManager: { removeCustom: async () => true },
    now: () => now,
  });

  const inspection = await gc.inspectGcCandidates();
  assert.equal(inspection.totalCertificates, 2);
  assert.equal(inspection.eligibleCount, 1);
  assert.equal(inspection.retainedCount, 1);
  assert.equal(inspection.eligible[0].id, 'cert-old');
  assert.equal(inspection.retained[0].id, 'cert-recent');
  assert.equal(inspection.retained[0].reason, 'retention_window_active');
});

test('inspectGcCandidates protects materials shared with active certificates or domains', async () => {
  const now = Date.parse('2026-10-30T00:00:00.000Z');
  const activeCert = {
    id: 'cert-active',
    domainId: 'd-active',
    serverId: 's-1',
    certName: 'shared.example.com',
    source: 'acme',
    purpose: 'web',
    state: 'active',
    retiredAt: null,
    materialPurgedAt: null,
    materialDigest: 'shared-digest',
    certificatePath: '/etc/letsencrypt/live/shared.example.com/cert.pem',
  };
  const retiredSharedAcme = {
    id: 'cert-retired-1',
    domainId: 'd-old-1',
    serverId: 's-1',
    certName: 'shared.example.com', // Same ACME name as active!
    source: 'acme',
    purpose: 'web',
    state: 'retired',
    retiredAt: '2026-08-01T00:00:00.000Z',
    materialPurgedAt: null,
  };
  const retiredSharedDigest = {
    id: 'cert-retired-2',
    domainId: 'd-old-2',
    serverId: 's-1',
    certName: 'other.example.com',
    source: 'custom',
    purpose: 'web',
    state: 'retired',
    retiredAt: '2026-08-01T00:00:00.000Z',
    materialPurgedAt: null,
    materialDigest: 'shared-digest', // Same digest as active!
  };
  const retiredDomainBound = {
    id: 'cert-retired-3',
    domainId: 'd-bound',
    serverId: 's-1',
    certName: 'bound.example.com',
    source: 'custom',
    purpose: 'web',
    state: 'retired',
    retiredAt: '2026-08-01T00:00:00.000Z',
    materialPurgedAt: null,
    materialDigest: 'digest-unique',
  };

  const certificateRegistry = createMockCertificateRegistry([
    activeCert,
    retiredSharedAcme,
    retiredSharedDigest,
    retiredDomainBound,
  ]);
  const domainRegistry = createMockDomainRegistry([
    { id: 'd-live', certificateId: 'cert-retired-3' }, // Active domain references cert-retired-3!
  ]);

  const gc = createCertificateMaterialGc({
    certificateRegistry,
    domainRegistry,
    certificateMaterialManager: { removeCustom: async () => true },
    now: () => now,
  });

  const inspection = await gc.inspectGcCandidates();
  assert.equal(inspection.eligibleCount, 0);
  assert.equal(inspection.sharedActiveCount, 3);
  assert.equal(inspection.notRetiredCount, 1);

  const sharedReasons = new Map(inspection.sharedActive.map((c) => [c.id, c.reason]));
  assert.equal(sharedReasons.get('cert-retired-1'), 'shared_with_active_certificate');
  assert.equal(sharedReasons.get('cert-retired-2'), 'shared_with_active_certificate');
  assert.equal(sharedReasons.get('cert-retired-3'), 'referenced_by_domain');
});

test('inspectGcCandidates protects materials shared with another unexpired retired certificate', async () => {
  const now = Date.parse('2026-10-30T00:00:00.000Z');
  const certOld = {
    id: 'cert-1',
    domainId: 'd-1',
    serverId: 's-1',
    certName: 'shared-retired.example.com',
    source: 'acme',
    purpose: 'web',
    state: 'retired',
    retiredAt: '2026-08-01T00:00:00.000Z', // 90 days ago -> expired
    materialPurgedAt: null,
  };
  const certRecent = {
    id: 'cert-2',
    domainId: 'd-2',
    serverId: 's-1',
    certName: 'shared-retired.example.com', // Shares same ACME name!
    source: 'acme',
    purpose: 'web',
    state: 'retired',
    retiredAt: '2026-10-20T00:00:00.000Z', // 10 days ago -> UNEXPIRED
    materialPurgedAt: null,
  };

  const certificateRegistry = createMockCertificateRegistry([certOld, certRecent]);
  const gc = createCertificateMaterialGc({
    certificateRegistry,
    certificateMaterialManager: { removeCustom: async () => true },
    now: () => now,
  });

  const inspection = await gc.inspectGcCandidates();
  assert.equal(inspection.eligibleCount, 0);
  assert.equal(inspection.retainedCount, 1);
  assert.equal(inspection.sharedRetainedCount, 1);
  assert.equal(inspection.retained[0].id, 'cert-2');
  assert.equal(inspection.sharedRetained[0].id, 'cert-1');
  assert.equal(inspection.sharedRetained[0].reason, 'shared_with_retained_certificate');
});

test('sweep performs physical deletion, updates registry, and supports dryRun', async () => {
  const now = Date.parse('2026-10-30T00:00:00.000Z');
  const customCert = {
    id: 'cert-custom-old',
    domainId: 'd-1',
    serverId: 's-1',
    certName: 'custom.example.com',
    source: 'custom',
    purpose: 'web',
    state: 'retired',
    retiredAt: '2026-08-01T00:00:00.000Z',
    materialPurgedAt: null,
  };
  const acmeCert = {
    id: 'cert-acme-old',
    domainId: 'd-2',
    serverId: 's-1',
    certName: 'acme.example.com',
    source: 'acme',
    purpose: 'web',
    state: 'retired',
    retiredAt: '2026-08-01T00:00:00.000Z',
    materialPurgedAt: null,
  };

  const certificateRegistry = createMockCertificateRegistry([customCert, acmeCert]);
  const customDeleted = [];
  const acmeDeleted = [];

  const certificateMaterialManager = {
    async removeCustom(id) {
      customDeleted.push(id);
      return true;
    },
    async removeAcme(name) {
      acmeDeleted.push(name);
      return true;
    },
  };
  const acmeManager = {
    async deleteCertificate({ certName }) {
      acmeDeleted.push(`certbot:${certName}`);
      return { certName, status: 'deleted' };
    },
  };

  const gc = createCertificateMaterialGc({
    certificateRegistry,
    certificateMaterialManager,
    acmeManager,
    now: () => now,
  });

  // 1. Dry-run sweep
  const dryResult = await gc.sweep({ dryRun: true });
  assert.equal(dryResult.dryRun, true);
  assert.equal(dryResult.sweptCount, 2);
  assert.equal(customDeleted.length, 0);
  assert.equal(acmeDeleted.length, 0);

  // 2. Real sweep
  const realResult = await gc.sweep({ dryRun: false });
  assert.equal(realResult.dryRun, false);
  assert.equal(realResult.sweptCount, 2);
  assert.deepEqual(customDeleted, ['cert-custom-old']);
  assert.deepEqual(acmeDeleted, ['certbot:acme.example.com']);

  // Check registry was updated with materialPurgedAt
  const updatedCustom = await certificateRegistry.getCertificate('cert-custom-old');
  assert.equal(updatedCustom.materialPurgedAt, new Date(now).toISOString());
  const updatedAcme = await certificateRegistry.getCertificate('cert-acme-old');
  assert.equal(updatedAcme.materialPurgedAt, new Date(now).toISOString());

  // 3. Subsequent sweep sees them as alreadyPurged
  const thirdSweep = await gc.sweep({ dryRun: false });
  assert.equal(thirdSweep.sweptCount, 0);
  assert.equal(thirdSweep.alreadyPurgedCount, 2);
});

// T970: a certificate retired by Domain removal must not keep its certbot
// lineage for the retention window, or the system certbot timer keeps
// renewing it. Real material manager and ACME manager on a private
// /etc/letsencrypt copy; certbot itself is the controlled host boundary.
async function lineageFixture(t, { certbot = 'absent' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-cert-purge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function lineage(name) {
    await mkdir(path.join(root, 'live', name), { recursive: true });
    await writeFile(path.join(root, 'live', name, 'cert.pem'), 'dummy');
    await mkdir(path.join(root, 'archive', name), { recursive: true });
    await writeFile(path.join(root, 'archive', name, 'cert1.pem'), 'dummy');
    await mkdir(path.join(root, 'renewal'), { recursive: true });
    await writeFile(path.join(root, 'renewal', `${name}.conf`), `# renewal for ${name}\n`);
  }
  const exists = async (target) => stat(target).then(() => true, () => false);
  const lineageExists = async (name) => ({
    live: await exists(path.join(root, 'live', name)),
    archive: await exists(path.join(root, 'archive', name)),
    renewal: await exists(path.join(root, 'renewal', `${name}.conf`)),
  });
  const certbotCalls = [];
  const certbotPath = path.join(root, 'certbot');
  if (certbot !== 'absent') await writeFile(certbotPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const acmeManager = createAcmeManager({
    certbotPaths: [certbotPath],
    liveRoot: path.join(root, 'live'),
    run: async (file, args) => {
      certbotCalls.push([file, args]);
      if (certbot === 'fails') throw Object.assign(new Error('certbot exploded'), { code: 1 });
      return { stdout: '', stderr: '' };
    },
  });
  const certificateMaterialManager = createCertificateMaterialManager({
    acmeLiveRoot: path.join(root, 'live'),
    customRoot: path.join(root, 'custom'),
    getUid: () => 0,
  });
  return { root, lineage, lineageExists, certbotCalls, acmeManager, certificateMaterialManager };
}

function acmeCertificate(overrides = {}) {
  return {
    id: 'cert-retired',
    domainId: 'd-removed',
    serverId: 's-1',
    certName: 'removed.example.com',
    source: 'acme',
    purpose: 'web',
    state: 'retired',
    staging: false,
    retiredAt: '2026-11-28T00:00:00.000Z',
    retirementOperationId: 'removal-operation-1',
    materialPurgedAt: null,
    materialDigest: null,
    certificatePath: null,
    fullchainPath: null,
    privateKeyPath: null,
    ...overrides,
  };
}

test('purgeRetiredCertificate removes the retired certbot lineage at once and keeps other lineages', async (t) => {
  const now = Date.parse('2026-11-28T00:05:00.000Z');
  const f = await lineageFixture(t);
  await f.lineage('removed.example.com');
  await f.lineage('active.example.com');
  const certificateRegistry = createMockCertificateRegistry([
    acmeCertificate(),
    acmeCertificate({ id: 'cert-active', domainId: 'd-active', certName: 'active.example.com', state: 'active', retiredAt: null }),
  ]);
  const gc = createCertificateMaterialGc({
    certificateRegistry,
    domainRegistry: createMockDomainRegistry([{ id: 'd-active', certificateId: 'cert-active' }]),
    certificateMaterialManager: f.certificateMaterialManager,
    acmeManager: f.acmeManager,
    now: () => now,
  });

  const result = await gc.purgeRetiredCertificate({ certificateId: 'cert-retired' });
  assert.equal(result.purged, true);
  assert.deepEqual(result.purgedCertificateIds, ['cert-retired']);
  assert.deepEqual(await f.lineageExists('removed.example.com'), { live: false, archive: false, renewal: false });
  assert.deepEqual(await f.lineageExists('active.example.com'), { live: true, archive: true, renewal: true });
  assert.equal((await certificateRegistry.getCertificate('cert-retired')).materialPurgedAt, new Date(now).toISOString());
  assert.equal((await certificateRegistry.getCertificate('cert-active')).materialPurgedAt ?? null, null);

  const repeated = await gc.purgeRetiredCertificate({ certificateId: 'cert-retired' });
  assert.equal(repeated.purged, false);
  assert.equal(repeated.reason, 'already_purged');
});

test('purgeRetiredCertificate runs certbot delete for a managed lineage and fails closed when it fails', async (t) => {
  const f = await lineageFixture(t, { certbot: 'present' });
  await f.lineage('removed.example.com');
  const certificateRegistry = createMockCertificateRegistry([acmeCertificate()]);
  const gc = createCertificateMaterialGc({
    certificateRegistry,
    certificateMaterialManager: f.certificateMaterialManager,
    acmeManager: f.acmeManager,
  });
  const result = await gc.purgeRetiredCertificate({ certificateId: 'cert-retired' });
  assert.equal(result.purged, true);
  assert.deepEqual(f.certbotCalls.map(([, args]) => args),
    [['delete', '--cert-name', 'removed.example.com', '--non-interactive']]);
  // The controlled certbot boundary removed nothing, so the manager finished
  // the exact lineage itself and proved it gone.
  assert.deepEqual(await f.lineageExists('removed.example.com'), { live: false, archive: false, renewal: false });

  const failing = await lineageFixture(t, { certbot: 'fails' });
  await failing.lineage('removed.example.com');
  const failingRegistry = createMockCertificateRegistry([acmeCertificate()]);
  const failingGc = createCertificateMaterialGc({
    certificateRegistry: failingRegistry,
    certificateMaterialManager: failing.certificateMaterialManager,
    acmeManager: failing.acmeManager,
  });
  await assert.rejects(failingGc.purgeRetiredCertificate({ certificateId: 'cert-retired' }),
    (error) => error.code === 'certbot_failed');
  assert.deepEqual(await failing.lineageExists('removed.example.com'), { live: true, archive: true, renewal: true });
  assert.equal((await failingRegistry.getCertificate('cert-retired')).materialPurgedAt, null);
});

test('purgeRetiredCertificate never deletes a lineage shared with an active or bound certificate', async (t) => {
  const f = await lineageFixture(t);
  await f.lineage('shared.example.com');
  const certificateRegistry = createMockCertificateRegistry([
    acmeCertificate({ certName: 'shared.example.com' }),
    acmeCertificate({ id: 'cert-replacement', domainId: 'd-new', certName: 'shared.example.com', state: 'active', retiredAt: null }),
    acmeCertificate({ id: 'cert-bound', certName: 'bound.example.com' }),
    acmeCertificate({ id: 'cert-active', state: 'active', retiredAt: null }),
  ]);
  const gc = createCertificateMaterialGc({
    certificateRegistry,
    domainRegistry: createMockDomainRegistry([{ id: 'd-other', certificateId: 'cert-bound' }]),
    certificateMaterialManager: f.certificateMaterialManager,
    acmeManager: f.acmeManager,
  });
  const shared = await gc.purgeRetiredCertificate({ certificateId: 'cert-retired' });
  assert.equal(shared.purged, false);
  assert.equal(shared.reason, 'shared_with_active_certificate');
  assert.deepEqual(await f.lineageExists('shared.example.com'), { live: true, archive: true, renewal: true });
  const bound = await gc.purgeRetiredCertificate({ certificateId: 'cert-bound' });
  assert.equal(bound.purged, false);
  assert.equal(bound.reason, 'referenced_by_domain');
  const active = await gc.purgeRetiredCertificate({ certificateId: 'cert-active' });
  assert.equal(active.purged, false);
  assert.equal(active.reason, 'certificate_not_retired');
});

test('purgeRetiredCertificate marks retired siblings of the same deleted lineage as purged', async (t) => {
  const now = Date.parse('2026-11-28T00:05:00.000Z');
  const f = await lineageFixture(t);
  await f.lineage('removed.example.com');
  const certificateRegistry = createMockCertificateRegistry([
    acmeCertificate(),
    acmeCertificate({ id: 'cert-older', retiredAt: '2026-11-01T00:00:00.000Z' }),
    acmeCertificate({ id: 'cert-staging', certName: 'staging.example.com', staging: true }),
  ]);
  const gc = createCertificateMaterialGc({
    certificateRegistry,
    certificateMaterialManager: f.certificateMaterialManager,
    acmeManager: f.acmeManager,
    now: () => now,
  });
  const result = await gc.purgeRetiredCertificate({ certificateId: 'cert-retired' });
  assert.deepEqual(result.purgedCertificateIds, ['cert-retired', 'cert-older']);
  assert.equal((await certificateRegistry.getCertificate('cert-older')).materialPurgedAt, new Date(now).toISOString());
  // A staging (dry-run) certificate never had a lineage; it is only recorded.
  const staging = await gc.purgeRetiredCertificate({ certificateId: 'cert-staging' });
  assert.equal(staging.purged, true);
  assert.equal(staging.lineageRemoved, false);
  // A later GC sweep has nothing left to delete through certbot.
  const sweep = await gc.sweep({ retentionDays: 0 });
  assert.equal(sweep.sweptCount, 0);
});
