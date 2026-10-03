import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createCertificateRegistry,
  compareTlsPresentation,
  certificateDiagnosis,
  CertificateRegistryError,
} from '../src/certificate-registry.js';
import {
  verifyRenewalOutcome,
  verifyCertificateRenewalOutcome,
  runCertificateRenewalSweep,
  startCertificateRenewalScheduler,
} from '../src/certificate-renewal-scheduler.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { completeNextJob } from './helpers/job-completion-fixture.js';
import { certificateHttpInternals } from '../src/certificate-http.js';

const {
  renewalOutcome,
  renewalMetadata,
  verifyTlsPresentation,
  normalizeReloadService,
  checkReloadOutcome,
} = certificateHttpInternals;

test('compareTlsPresentation accurately validates fingerprint, validFrom, and validTo', () => {
  const cert = {
    validFrom: '2026-09-01T00:00:00.000Z',
    validTo: '2026-12-01T00:00:00.000Z',
    fingerprint256: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
  };

  // 1. Exact match
  const match = compareTlsPresentation(cert, {
    validFrom: '2026-09-01T00:00:00.000Z',
    validTo: '2026-12-01T00:00:00.000Z',
    fingerprint256: 'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99',
  });
  assert.equal(match.matches, true);
  assert.equal(match.fingerprint256, cert.fingerprint256);

  // 2. Fingerprint mismatch
  const fpMismatch = compareTlsPresentation(cert, {
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    fingerprint256: '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00',
  });
  assert.equal(fpMismatch.matches, false);
  assert.equal(fpMismatch.reason, 'fingerprint_mismatch');

  // 3. ValidTo mismatch
  const toMismatch = compareTlsPresentation(cert, {
    validFrom: cert.validFrom,
    validTo: '2026-11-01T00:00:00.000Z',
    fingerprint256: cert.fingerprint256,
  });
  assert.equal(toMismatch.matches, false);
  assert.equal(toMismatch.reason, 'valid_to_mismatch');

  // 4. ValidFrom mismatch
  const fromMismatch = compareTlsPresentation(cert, {
    validFrom: '2026-08-01T00:00:00.000Z',
    validTo: cert.validTo,
    fingerprint256: cert.fingerprint256,
  });
  assert.equal(fromMismatch.matches, false);
  assert.equal(fromMismatch.reason, 'valid_from_mismatch');

  // 5. Invalid / non-SHA256 fingerprint input
  const invalidFp = compareTlsPresentation(cert, {
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    fingerprint256: 'not-a-fingerprint',
  });
  assert.equal(invalidFp.matches, false);
  assert.equal(invalidFp.reason, 'live_fingerprint_invalid');

  // 6. Missing parameters
  assert.equal(compareTlsPresentation(null, {}).matches, false);
  assert.equal(compareTlsPresentation(cert, null).matches, false);
});

test('verifyRenewalOutcome distinguishes job success from live TLS presentation', () => {
  const before = {
    certName: 'example.com',
    validFrom: '2026-06-01T00:00:00.000Z',
    validTo: '2026-09-01T00:00:00.000Z',
    fingerprint256: '11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11',
  };

  const renewedCert = {
    certName: 'example.com',
    state: 'active',
    validFrom: '2026-09-01T00:00:00.000Z',
    validTo: '2026-12-01T00:00:00.000Z',
    fingerprint256: '22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22:22',
  };

  const job = {
    status: 'succeeded',
    result: {
      certName: 'example.com',
      status: 'renewed',
      validFrom: renewedCert.validFrom,
      validTo: renewedCert.validTo,
      fingerprint256: renewedCert.fingerprint256,
      dryRun: false,
    },
  };

  // Case 1: Job succeeded, persistent record synced, live TLS matches new certificate
  const liveVerified = verifyRenewalOutcome({
    certificate: renewedCert,
    before,
    job,
    liveTls: {
      validFrom: renewedCert.validFrom,
      validTo: renewedCert.validTo,
      fingerprint256: renewedCert.fingerprint256,
    },
  });
  assert.equal(liveVerified.outcome, 'renewed_and_live_verified');
  assert.equal(liveVerified.verified, true);

  // Case 2: Job succeeded, persistent record synced, but live TLS presents OLD certificate (pending reload)
  const pendingReload = verifyRenewalOutcome({
    certificate: renewedCert,
    before,
    job,
    liveTls: {
      validFrom: before.validFrom,
      validTo: before.validTo,
      fingerprint256: before.fingerprint256,
    },
  });
  assert.equal(pendingReload.outcome, 'pending_service_reload');
  assert.equal(pendingReload.verified, false);
  assert.equal(pendingReload.reason, 'live_tls_presents_previous_certificate');

  // Case 3: Job succeeded, but persistent record not yet updated
  const syncing = verifyRenewalOutcome({
    certificate: { ...renewedCert, state: 'renewing', fingerprint256: before.fingerprint256 },
    before,
    job,
    liveTls: {
      validFrom: renewedCert.validFrom,
      validTo: renewedCert.validTo,
      fingerprint256: renewedCert.fingerprint256,
    },
  });
  assert.equal(syncing.outcome, 'syncing');
  assert.equal(syncing.verified, false);

  // Case 4: Job succeeded, but live TLS is missing / unprobed
  const pendingTls = verifyRenewalOutcome({
    certificate: renewedCert,
    before,
    job,
    liveTls: null,
  });
  assert.equal(pendingTls.outcome, 'pending_live_tls_verification');
  assert.equal(pendingTls.verified, false);

  // Case 5: Job failed
  const failed = verifyRenewalOutcome({
    certificate: renewedCert,
    before,
    job: { status: 'failed', error: { message: 'ACME challenge failed' } },
  });
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.verified, false);

  // Case 6: Dry run tested
  const dryRunTested = verifyRenewalOutcome({
    certificate: renewedCert,
    before,
    job: {
      status: 'succeeded',
      result: { certName: 'example.com', status: 'validated', dryRun: true },
    },
    dryRun: true,
  });
  assert.equal(dryRunTested.outcome, 'tested');
  assert.equal(dryRunTested.verified, true);
});

test('verifyCertificateRenewalOutcome integrates registries and dynamic TLS inspector', async () => {
  const certificateRegistry = createCertificateRegistry();
  const jobRegistry = createJobRegistry();
  const serverId = 'srv-1';
  const domainId = 'dom-1';

  const cert = await certificateRegistry.createForDomain({
    domainId,
    serverId,
    domains: ['live-domain.example.com'],
    email: 'admin@example.com',
  });

  const validFrom = '2026-09-01T00:00:00.000Z';
  const validTo = '2026-12-01T00:00:00.000Z';
  const fingerprint256 = '33:33:33:33:33:33:33:33:33:33:33:33:33:33:33:33:33:33:33:33:33:33:33:33:33:33:33:33:33:33:33:33';

  await certificateRegistry.markActive(cert.id, {
    certName: 'live-domain.example.com',
    certificatePath: '/etc/letsencrypt/live/live-domain.example.com/cert.pem',
    fullchainPath: '/etc/letsencrypt/live/live-domain.example.com/fullchain.pem',
    privateKeyPath: '/etc/letsencrypt/live/live-domain.example.com/privkey.pem',
    validFrom,
    validTo,
    fingerprint256,
  });

  const job = await jobRegistry.enqueue({
    serverId,
    type: 'ssl.renew',
    operation: 'ssl.renew',
    payload: { certName: 'live-domain.example.com', dryRun: false },
    resourceType: 'certificate',
    resourceId: cert.id,
  });
  await jobRegistry.claimNext(serverId);
  await jobRegistry.complete({
    serverId,
    jobId: job.id,
    status: 'succeeded',
    result: {
      certName: 'live-domain.example.com',
      certificatePath: '/etc/letsencrypt/live/live-domain.example.com/cert.pem',
      fullchainPath: '/etc/letsencrypt/live/live-domain.example.com/fullchain.pem',
      privateKeyPath: '/etc/letsencrypt/live/live-domain.example.com/privkey.pem',
      status: 'renewed',
      validFrom,
      validTo,
      fingerprint256,
    },
  });

  // Verify using tlsInspector callback
  const outcome = await verifyCertificateRenewalOutcome({
    certificateId: cert.id,
    certificateRegistry,
    jobRegistry,
    jobId: job.id,
    tlsInspector: async ({ certName }) => {
      assert.equal(certName, 'live-domain.example.com');
      return { validFrom, validTo, fingerprint256 };
    },
  });

  assert.equal(outcome.outcome, 'renewed_and_live_verified');
  assert.equal(outcome.verified, true);
});

test('Multi-process concurrency: process store locks serialize mutations and reload from disk', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-cert-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const filePath = path.join(dir, 'certificates.json');

  // Instance 1 represents API process, Instance 2 represents Worker process
  const apiRegistry = createCertificateRegistry({ filePath });
  const workerRegistry = createCertificateRegistry({ filePath });

  await apiRegistry.init();
  await workerRegistry.init();

  // API process creates certificate
  const cert = await apiRegistry.createForDomain({
    domainId: 'domain-shared',
    serverId: 'server-shared',
    domains: ['shared.example.com'],
    email: 'shared@example.com',
  });

  // Worker process must see certificate immediately on read
  const workerView = await workerRegistry.getCertificate(cert.id);
  assert.equal(workerView.id, cert.id);
  assert.equal(workerView.state, 'pending');

  const validFrom = '2026-09-01T00:00:00.000Z';
  const validTo = '2026-12-01T00:00:00.000Z';
  const fingerprint256 = '44:44:44:44:44:44:44:44:44:44:44:44:44:44:44:44:44:44:44:44:44:44:44:44:44:44:44:44:44:44:44:44';

  // Renewal transitions require a previously issued certificate, including its managed paths.
  await workerRegistry.markActive(cert.id, {
    certName: 'shared.example.com',
    certificatePath: '/etc/letsencrypt/live/shared.example.com/cert.pem',
    fullchainPath: '/etc/letsencrypt/live/shared.example.com/fullchain.pem',
    privateKeyPath: '/etc/letsencrypt/live/shared.example.com/privkey.pem',
    validFrom, validTo, fingerprint256,
  });
  await workerRegistry.setState(cert.id, 'renewing');
  const apiView = await apiRegistry.getCertificate(cert.id);
  assert.equal(apiView.state, 'renewing');

  await Promise.all([
    workerRegistry.markActive(cert.id, {
      certName: 'shared.example.com',
      certificatePath: '/etc/letsencrypt/live/shared.example.com/cert.pem',
      fullchainPath: '/etc/letsencrypt/live/shared.example.com/fullchain.pem',
      privateKeyPath: '/etc/letsencrypt/live/shared.example.com/privkey.pem',
      validFrom,
      validTo,
      fingerprint256,
    }),
    apiRegistry.recordReloadOutcome(cert.id, {
      service: 'nginx',
      status: 'succeeded',
    }),
  ]);

  const finalApiView = await apiRegistry.getCertificate(cert.id);
  assert.equal(finalApiView.state, 'active');
  assert.equal(finalApiView.fingerprint256, fingerprint256);
});

test('Process store lock cleans up stale lock files from dead processes (ESRCH)', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-dead-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const filePath = path.join(dir, 'certificates.json');
  const lockPath = `${filePath}.lock`;

  // Write a stale lock from a dead PID (e.g., 999999999)
  const deadRecord = {
    version: 1,
    pid: 999999999,
    token: '00000000-0000-4000-8000-000000000001',
    createdAt: new Date(Date.now() - 60000).toISOString(),
  };
  await writeFile(lockPath, `${JSON.stringify(deadRecord)}\n`, 'utf8');

  // Registry operation should automatically clear the dead lock and proceed
  const registry = createCertificateRegistry({ filePath });
  const cert = await registry.createForDomain({
    domainId: 'domain-recovery',
    serverId: 'server-recovery',
    domains: ['recovery.example.com'],
    email: 'recovery@example.com',
  });

  assert.equal(cert.domains[0], 'recovery.example.com');
  const fileContent = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(fileContent.certificates.length, 1);
});

test('Nginx and Mail reload outcomes: partial stage/activation handled gracefully without corrupting certificate', async () => {
  const certificateRegistry = createCertificateRegistry();
  const cert = await certificateRegistry.createForDomain({
    domainId: 'domain-reload',
    serverId: 'server-reload',
    domains: ['reload.example.com'],
    email: 'admin@reload.example.com',
  });

  const validFrom = '2026-09-01T00:00:00.000Z';
  const validTo = '2026-12-01T00:00:00.000Z';
  const fingerprint256 = '55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55';

  await certificateRegistry.markActive(cert.id, {
    certName: 'reload.example.com',
    certificatePath: '/etc/letsencrypt/live/reload.example.com/cert.pem',
    fullchainPath: '/etc/letsencrypt/live/reload.example.com/fullchain.pem',
    privateKeyPath: '/etc/letsencrypt/live/reload.example.com/privkey.pem',
    validFrom,
    validTo,
    fingerprint256,
  });

  // 1. Record partial Nginx reload outcome
  const partialNginx = await certificateRegistry.recordReloadOutcome(cert.id, {
    service: 'nginx',
    status: 'partial',
    stage: 'stage',
    error: 'Nginx config tested OK, secondary listener warning',
  });

  assert.equal(partialNginx.state, 'active'); // Certificate remains active!
  assert.equal(partialNginx.lastReloadOutcome.service, 'nginx');
  assert.equal(partialNginx.lastReloadOutcome.status, 'partial');

  // Diagnosis warns operator without corrupting certificate state
  const partialDiag = certificateDiagnosis(partialNginx);
  assert.equal(partialDiag.severity, 'warning');
  assert.equal(partialDiag.code, 'certificate_reload_partial');
  assert.match(partialDiag.message, /nginx/i);

  // 2. Record failed Mail reload outcome
  const failedMail = await certificateRegistry.recordReloadOutcome(cert.id, {
    service: 'mail',
    status: 'failed',
    stage: 'reload',
    error: 'Dovecot reload signal timed out',
  });

  assert.equal(failedMail.state, 'active'); // Still active!
  assert.equal(failedMail.lastReloadOutcome.service, 'mail');
  assert.equal(failedMail.lastReloadOutcome.status, 'failed');

  const failedDiag = certificateDiagnosis(failedMail);
  assert.equal(failedDiag.severity, 'warning');
  assert.equal(failedDiag.code, 'certificate_reload_failed');
  assert.match(failedDiag.message, /mail/i);

  // 3. Successful reload clears reload diagnostic warning
  const succeededReload = await certificateRegistry.recordReloadOutcome(cert.id, {
    service: 'mail',
    status: 'succeeded',
  });
  assert.equal(succeededReload.lastReloadOutcome.status, 'succeeded');
  const cleanDiag = certificateDiagnosis(succeededReload, { now: Date.parse('2026-09-15T00:00:00.000Z') });
  assert.equal(cleanDiag, null);
});

test('Certificate renewal sweep: concurrency safety prevents duplicate jobs', async () => {
  const certificateRegistry = createCertificateRegistry();
  const jobRegistry = createJobRegistry();
  const serverId = 'srv-sweep';

  const expiringCert = await certificateRegistry.createForDomain({
    domainId: 'domain-sweep',
    serverId,
    domains: ['sweep.example.com'],
    email: 'admin@sweep.example.com',
  });

  const nowTime = Date.parse('2026-10-01T00:00:00.000Z');
  const validFrom = '2026-07-01T00:00:00.000Z';
  const validTo = '2026-10-15T00:00:00.000Z'; // Expires in 14 days (< 30 day threshold)
  const fingerprint256 = '66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66';

  await certificateRegistry.markActive(expiringCert.id, {
    certName: 'sweep.example.com',
    certificatePath: '/etc/letsencrypt/live/sweep.example.com/cert.pem',
    fullchainPath: '/etc/letsencrypt/live/sweep.example.com/fullchain.pem',
    privateKeyPath: '/etc/letsencrypt/live/sweep.example.com/privkey.pem',
    validFrom,
    validTo,
    fingerprint256,
  });

  // Run two sweeps concurrently
  const [sweep1, sweep2] = await Promise.all([
    runCertificateRenewalSweep({ certificateRegistry, jobRegistry, now: () => nowTime }),
    runCertificateRenewalSweep({ certificateRegistry, jobRegistry, now: () => nowTime }),
  ]);

  // Exactly one job must have been enqueued across the concurrent sweeps
  const totalJobs = sweep1.length + sweep2.length;
  assert.equal(totalJobs, 1);

  const jobs = await jobRegistry.listJobs({ resourceType: 'certificate', resourceId: expiringCert.id });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].operation, OPERATIONS.SSL_RENEW);
  assert.equal((await certificateRegistry.getCertificate(expiringCert.id)).state, 'renewing', 'the losing sweep must not revert the active renewal');

  // Certificate is now marked 'renewing'
  const certAfterSweep = await certificateRegistry.getCertificate(expiringCert.id);
  assert.equal(certAfterSweep.state, 'renewing');

  // Subsequent sweep ignores 'renewing' certificate (idempotent)
  const sweep3 = await runCertificateRenewalSweep({ certificateRegistry, jobRegistry, now: () => nowTime });
  assert.equal(sweep3.length, 0);
});

for (const [code, status] of [['certificate_job_conflict', 409], ['database_unavailable', 503]]) {
  test('renewal sweep propagates ' + code + ' when no matching live renewal proves a concurrent enqueue', async () => {
    const registry = createCertificateRegistry();
    const cert = await registry.createForDomain({ domainId: 'domain-race', serverId: 'server-race', domains: ['race.example.com'], email: 'ops@race.example.com' });
    await registry.markActive(cert.id, { certName: 'race.example.com',
      certificatePath: '/etc/letsencrypt/live/race.example.com/cert.pem',
      fullchainPath: '/etc/letsencrypt/live/race.example.com/fullchain.pem',
      privateKeyPath: '/etc/letsencrypt/live/race.example.com/privkey.pem',
      validFrom: '2026-07-01T00:00:00.000Z', validTo: '2026-10-15T00:00:00.000Z', fingerprint256: '66:'.repeat(31)+'66' });
    const cause = Object.assign(new Error('enqueue failed'), { code, status });
    await assert.rejects(runCertificateRenewalSweep({ certificateRegistry: registry,
      jobRegistry: { listJobs: async () => [], enqueue: async () => { throw cause; } },
      now: () => Date.parse('2026-10-01T00:00:00.000Z') }), error => error === cause);
    assert.equal((await registry.getCertificate(cert.id)).state, 'active');
  });
}

const sampleFingerprint = Array(32).fill('ab').join(':');
const renewedFingerprint = Array(32).fill('cd').join(':');

test('renewalMetadata normalizes valid dates and uppercase fingerprint', () => {
  const meta = renewalMetadata({
    validFrom: '2026-01-01T00:00:00.000Z',
    validTo: '2026-04-01T00:00:00.000Z',
    fingerprint256: sampleFingerprint,
  });

  assert.equal(meta.validFrom, '2026-01-01T00:00:00.000Z');
  assert.equal(meta.validTo, '2026-04-01T00:00:00.000Z');
  assert.equal(meta.fingerprint256, sampleFingerprint.toUpperCase());
});

test('renewalMetadata throws ssl_renewal_unverified error for invalid inputs', () => {
  assert.throws(
    () => renewalMetadata(null),
    (err) => err?.code === 'ssl_renewal_unverified',
  );

  assert.throws(
    () => renewalMetadata({ fingerprint256: 'not-a-fingerprint' }),
    (err) => err?.code === 'ssl_renewal_unverified',
  );

  assert.throws(
    () => renewalMetadata({
      validFrom: '2026-05-01T00:00:00.000Z',
      validTo: '2026-01-01T00:00:00.000Z',
      fingerprint256: sampleFingerprint,
    }),
    (err) => err?.code === 'ssl_renewal_unverified',
  );
});

test('renewalOutcome computes outcome correctly across renewal lifecycles', () => {
  // Idle when no job
  assert.equal(renewalOutcome(null), 'idle');
  assert.equal(renewalOutcome(undefined), 'idle');

  // Waiting when queued or running
  assert.equal(renewalOutcome({ status: 'queued' }), 'waiting');
  assert.equal(renewalOutcome({ status: 'running' }), 'waiting');

  // Cancelled when cancelled
  assert.equal(renewalOutcome({ status: 'cancelled' }), 'cancelled');

  // Failed when job failed (even without error property)
  assert.equal(renewalOutcome({ status: 'failed' }), 'failed');

  // Dry run testing
  assert.equal(
    renewalOutcome({ status: 'succeeded', result: { dryRun: true } }, null, { state: 'active' }, true),
    'tested',
  );
  assert.equal(
    renewalOutcome({ status: 'succeeded', result: { dryRun: true } }, null, { state: 'renewing' }, true),
    'syncing',
  );

  // Unchanged when fingerprint matches before
  const beforeCert = { fingerprint256: sampleFingerprint.toUpperCase() };
  const currentCert = { state: 'active', fingerprint256: sampleFingerprint.toUpperCase() };
  const sameJob = { status: 'succeeded', result: { fingerprint256: sampleFingerprint } };
  assert.equal(renewalOutcome(sameJob, beforeCert, currentCert, false), 'unchanged');

  // Renewed when fingerprint differs from before and matches current synced cert
  const renewedJob = { status: 'succeeded', result: { fingerprint256: renewedFingerprint } };
  const syncedCert = { state: 'active', fingerprint256: renewedFingerprint.toUpperCase() };
  assert.equal(renewalOutcome(renewedJob, beforeCert, syncedCert, false), 'renewed');

  // Syncing when certificate registry has not updated yet
  assert.equal(renewalOutcome(renewedJob, beforeCert, currentCert, false), 'syncing');
});

test('verifyTlsPresentation validates certificates and exposes presentation checks safely', () => {
  const domain = {
    primaryDomain: 'example.com',
    aliases: ['www.example.com'],
  };

  const validCert = {
    id: 'cert-1',
    certName: 'example.com',
    domains: ['example.com', 'www.example.com'],
    validFrom: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
    validTo: new Date(Date.now() + 1000 * 60 * 60 * 24 * 60).toISOString(),
    fingerprint256: sampleFingerprint,
    state: 'active',
  };

  const presentation = verifyTlsPresentation({ domain, certificate: validCert });
  assert.equal(presentation.verified, true);
  assert.equal(presentation.status, 'valid');
  assert.equal(presentation.code, 'tls_verified');
  assert.equal(presentation.presentationChecks.domainsMatch, true);
  assert.equal(presentation.presentationChecks.notExpired, true);
  assert.equal(presentation.presentationChecks.fingerprintValid, true);

  // Expired certificate
  const expiredCert = {
    ...validCert,
    validTo: new Date(Date.now() - 1000 * 60).toISOString(),
  };
  const expiredPres = verifyTlsPresentation({ domain, certificate: expiredCert });
  assert.equal(expiredPres.verified, false);
  assert.equal(expiredPres.status, 'expired');
  assert.equal(expiredPres.code, 'certificate_expired');
  assert.equal(expiredPres.presentationChecks.notExpired, false);

  // Domain mismatch
  const mismatchedCert = {
    ...validCert,
    domains: ['other.com'],
    certName: 'other.com',
  };
  const mismatchPres = verifyTlsPresentation({ domain, certificate: mismatchedCert });
  assert.equal(mismatchPres.verified, false);
  assert.equal(mismatchPres.status, 'domain_mismatch');
  assert.equal(mismatchPres.code, 'domain_mismatch');
  assert.equal(mismatchPres.presentationChecks.domainsMatch, false);

  // Wildcard domain match
  const wildcardCert = {
    ...validCert,
    domains: ['example.com', '*.example.com'],
  };
  const wildcardDomain = {
    primaryDomain: 'example.com',
    aliases: ['sub.example.com', 'api.example.com'],
  };
  const wildcardPres = verifyTlsPresentation({ domain: wildcardDomain, certificate: wildcardCert });
  assert.equal(wildcardPres.verified, true);
  assert.equal(wildcardPres.presentationChecks.domainsMatch, true);

  // Certificate expiring soon: valid TLS presentation with isExpiringSoon presentation check
  const expiringSoonCert = {
    ...validCert,
    validTo: new Date(Date.now() + 1000 * 60 * 60 * 24 * 5).toISOString(),
  };
  const expiringSoonPres = verifyTlsPresentation({ domain, certificate: expiringSoonCert });
  assert.equal(expiringSoonPres.verified, true);
  assert.equal(expiringSoonPres.status, 'valid');
  assert.equal(expiringSoonPres.code, 'tls_verified');
  assert.equal(expiringSoonPres.presentationChecks.isExpiringSoon, true);
  assert.equal(expiringSoonPres.presentationChecks.notExpired, true);
});

test('normalizeReloadService and checkReloadOutcome handle partial reloads and undefined errors gracefully', () => {
  // Normalization with undefined input
  const undefSvc = normalizeReloadService('test-svc', undefined);
  assert.equal(undefSvc.ok, false);
  assert.equal(undefSvc.status, 'failed');
  assert.equal(undefSvc.code, 'service_reload_unspecified');
  assert.equal(undefSvc.error?.code, 'service_reload_unspecified');

  // Normalization with ok: false and undefined error
  const failedNoErr = normalizeReloadService('mail', { ok: false });
  assert.equal(failedNoErr.ok, false);
  assert.equal(failedNoErr.code, 'service_reload_failed');
  assert.equal(failedNoErr.error?.code, 'service_reload_failed');

  // Normalization with successful service
  const successSvc = normalizeReloadService('nginx', { ok: true });
  assert.equal(successSvc.ok, true);
  assert.equal(successSvc.code, 'ok');
  assert.equal(successSvc.error, null);

  // Complete reload
  const complete = checkReloadOutcome({
    services: {
      nginx: { ok: true },
    },
  });
  assert.equal(complete.status, 'reloaded');
  assert.equal(complete.outcome, 'complete_reload');
  assert.equal(complete.partial, false);
  assert.equal(complete.code, 'reload_succeeded');
  assert.equal(complete.presentationChecks.allServicesReloaded, true);
  assert.equal(complete.presentationChecks.partialReload, false);

  // Partial reload
  const partial = checkReloadOutcome({
    services: {
      nginx: { ok: true },
      mail: { ok: false }, // undefined error.code scenario
    },
  });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.outcome, 'partial_reload');
  assert.equal(partial.partial, true);
  assert.equal(partial.code, 'partial_reload');
  assert.equal(partial.presentationChecks.partialReload, true);
  assert.equal(partial.presentationChecks.hasFailures, true);

  const mail = partial.services.find((s) => s.service === 'mail');
  assert.equal(mail.ok, false);
  assert.equal(mail.code, 'service_reload_failed');
  assert.equal(mail.error.code, 'service_reload_failed');

  // All failed
  const failedAll = checkReloadOutcome({
    services: [
      { service: 'nginx', ok: false, error: { code: 'nginx_failed' } },
      { service: 'mail', ok: false, error: { code: 'mail_failed' } },
    ],
  });
  assert.equal(failedAll.status, 'failed');
  assert.equal(failedAll.outcome, 'reload_failed');
  assert.equal(failedAll.partial, false);
  assert.equal(failedAll.code, 'nginx_failed');
  assert.equal(failedAll.presentationChecks.allServicesReloaded, false);
  assert.equal(failedAll.presentationChecks.partialReload, false);
  assert.equal(failedAll.presentationChecks.hasFailures, true);
});

test('Restart scenario and post-restart status consistency: reload outcomes, diagnosis, and fail-closed corrupt store handling', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-cert-restart-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const filePath = path.join(dir, 'certificates.json');

  // Phase 1: Initial process creates cert and records partial reload outcome
  const registry1 = createCertificateRegistry({ filePath });
  await registry1.init();

  const cert = await registry1.createForDomain({
    domainId: 'domain-restart',
    serverId: 'server-restart',
    domains: ['restart.example.com'],
    email: 'admin@restart.example.com',
  });

  const validFrom = '2026-09-01T00:00:00.000Z';
  const validTo = '2026-12-01T00:00:00.000Z';
  const fingerprint256 = '77:'.repeat(31) + '77';

  await registry1.markActive(cert.id, {
    certName: 'restart.example.com',
    certificatePath: '/etc/letsencrypt/live/restart.example.com/cert.pem',
    fullchainPath: '/etc/letsencrypt/live/restart.example.com/fullchain.pem',
    privateKeyPath: '/etc/letsencrypt/live/restart.example.com/privkey.pem',
    validFrom,
    validTo,
    fingerprint256,
  });

  // Record a partial Nginx reload outcome
  await registry1.recordReloadOutcome(cert.id, {
    service: 'nginx',
    status: 'partial',
    stage: 'stage',
    error: 'Secondary listener configuration warning',
  });

  const certBeforeRestart = await registry1.getCertificate(cert.id);
  assert.equal(certBeforeRestart.state, 'active');
  assert.equal(certBeforeRestart.lastReloadOutcome.service, 'nginx');
  assert.equal(certBeforeRestart.lastReloadOutcome.status, 'partial');
  assert.equal(certBeforeRestart.diagnosis.code, 'certificate_reload_partial');
  assert.equal(certBeforeRestart.diagnosis.severity, 'warning');

  // Phase 2: Process restart (new instance loading from disk)
  const registryRestarted = createCertificateRegistry({ filePath });
  await registryRestarted.init();

  const certAfterRestart = await registryRestarted.getCertificate(cert.id);
  assert.ok(certAfterRestart);
  assert.equal(certAfterRestart.id, cert.id);
  assert.equal(certAfterRestart.state, 'active');
  assert.equal(certAfterRestart.validFrom, validFrom);
  assert.equal(certAfterRestart.validTo, validTo);
  assert.equal(certAfterRestart.fingerprint256, fingerprint256);
  assert.equal(certAfterRestart.lastReloadOutcome.service, 'nginx');
  assert.equal(certAfterRestart.lastReloadOutcome.status, 'partial');
  assert.equal(certAfterRestart.lastReloadOutcome.stage, 'stage');
  assert.equal(certAfterRestart.diagnosis.code, 'certificate_reload_partial');
  assert.equal(certAfterRestart.diagnosis.severity, 'warning');
  assert.match(certAfterRestart.diagnosis.message, /nginx reload completed partially/i);

  // Phase 3: Fail-closed validation on corrupted persisted store state
  const rawContent = JSON.parse(await readFile(filePath, 'utf8'));
  rawContent.certificates[0].lastReloadOutcome.status = 'corrupted_status';
  const corruptFile = path.join(dir, 'certificates_corrupt.json');
  await writeFile(corruptFile, JSON.stringify(rawContent, null, 2), 'utf8');

  const corruptRegistry = createCertificateRegistry({ filePath: corruptFile });
  await assert.rejects(
    async () => corruptRegistry.init(),
    (err) => err instanceof CertificateRegistryError && err.code === 'invalid_certificate_state',
  );
});

test('Mail identity post-issuance/renewal partial and failure outcomes (PROD-06 boundary)', async () => {
  const registry = createCertificateRegistry();
  const cert = await registry.createForDomain({
    domainId: 'domain-mail-id',
    serverId: 'server-mail-id',
    domains: ['mail.example.com'],
    email: 'admin@mail.example.com',
  });

  const validFrom = '2026-09-01T00:00:00.000Z';
  const validTo = '2026-12-01T00:00:00.000Z';
  const fingerprint256 = '88:'.repeat(31) + '88';

  await registry.markActive(cert.id, {
    certName: 'mail.example.com',
    certificatePath: '/etc/letsencrypt/live/mail.example.com/cert.pem',
    fullchainPath: '/etc/letsencrypt/live/mail.example.com/fullchain.pem',
    privateKeyPath: '/etc/letsencrypt/live/mail.example.com/privkey.pem',
    validFrom,
    validTo,
    fingerprint256,
  });

  const before = {
    certName: 'mail.example.com',
    validFrom: '2026-06-01T00:00:00.000Z',
    validTo: '2026-09-01T00:00:00.000Z',
    fingerprint256: '99:'.repeat(31) + '99',
  };

  const job = {
    status: 'succeeded',
    result: {
      certName: 'mail.example.com',
      status: 'renewed',
      validFrom,
      validTo,
      fingerprint256,
      dryRun: false,
    },
  };

  const liveTls = { validFrom, validTo, fingerprint256 };

  // 1. Mail identity assignment completed partially
  const partialRecord = await registry.recordReloadOutcome(cert.id, {
    service: 'mail_identity',
    status: 'partial',
    stage: 'identity',
    error: 'Dovecot SNI updated, Postfix cert map pending',
  });

  assert.equal(partialRecord.state, 'active');
  assert.equal(partialRecord.lastReloadOutcome.service, 'mail_identity');
  assert.equal(partialRecord.lastReloadOutcome.status, 'partial');

  const partialDiag = certificateDiagnosis(partialRecord);
  assert.equal(partialDiag.severity, 'warning');
  assert.equal(partialDiag.code, 'certificate_reload_partial');
  assert.equal(partialDiag.message, 'Certificate is valid, but mail service identity assignment completed partially.');
  assert.equal(partialDiag.action, 'Inspect mail service identity bindings and retry mail identity assignment.');

  // verifyRenewalOutcome with matching live TLS returns partial and verified: false
  const partialRenewalOutcome = verifyRenewalOutcome({
    certificate: partialRecord,
    before,
    job,
    liveTls,
  });
  assert.equal(partialRenewalOutcome.outcome, 'partial');
  assert.equal(partialRenewalOutcome.verified, false);
  assert.equal(partialRenewalOutcome.partial, true);
  assert.equal(partialRenewalOutcome.reason, 'post_ssl_mail_identity_assignment_failed');

  // 2. Mail identity assignment failed completely
  const failedRecord = await registry.recordReloadOutcome(cert.id, {
    service: 'mail_identity',
    status: 'failed',
    stage: 'identity',
    error: 'Mail identity daemon socket unreachable',
  });

  assert.equal(failedRecord.state, 'active');
  assert.equal(failedRecord.lastReloadOutcome.service, 'mail_identity');
  assert.equal(failedRecord.lastReloadOutcome.status, 'failed');

  const failedDiag = certificateDiagnosis(failedRecord);
  assert.equal(failedDiag.severity, 'warning');
  assert.equal(failedDiag.code, 'certificate_reload_failed');
  assert.equal(failedDiag.message, 'Certificate is valid, but mail service identity assignment failed.');
  assert.equal(failedDiag.action, 'Inspect mail service identity bindings and retry mail identity assignment.');

  // verifyRenewalOutcome with matching live TLS returns partial_service_reload and verified: false
  const failedRenewalOutcome = verifyRenewalOutcome({
    certificate: failedRecord,
    before,
    job,
    liveTls,
  });
  assert.equal(failedRenewalOutcome.outcome, 'partial_service_reload');
  assert.equal(failedRenewalOutcome.verified, false);
  assert.equal(failedRenewalOutcome.partial, true);
  assert.equal(failedRenewalOutcome.reason, 'post_ssl_mail_identity_assignment_failed');

  // 3. Succeeded mail identity assignment clears warning and verifies renewal
  const succeededRecord = await registry.recordReloadOutcome(cert.id, {
    service: 'mail_identity',
    status: 'succeeded',
  });
  assert.equal(succeededRecord.lastReloadOutcome.status, 'succeeded');
  assert.equal(certificateDiagnosis(succeededRecord, { now: Date.parse('2026-09-15T00:00:00.000Z') }), null);

  const cleanRenewalOutcome = verifyRenewalOutcome({
    certificate: succeededRecord,
    before,
    job,
    liveTls,
  });
  assert.equal(cleanRenewalOutcome.outcome, 'renewed_and_live_verified');
  assert.equal(cleanRenewalOutcome.verified, true);
});

test('recordReloadOutcome validates inputs fail-closed and protects retired certificates', async () => {
  const registry = createCertificateRegistry();
  const cert = await registry.createForDomain({
    domainId: 'domain-fc',
    serverId: 'server-fc',
    domains: ['fc.example.com'],
    email: 'admin@fc.example.com',
  });

  // Invalid service
  await assert.rejects(
    () => registry.recordReloadOutcome(cert.id, { service: '', status: 'succeeded' }),
    (err) => err instanceof CertificateRegistryError && err.code === 'invalid_reload_outcome_service',
  );
  await assert.rejects(
    () => registry.recordReloadOutcome(cert.id, { service: 'invalid service with spaces!', status: 'succeeded' }),
    (err) => err instanceof CertificateRegistryError && err.code === 'invalid_reload_outcome_service',
  );

  // Invalid status
  await assert.rejects(
    () => registry.recordReloadOutcome(cert.id, { service: 'nginx', status: 'unknown' }),
    (err) => err instanceof CertificateRegistryError && err.code === 'invalid_reload_outcome_status',
  );

  // Invalid stage
  await assert.rejects(
    () => registry.recordReloadOutcome(cert.id, { service: 'nginx', status: 'succeeded', stage: 'bad stage!' }),
    (err) => err instanceof CertificateRegistryError && err.code === 'invalid_reload_outcome_stage',
  );

  // Certificate not found
  await assert.rejects(
    () => registry.recordReloadOutcome('00000000-0000-0000-0000-000000000000', { service: 'nginx', status: 'succeeded' }),
    (err) => err instanceof CertificateRegistryError && err.code === 'certificate_not_found',
  );
});

test('Live TLS presentation vs persistent metadata equality: metadata equality is not live TLS proof', () => {
  const before = {
    certName: 'probe.example.com',
    validFrom: '2026-06-01T00:00:00.000Z',
    validTo: '2026-09-01T00:00:00.000Z',
    fingerprint256: 'AA:'.repeat(31) + 'AA',
  };

  const renewedCert = {
    certName: 'probe.example.com',
    state: 'active',
    validFrom: '2026-09-01T00:00:00.000Z',
    validTo: '2026-12-01T00:00:00.000Z',
    fingerprint256: 'BB:'.repeat(31) + 'BB',
  };

  const job = {
    status: 'succeeded',
    result: {
      certName: 'probe.example.com',
      status: 'renewed',
      validFrom: renewedCert.validFrom,
      validTo: renewedCert.validTo,
      fingerprint256: renewedCert.fingerprint256,
      dryRun: false,
    },
  };

  // Case A: Registry matches Job exactly (metadata equality), but live TLS is not provided
  // Metadata equality must NOT be considered live proof!
  const noLiveTls = verifyRenewalOutcome({
    certificate: renewedCert,
    before,
    job,
    liveTls: null,
  });
  assert.equal(noLiveTls.verified, false);
  assert.equal(noLiveTls.outcome, 'pending_live_tls_verification');
  assert.equal(noLiveTls.reason, 'live_tls_presentation_missing');
  assert.equal(noLiveTls.storedFingerprint, renewedCert.fingerprint256);

  // Case B: Live TLS probe returns old certificate before server reload
  const oldTls = verifyRenewalOutcome({
    certificate: renewedCert,
    before,
    job,
    liveTls: {
      validFrom: before.validFrom,
      validTo: before.validTo,
      fingerprint256: before.fingerprint256,
    },
  });
  assert.equal(oldTls.verified, false);
  assert.equal(oldTls.outcome, 'pending_service_reload');
  assert.equal(oldTls.reason, 'live_tls_presents_previous_certificate');

  // Case C: Live TLS probe returns completely different certificate
  const mismatchedTls = verifyRenewalOutcome({
    certificate: renewedCert,
    before,
    job,
    liveTls: {
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2026-04-01T00:00:00.000Z',
      fingerprint256: 'CC:'.repeat(31) + 'CC',
    },
  });
  assert.equal(mismatchedTls.verified, false);
  assert.equal(mismatchedTls.outcome, 'live_tls_mismatch');
  assert.equal(mismatchedTls.reason, 'fingerprint_mismatch');

  // Case D: Live TLS matches new certificate -> verified: true
  const verifiedTls = verifyRenewalOutcome({
    certificate: renewedCert,
    before,
    job,
    liveTls: {
      validFrom: renewedCert.validFrom,
      validTo: renewedCert.validTo,
      fingerprint256: renewedCert.fingerprint256,
    },
  });
  assert.equal(verifiedTls.verified, true);
  assert.equal(verifiedTls.outcome, 'renewed_and_live_verified');
});

test('renewalOutcome returns syncing if validTo or validFrom differs between job result and certificate', () => {
  const beforeCert = {
    validFrom: '2026-06-01T00:00:00.000Z',
    validTo: '2026-09-01T00:00:00.000Z',
    fingerprint256: sampleFingerprint.toUpperCase(),
  };

  const renewedJob = {
    status: 'succeeded',
    result: {
      fingerprint256: renewedFingerprint,
      validFrom: '2026-09-01T00:00:00.000Z',
      validTo: '2026-12-01T00:00:00.000Z',
    },
  };

  // Case 1: Fingerprint matches but validTo not yet updated in certificate
  const staleValidToCert = {
    state: 'active',
    fingerprint256: renewedFingerprint.toUpperCase(),
    validFrom: '2026-09-01T00:00:00.000Z',
    validTo: '2026-09-01T00:00:00.000Z',
  };
  assert.equal(renewalOutcome(renewedJob, beforeCert, staleValidToCert, false), 'syncing');

  // Case 2: Fingerprint matches but validFrom not yet updated in certificate
  const staleValidFromCert = {
    state: 'active',
    fingerprint256: renewedFingerprint.toUpperCase(),
    validFrom: '2026-06-01T00:00:00.000Z',
    validTo: '2026-12-01T00:00:00.000Z',
  };
  assert.equal(renewalOutcome(renewedJob, beforeCert, staleValidFromCert, false), 'syncing');

  // Case 3: Both validFrom and validTo match -> renewed
  const fullySyncedCert = {
    state: 'active',
    fingerprint256: renewedFingerprint.toUpperCase(),
    validFrom: '2026-09-01T00:00:00.000Z',
    validTo: '2026-12-01T00:00:00.000Z',
  };
  assert.equal(renewalOutcome(renewedJob, beforeCert, fullySyncedCert, false), 'renewed');
});

test('completed renewal job reconciliation updates validFrom, validTo, fingerprint and attaches to domain', async () => {
  const certificateRegistry = createCertificateRegistry();
  const domainRegistry = createDomainRegistry();
  const jobRegistry = createJobRegistry();
  const serverId = 'server-rec-test';

  const domain = await domainRegistry.createDomain({
    serverId,
    primaryDomain: 'renewal-reconcile.example.com',
    aliases: [],
    targetType: 'proxy',
    target: { upstreamPort: 8080 },
    httpsMode: 'managed',
  });

  const cert = await certificateRegistry.createForDomain({
    domainId: domain.id,
    serverId,
    domains: ['renewal-reconcile.example.com'],
    email: 'admin@example.com',
  });

  const oldFp = '11:'.repeat(31) + '11';
  await certificateRegistry.markActive(cert.id, {
    certName: 'renewal-reconcile.example.com',
    certificatePath: '/etc/letsencrypt/live/renewal-reconcile.example.com/cert.pem',
    fullchainPath: '/etc/letsencrypt/live/renewal-reconcile.example.com/fullchain.pem',
    privateKeyPath: '/etc/letsencrypt/live/renewal-reconcile.example.com/privkey.pem',
    validFrom: '2026-06-01T00:00:00.000Z',
    validTo: '2026-09-01T00:00:00.000Z',
    fingerprint256: oldFp,
  });

  // Enqueue a renewal job
  const newFp = '22:'.repeat(31) + '22';
  await jobRegistry.enqueue({
    serverId,
    type: 'ssl.renew',
    operation: OPERATIONS.SSL_RENEW,
    payload: { certName: 'renewal-reconcile.example.com', dryRun: false },
    resourceType: 'certificate',
    resourceId: cert.id,
  });

  const renewedResult = {
    certName: 'renewal-reconcile.example.com',
    certificatePath: '/etc/letsencrypt/live/renewal-reconcile.example.com/cert.pem',
    fullchainPath: '/etc/letsencrypt/live/renewal-reconcile.example.com/fullchain.pem',
    privateKeyPath: '/etc/letsencrypt/live/renewal-reconcile.example.com/privkey.pem',
    validFrom: '2026-09-01T00:00:00.000Z',
    validTo: '2026-12-01T00:00:00.000Z',
    fingerprint256: newFp,
    dryRun: false,
    status: 'renewed',
  };

  await completeNextJob(jobRegistry, {
    serverId,
    certificateRegistry,
    domainRegistry,
    status: 'succeeded',
    result: renewedResult,
  });

  // Check persistent certificate has new dates and fingerprint
  const updatedCert = await certificateRegistry.getCertificate(cert.id);
  assert.equal(updatedCert.state, 'active');
  assert.equal(updatedCert.fingerprint256, newFp);
  assert.equal(updatedCert.validTo, '2026-12-01T00:00:00.000Z');
  assert.equal(updatedCert.validFrom, '2026-09-01T00:00:00.000Z');
  assert.ok(updatedCert.lastRenewedAt);

  // Check domain relationship is attached
  const updatedDomain = await domainRegistry.getDomain(domain.id);
  assert.equal(updatedDomain.certificateId, cert.id);
});
