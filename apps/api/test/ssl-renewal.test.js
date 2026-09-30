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
} from '../src/certificate-registry.js';
import {
  verifyRenewalOutcome,
  verifyCertificateRenewalOutcome,
  runCertificateRenewalSweep,
  startCertificateRenewalScheduler,
} from '../src/certificate-renewal-scheduler.js';
import { createJobRegistry } from '../src/job-registry.js';

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
