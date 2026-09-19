import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  certificatePublicView,
  createCertificateRegistry,
  CertificateRegistryError,
} from '../src/certificate-registry.js';

const fingerprint256 = Array.from({ length: 32 }, () => 'AB').join(':');

function acmeResult(certName, domains) {
  return {
    certName,
    domains,
    certificatePath: `/etc/letsencrypt/live/${certName}/cert.pem`,
    fullchainPath: `/etc/letsencrypt/live/${certName}/fullchain.pem`,
    privateKeyPath: `/etc/letsencrypt/live/${certName}/privkey.pem`,
    validFrom: '2026-09-01T00:00:00.000Z',
    validTo: '2026-12-01T00:00:00.000Z',
    fingerprint256,
  };
}

test('custom certificate registry keeps fixed material identity and manual renewal policy', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-custom-certificate-registry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const customRoot = path.join(directory, 'custom-certificates');
  const id = '12345678-1234-4234-8234-123456789012';
  const materialRoot = path.join(customRoot, id);
  const registry = createCertificateRegistry({ customRoot, now: () => Date.parse('2026-09-11T00:00:00.000Z') });
  const certificate = await registry.registerCustom({
    certificateId: id,
    domainId: 'domain-1',
    serverId: 'server-1',
    domains: ['example.com'],
    certificatePath: path.join(materialRoot, 'cert.pem'),
    fullchainPath: path.join(materialRoot, 'fullchain.pem'),
    privateKeyPath: path.join(materialRoot, 'privkey.pem'),
    subject: 'CN=example.com',
    issuer: 'CN=Private CA',
    subjectAltName: 'DNS:example.com',
    validFrom: '2026-09-01T00:00:00.000Z',
    validTo: '2026-12-01T00:00:00.000Z',
    fingerprint256,
    materialDigest: 'a'.repeat(64),
  });
  assert.equal(certificate.source, 'custom');
  assert.equal(certificate.renewalMode, 'manual');
  assert.equal(certificate.state, 'active');

  await assert.rejects(
    registry.registerCustom({
      ...certificate,
      certificateId: '22345678-1234-4234-8234-123456789012',
      certificatePath: '/etc/shadow',
    }),
    (error) => error instanceof CertificateRegistryError && error.code === 'invalid_certificate_path',
  );
});

test('selection supersedes only other active production records after explicit commit', async () => {
  const now = () => Date.parse('2026-09-11T00:00:00.000Z');
  const registry = createCertificateRegistry({ now });
  const first = await registry.createForDomain({
    domainId: 'domain-1', serverId: 'server-1', domains: ['example.com'], email: 'ops@example.com',
  });
  await registry.markActive(first.id, acmeResult(first.certName, first.domains));
  const replacement = await registry.createForDomain({
    domainId: 'domain-1', serverId: 'server-1', domains: ['example.com'], email: 'ops@example.com', replaceExisting: true,
  });
  await registry.markActive(replacement.id, acmeResult(replacement.certName, replacement.domains));
  assert.deepEqual((await registry.listCertificates()).map((entry) => entry.state), ['active', 'active']);
  await registry.commitSelection(replacement.id);
  assert.deepEqual((await registry.listCertificates()).map((entry) => entry.state), ['superseded', 'active']);
  await registry.prepareSelection(first.id);
  await registry.commitSelection(first.id);
  assert.deepEqual((await registry.listCertificates()).map((entry) => entry.state), ['active', 'superseded']);
});

test('version one ACME state hydrates without rewrite and persists source policy on mutation', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-certificate-v1-'));
  const filePath = path.join(directory, 'certificates.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const seed = createCertificateRegistry();
  const certificate = await seed.createForDomain({
    domainId: 'domain-1', serverId: 'server-1', domains: ['example.com'], email: 'ops@example.com',
  });
  const legacy = { ...certificate };
  for (const field of ['source', 'renewalMode', 'materialDigest', 'lastImportedAt']) delete legacy[field];
  const before = JSON.stringify({ version: 1, certificates: [legacy] });
  await writeFile(filePath, before);

  const registry = createCertificateRegistry({ filePath });
  const loaded = await registry.getCertificate(certificate.id);
  assert.equal(loaded.source, 'acme');
  assert.equal(loaded.renewalMode, 'automatic');
  assert.equal(await readFile(filePath, 'utf8'), before);
  await registry.setState(certificate.id, 'issuing');
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(persisted.version, 7);
  assert.equal(persisted.certificates[0].source, 'acme');
  assert.deepEqual(persisted.certificates[0].certificateNames, ['example.com']);
  assert.deepEqual(persisted.certificates[0].challenge, { type: 'http-01' });
});

test('version two certificate state hydrates DNS fields without changing identity', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-certificate-v2-'));
  const filePath = path.join(directory, 'certificates.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const seed = createCertificateRegistry();
  const certificate = await seed.createForDomain({
    domainId: 'domain-2', serverId: 'server-2', domains: ['www.example.com'], email: 'ops@example.com',
  });
  const legacy = { ...certificate };
  delete legacy.certificateNames;
  delete legacy.challenge;
  const before = JSON.stringify({ version: 2, certificates: [legacy] });
  await writeFile(filePath, before);

  const registry = createCertificateRegistry({ filePath });
  const loaded = await registry.getCertificate(certificate.id);
  assert.equal(loaded.id, certificate.id);
  assert.deepEqual(loaded.certificateNames, ['www.example.com']);
  assert.deepEqual(loaded.challenge, { type: 'http-01' });
  assert.equal(await readFile(filePath, 'utf8'), before);
});

test('Domain removal retirement is exact, durable, idempotent and immutable', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-certificate-retirement-'));
  const filePath = path.join(directory, 'certificates.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = Date.parse('2026-09-18T20:00:00.000Z');
  const registry = createCertificateRegistry({ filePath, now: () => clock });
  const created = await registry.createForDomain({
    domainId: 'domain-1', serverId: 'server-1', domains: ['example.com'], email: 'ops@example.com',
  });
  await registry.markActive(created.id, acmeResult(created.certName, created.domains));
  const active = await registry.getCertificate(created.id);

  await assert.rejects(
    registry.retireForDomainRemoval(created.id, {
      expectedDomainId: 'domain-1',
      expectedServerId: 'server-1',
      expectedState: 'active',
      expectedSource: 'acme',
      expectedRenewalMode: 'automatic',
      expectedStaging: false,
      expectedValidTo: active.validTo,
      expectedUpdatedAt: '2026-09-18T19:00:00.000Z',
      operationId: 'domain-removal-1',
    }),
    (error) => error instanceof CertificateRegistryError
      && error.code === 'certificate_retirement_intent_drift',
  );

  clock = Date.parse('2026-09-18T21:00:00.000Z');
  const retired = await registry.retireForDomainRemoval(created.id, {
    expectedDomainId: active.domainId,
    expectedServerId: active.serverId,
    expectedState: active.state,
    expectedSource: active.source,
    expectedRenewalMode: active.renewalMode,
    expectedStaging: active.staging,
    expectedValidTo: active.validTo,
    expectedUpdatedAt: active.updatedAt,
    operationId: 'domain-removal-1',
  });
  assert.equal(retired.changed, true);
  assert.equal(retired.certificate.state, 'retired');
  assert.equal(retired.certificate.retiredFromState, 'active');
  assert.equal(retired.certificate.retiredFromUpdatedAt, active.updatedAt);
  assert.equal(retired.certificate.retirementOperationId, 'domain-removal-1');
  assert.equal(retired.certificate.retiredAt, '2026-09-18T21:00:00.000Z');

  const repeated = await registry.retireForDomainRemoval(created.id, {
    expectedDomainId: active.domainId,
    expectedServerId: active.serverId,
    expectedState: active.state,
    expectedSource: active.source,
    expectedRenewalMode: active.renewalMode,
    expectedStaging: active.staging,
    expectedValidTo: active.validTo,
    expectedUpdatedAt: active.updatedAt,
    operationId: 'domain-removal-1',
  });
  assert.equal(repeated.changed, false);
  await assert.rejects(
    registry.setState(created.id, 'active'),
    (error) => error instanceof CertificateRegistryError && error.code === 'certificate_retired',
  );

  const reopened = createCertificateRegistry({ filePath, now: () => clock });
  const restored = await reopened.getCertificate(created.id);
  assert.equal(restored.state, 'retired');
  assert.equal(restored.retirementOperationId, 'domain-removal-1');
  assert.equal(restored.retiredFromUpdatedAt, active.updatedAt);
  const publicRetired = certificatePublicView(restored, { now: clock });
  assert.equal(publicRetired.diagnosis.code, 'certificate_retired');
  assert.equal(publicRetired.retiredAt, '2026-09-18T21:00:00.000Z');
  assert.equal(Object.hasOwn(publicRetired, 'retirementOperationId'), false);
});

test('public certificate view omits private state and exposes authored lifecycle diagnosis', async () => {
  const now = Date.parse('2026-11-15T00:00:00.000Z');
  const registry = createCertificateRegistry({ now: () => now });
  const certificate = await registry.createForDomain({
    domainId: 'domain-1', serverId: 'server-1', domains: ['example.com'], email: 'private@example.com',
  });
  await registry.markActive(certificate.id, acmeResult(certificate.certName, certificate.domains));
  const active = await registry.getCertificate(certificate.id);
  const publicActive = certificatePublicView({ ...active, subject: 'token=PRIVATE' }, { now });
  assert.equal(publicActive.diagnosis.code, 'certificate_expiring');
  assert.deepEqual(publicActive.challenge, { type: 'http-01' });
  for (const field of ['email', 'certificatePath', 'fullchainPath', 'privateKeyPath', 'materialDigest', 'lastError']) {
    assert.equal(Object.hasOwn(publicActive, field), false);
  }
  assert.doesNotMatch(JSON.stringify(publicActive), /private@example|letsencrypt|privkey/);
  assert.equal(publicActive.subject, 'token=[REDACTED]');

  await registry.markFailed(certificate.id, 'token_deadbeef');
  const failed = certificatePublicView(await registry.getCertificate(certificate.id), { now });
  assert.deepEqual(failed.diagnosis, {
    severity: 'error',
    code: 'certificate_operation_failed',
    message: 'The certificate operation failed.',
    action: 'Inspect the protected certificate job and host diagnostics before retrying.',
  });
  assert.doesNotMatch(JSON.stringify(failed), /token_deadbeef/);
});

test('markMaterialPurged records purge timestamp on retired certificate and rejects active certificates', async () => {
  const clock = Date.parse('2026-09-19T10:00:00.000Z');
  const registry = createCertificateRegistry({ now: () => clock });
  const certificate = await registry.createForDomain({
    domainId: 'domain-1', serverId: 'server-1', domains: ['example.com'], email: 'ops@example.com',
  });
  await registry.markActive(certificate.id, acmeResult(certificate.certName, certificate.domains));

  // Reject active certificate
  await assert.rejects(
    registry.markMaterialPurged(certificate.id),
    (error) => error instanceof CertificateRegistryError && error.code === 'certificate_not_retired',
  );

  // Retire certificate
  const active = await registry.getCertificate(certificate.id);
  await registry.retireForDomainRemoval(certificate.id, {
    expectedDomainId: 'domain-1',
    expectedServerId: 'server-1',
    expectedState: 'active',
    expectedSource: 'acme',
    expectedRenewalMode: 'automatic',
    expectedStaging: false,
    expectedValidTo: active.validTo,
    expectedUpdatedAt: active.updatedAt,
    operationId: 'op-1',
  });

  // Mark purged
  const purgeTime = '2026-10-25T00:00:00.000Z';
  const purged = await registry.markMaterialPurged(certificate.id, { purgedAt: purgeTime });
  assert.equal(purged.changed, true);
  assert.equal(purged.certificate.materialPurgedAt, purgeTime);

  // Idempotent
  const second = await registry.markMaterialPurged(certificate.id, { purgedAt: purgeTime });
  assert.equal(second.changed, false);
  assert.equal(second.certificate.materialPurgedAt, purgeTime);

  const publicView = certificatePublicView(await registry.getCertificate(certificate.id));
  assert.equal(publicView.materialPurgedAt, purgeTime);
});

