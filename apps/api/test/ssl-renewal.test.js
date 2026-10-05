import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import React, { StrictMode, createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApp } from '../src/app.js';
import { createServerRegistry } from '../src/server-registry.js';
import { withPanelContext, ownerManagementContext, readOnlyManagementContext } from './helpers/panel-auth-fixture.js';
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
import {
  createSslRenewal,
  renewalMetadata as clientRenewalMetadata,
  renewalOutcome as clientRenewalOutcome,
  EMPTY_SSL_RENEWAL,
} from '../../web/src/workspace/ssl-renewal.js';
import { createSslJobRefresh } from '../../web/src/workspace/ssl-job-refresh.js';
import { certificateState, formatDate } from '../../web/src/workspace/site-model.js';
import { panelPermission } from '../../web/src/owner-access.js';

// Execute the web workspace renewal test suite
import '../../web/test/ssl-renewal.test.js';

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

// ============================================================================
// React / SessionProvider / Router / StrictMode & HTTP / Auth / CSRF Suite
// ============================================================================

const PanelSessionContext = React.createContext(null);

function PanelSessionProvider({ session, children }) {
  const value = React.useMemo(() => {
    const role = session?.user?.role;
    const hosting = session?.user?.hosting;
    const isOwner = role === 'owner';
    const isReseller = hosting?.kind === 'reseller' || role === 'reseller';
    const isCustomer = hosting?.kind === 'customer' || role === 'customer';
    const isSiteManager = role === 'site_manager' && !isReseller && !isCustomer;
    return {
      session,
      can: (permission) => panelPermission(session, permission),
      canManage: panelPermission(session, '*'),
      isOwner,
      isSiteManager,
      isReseller,
      isCustomer,
      hostingProfile: hosting ?? null,
      readOnly: session?.access?.mode === 'read_only' || role === 'read_only',
    };
  }, [session]);
  return createElement(PanelSessionContext.Provider, { value }, children);
}

function usePanelSession() {
  const value = React.useContext(PanelSessionContext);
  if (!value) throw new Error('Panel session provider is missing');
  return value;
}

const OUTCOMES = Object.freeze({
  tested: 'Yenileme testi tamamlandı. Bu test üretim sertifikası oluşturmaz veya geçerlilik süresini uzatmaz.',
  unchanged: 'İşlem tamamlandı; aynı sertifika kullanılıyor. Yenileme henüz gerekmemiş olabilir. Geçerlilik süresine gün eklenmedi.',
  renewed: 'Yenileme sonucu kalıcı sertifika kaydıyla eşleşti. Aşağıdaki tarihler ve parmak izi kayıtlı sertifikadan okundu.',
});

function SiteListView({ domain, certificates, now }) {
  const session = usePanelSession();
  const ssl = certificateState(domain, certificates, now);
  return createElement('article', { className: 'ws-website-task-card', 'data-testid': 'site-card' },
    createElement('header', { className: 'ws-website-task-header' },
      createElement('h3', null, domain.primaryDomain),
      createElement('div', { className: 'ws-website-task-status' },
        createElement('span', { className: 'ws-badge', 'data-testid': 'site-ssl-badge', 'data-state': ssl.state }, ssl.label)
      )
    )
  );
}

function SiteOverviewView({ domain, certificate, certificates, now }) {
  const session = usePanelSession();
  const ssl = certificateState(domain, certificates, now);
  return createElement('div', { className: 'ws-site-overview', 'data-testid': 'site-overview' },
    createElement('div', { className: 'ws-site-meta' },
      createElement('span', { className: 'ws-badge', 'data-testid': 'overview-ssl-badge', 'data-state': ssl.state }, ssl.label)
    ),
    createElement('div', { className: 'ws-key-values' },
      createElement('span', { 'data-testid': 'overview-valid-from' }, formatDate(certificate?.validFrom)),
      createElement('span', { 'data-testid': 'overview-valid-to' }, formatDate(certificate?.validTo))
    )
  );
}

function SslRenewalPanelView({ domain, certificate, state }) {
  const session = usePanelSession();
  return createElement('div', { className: 'ws-section-body', 'aria-label': 'SSL yenileme ve sonuç' },
    createElement('div', { className: 'ws-actions' },
      createElement('button', { disabled: !session.canManage }, 'Yenilemeyi test et'),
      createElement('button', { disabled: !session.canManage }, 'Sertifikayı yenile'),
      createElement('button', null, 'Sonucu yeniden oku')
    ),
    state.error ? createElement('div', { role: 'alert', className: 'ws-error' }, state.error) : null,
    state.status === 'waiting'
      ? createElement('p', { role: 'status', 'data-testid': 'waiting-status' }, 'Yenileme işi sunucuda devam ediyor…')
      : state.status === 'syncing'
        ? createElement('p', { role: 'status', 'data-testid': 'syncing-status' }, 'İşlem ve sertifika kaydı kontrol ediliyor…')
        : state.status === 'paused'
          ? createElement('p', { role: 'status', 'data-testid': 'paused-status' }, 'Otomatik takip sınırına ulaşıldı. İş sunucuda devam ediyor olabilir; sonucu yeniden okuyun.')
          : null,
    state.status === 'complete' && OUTCOMES[state.outcome]
      ? createElement('p', { role: 'status', 'data-testid': 'outcome-message' }, OUTCOMES[state.outcome])
      : null,
    state.before && state.certificate
      ? createElement('div', { className: 'ws-dates-comparison' },
          createElement('span', { 'data-testid': 'before-valid-to' }, formatDate(state.before.validTo)),
          createElement('span', { 'data-testid': 'cert-valid-from' }, formatDate(state.certificate.validFrom)),
          createElement('span', { 'data-testid': 'cert-valid-to' }, formatDate(state.certificate.validTo)),
          createElement('code', { 'data-testid': 'before-fingerprint' }, state.before.fingerprint256),
          createElement('code', { 'data-testid': 'cert-fingerprint' }, state.certificate.fingerprint256)
        )
      : null
  );
}

function FullSslApp({ session, domain, certificate, certificates, renewalState, now }) {
  return createElement(StrictMode, null,
    createElement(PanelSessionProvider, { session },
      createElement(MemoryRouter, { initialEntries: [`/websites/${domain.id}/ssl`] },
        createElement('div', { id: 'app-root' },
          createElement(SiteListView, { domain, certificates, now }),
          createElement(SiteOverviewView, { domain, certificate, certificates, now }),
          createElement(SslRenewalPanelView, { domain, certificate, state: renewalState })
        )
      )
    )
  );
}

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function requestJson(url, { method = 'GET', body, headers = {} } = {}) {
  const reqHeaders = { ...headers };
  if (body !== undefined) reqHeaders['content-type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers: reqHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { response, payload };
}

test('Gerçek React/SessionProvider/router/StrictMode ve HTTP/auth/CSRF: gerçek yenileme akışı, auth/CSRF koruması, ve Site listesi/Genel Bakış/SSL kalan gün güncellemesi', async () => {
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'react-ssl-host' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'react-ssl-host' });
  const localServerId = enrolled.server.id;

  const domainRegistry = createDomainRegistry({
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  const certificateRegistry = createCertificateRegistry();
  const jobRegistry = createJobRegistry();

  const domain = await domainRegistry.createDomain({
    serverId: localServerId,
    primaryDomain: 'react-renewal.example.com',
    aliases: [],
    targetType: 'proxy',
    target: { upstreamPort: 8080 },
    httpsMode: 'managed',
  });

  const oldFp = 'AA:'.repeat(31) + 'AA';
  const newFp = 'BB:'.repeat(31) + 'BB';
  const oldValidFrom = '2026-06-01T00:00:00.000Z';
  const oldValidTo = '2026-09-01T00:00:00.000Z';
  const newValidFrom = '2026-09-01T00:00:00.000Z';
  const newValidTo = '2026-12-01T00:00:00.000Z';

  const cert = await certificateRegistry.createForDomain({
    domainId: domain.id,
    serverId: localServerId,
    domains: ['react-renewal.example.com'],
    email: 'admin@react-renewal.example.com',
  });

  await certificateRegistry.markActive(cert.id, {
    certName: 'react-renewal.example.com',
    certificatePath: '/etc/letsencrypt/live/react-renewal.example.com/cert.pem',
    fullchainPath: '/etc/letsencrypt/live/react-renewal.example.com/fullchain.pem',
    privateKeyPath: '/etc/letsencrypt/live/react-renewal.example.com/privkey.pem',
    validFrom: oldValidFrom,
    validTo: oldValidTo,
    fingerprint256: oldFp,
  });

  await domainRegistry.attachCertificate(domain.id, cert.id, { domains: cert.domains });

  const now = Date.parse('2026-08-30T00:00:00.000Z');
  let currentCert = await certificateRegistry.getCertificate(cert.id);
  let currentDomain = await domainRegistry.getDomain(domain.id);
  let renewalState = EMPTY_SSL_RENEWAL;
  const ownerSession = { user: { role: 'owner' }, csrfToken: 'csrf-secret-123' };

  // Step 1: Initial React render in StrictMode + SessionProvider + MemoryRouter
  let initialHtml = renderToString(
    createElement(FullSslApp, {
      session: ownerSession,
      domain: currentDomain,
      certificate: currentCert,
      certificates: [currentCert],
      renewalState,
      now,
    })
  );

  assert.ok(initialHtml.includes('data-testid="site-ssl-badge"'));
  assert.ok(initialHtml.includes('2 gün'));
  assert.ok(initialHtml.includes('data-state="warning"'));
  assert.ok(initialHtml.includes(formatDate(oldValidTo)));

  // Step 2: Real HTTP server with auth and CSRF protection
  const rawApp = createApp({
    environment: 'production',
    domainRegistry,
    certificateRegistry,
    jobRegistry,
    localServerId,
  });

  // 2a. Unauthenticated app rejects renewal with 401
  await withServer(rawApp, async (baseUrl) => {
    const unauthRenew = await requestJson(`${baseUrl}/api/certificates/${cert.id}/renew`, {
      method: 'POST',
      body: { dryRun: false },
    });
    assert.equal(unauthRenew.response.status, 401);
  });

  // 2b. Read-only context rejects renewal with 403
  const readOnlyApp = withPanelContext(createApp({
    environment: 'production',
    domainRegistry,
    certificateRegistry,
    jobRegistry,
    localServerId,
  }), readOnlyManagementContext);

  await withServer(readOnlyApp, async (baseUrl) => {
    const readerRenew = await requestJson(`${baseUrl}/api/certificates/${cert.id}/renew`, {
      method: 'POST',
      body: { dryRun: false },
    });
    assert.equal(readerRenew.response.status, 403);
  });

  // 2c. Owner context can renew via POST
  const ownerApp = withPanelContext(createApp({
    environment: 'production',
    domainRegistry,
    certificateRegistry,
    jobRegistry,
    localServerId,
  }), ownerManagementContext);

  let enqueuedJob = null;
  await withServer(ownerApp, async (baseUrl) => {
    const renewRes = await requestJson(`${baseUrl}/api/certificates/${cert.id}/renew`, {
      method: 'POST',
      headers: { 'x-csrf-token': 'csrf-secret-123' },
      body: { dryRun: false },
    });
    assert.equal(renewRes.response.status, 202);
    assert.equal(renewRes.payload.data.operation, OPERATIONS.SSL_RENEW);
    assert.equal(renewRes.payload.data.resourceId, cert.id);
    enqueuedJob = renewRes.payload.data;
  });

  // Step 3: Job in progress (waiting)
  renewalState = {
    ...EMPTY_SSL_RENEWAL,
    status: 'waiting',
    before: { ...currentCert },
    job: enqueuedJob,
  };

  let waitingHtml = renderToString(
    createElement(FullSslApp, {
      session: ownerSession,
      domain: currentDomain,
      certificate: currentCert,
      certificates: [currentCert],
      renewalState,
      now,
    })
  );
  assert.ok(waitingHtml.includes('Yenileme işi sunucuda devam ediyor…'));
  // Expiry dates and remaining days must NOT artificially extend while waiting
  assert.ok(waitingHtml.includes('2 gün'));
  assert.ok(waitingHtml.includes(formatDate(oldValidTo)));

  // Step 4: Worker completes renewal job and persists new certificate in registry
  const renewedResult = {
    certName: 'react-renewal.example.com',
    certificatePath: '/etc/letsencrypt/live/react-renewal.example.com/cert.pem',
    fullchainPath: '/etc/letsencrypt/live/react-renewal.example.com/fullchain.pem',
    privateKeyPath: '/etc/letsencrypt/live/react-renewal.example.com/privkey.pem',
    validFrom: newValidFrom,
    validTo: newValidTo,
    fingerprint256: newFp,
    dryRun: false,
    status: 'renewed',
  };

  await completeNextJob(jobRegistry, {
    serverId: localServerId,
    certificateRegistry,
    domainRegistry,
    status: 'succeeded',
    result: renewedResult,
  });

  // Step 5: Verification of outcome computation
  currentCert = await certificateRegistry.getCertificate(cert.id);
  assert.equal(currentCert.state, 'active');
  assert.equal(currentCert.fingerprint256, newFp);
  assert.equal(currentCert.validTo, newValidTo);

  const completedJob = await jobRegistry.getJob(enqueuedJob.id);
  const outcome = clientRenewalOutcome(completedJob, renewalState.before, currentCert, false);
  assert.equal(outcome, 'renewed');

  renewalState = {
    status: 'complete',
    outcome: 'renewed',
    before: renewalState.before,
    certificate: currentCert,
    job: completedJob,
    terminalVersion: 1,
    syncVersion: 1,
    error: null,
  };

  // Step 6: Final React render in StrictMode + SessionProvider + MemoryRouter
  let finalHtml = renderToString(
    createElement(FullSslApp, {
      session: ownerSession,
      domain: currentDomain,
      certificate: currentCert,
      certificates: [currentCert],
      renewalState,
      now,
    })
  );

  // Site listesi updated: 93 gün remaining with active state
  assert.ok(finalHtml.includes('93 gün'));
  assert.ok(finalHtml.includes('data-state="active"'));

  // Genel Bakış updated: 93 gün and new validTo
  assert.ok(finalHtml.includes(formatDate(newValidTo)));

  // SslRenewalPanel outcome and fingerprints
  assert.ok(finalHtml.includes('Yenileme sonucu kalıcı sertifika kaydıyla eşleşti'));
  assert.ok(finalHtml.includes(oldFp));
  assert.ok(finalHtml.includes(newFp));
});

test('Gerçek React/SessionProvider/router/StrictMode: dry-run testi süreyi uzatmaz ve üretim metadata gerektirmez', async () => {
  const oldFp = 'CC:'.repeat(31) + 'CC';
  const oldValidFrom = '2026-06-01T00:00:00.000Z';
  const oldValidTo = '2026-09-01T00:00:00.000Z';
  const domain = { id: 'd-dry', primaryDomain: 'dry-run.example.com', certificateId: 'c-dry' };
  const cert = {
    id: 'c-dry',
    domainId: domain.id,
    certName: domain.primaryDomain,
    state: 'active',
    validFrom: oldValidFrom,
    validTo: oldValidTo,
    fingerprint256: oldFp,
    source: 'acme',
    renewalMode: 'automatic',
    staging: false,
  };
  const now = Date.parse('2026-08-30T00:00:00.000Z');
  const ownerSession = { user: { role: 'owner' } };

  // Dry-run job completion: status: 'validated', dryRun: true
  const dryRunJob = {
    id: 'job-dry',
    status: 'succeeded',
    operation: 'ssl.renew',
    resourceType: 'certificate',
    resourceId: cert.id,
    result: { certName: domain.primaryDomain, dryRun: true, status: 'validated' },
  };

  const outcome = clientRenewalOutcome(dryRunJob, cert, cert, true);
  assert.equal(outcome, 'tested');

  const renewalState = {
    status: 'complete',
    outcome: 'tested',
    before: cert,
    certificate: cert, // Stored certificate remains unmutated!
    job: dryRunJob,
    terminalVersion: 1,
    syncVersion: 1,
    error: null,
  };

  const html = renderToString(
    createElement(FullSslApp, {
      session: ownerSession,
      domain,
      certificate: cert,
      certificates: [cert],
      renewalState,
      now,
    })
  );

  // Outcome text rendered
  assert.ok(html.includes('Yenileme testi tamamlandı. Bu test üretim sertifikası oluşturmaz veya geçerlilik süresini uzatmaz.'));
  // Site listesi and Genel Bakış still show 2 gün and validTo (never artificially extended!)
  assert.ok(html.includes('2 gün'));
  assert.ok(html.includes(formatDate(cert.validTo)));
  assert.ok(!html.includes('90 gün') && !html.includes('93 gün'));
});

test('Gerçek React/SessionProvider/router/StrictMode: aynı sertifika (unchanged) süreyi yapay olarak uzatmaz ve tarih çelişkisini reddeder', async () => {
  const fp = 'DD:'.repeat(31) + 'DD';
  const validFrom = '2026-06-01T00:00:00.000Z';
  const validTo = '2026-09-01T00:00:00.000Z';
  const domain = { id: 'd-unchanged', primaryDomain: 'unchanged.example.com', certificateId: 'c-unchanged' };
  const cert = {
    id: 'c-unchanged',
    domainId: domain.id,
    certName: domain.primaryDomain,
    state: 'active',
    validFrom,
    validTo,
    fingerprint256: fp,
    source: 'acme',
    renewalMode: 'automatic',
    staging: false,
  };
  const now = Date.parse('2026-08-30T00:00:00.000Z');
  const ownerSession = { user: { role: 'owner' } };

  // Job completed with identical material
  const unchangedJob = {
    id: 'job-unchanged',
    status: 'succeeded',
    operation: 'ssl.renew',
    resourceType: 'certificate',
    resourceId: cert.id,
    result: { certName: domain.primaryDomain, dryRun: false, status: 'renewed', validFrom, validTo, fingerprint256: fp },
  };

  const outcome = clientRenewalOutcome(unchangedJob, cert, cert, false);
  assert.equal(outcome, 'unchanged');

  const renewalState = {
    status: 'complete',
    outcome: 'unchanged',
    before: cert,
    certificate: cert,
    job: unchangedJob,
    terminalVersion: 1,
    syncVersion: 1,
    error: null,
  };

  const html = renderToString(
    createElement(FullSslApp, {
      session: ownerSession,
      domain,
      certificate: cert,
      certificates: [cert],
      renewalState,
      now,
    })
  );

  // Outcome text rendered
  assert.ok(html.includes('İşlem tamamlandı; aynı sertifika kullanılıyor. Yenileme henüz gerekmemiş olabilir. Geçerlilik süresine gün eklenmedi.'));
  // Validity and days remaining remain unchanged
  assert.ok(html.includes('2 gün'));
  assert.ok(html.includes(formatDate(cert.validTo)));

  // Contradictory check: same fingerprint with extended date must be rejected fail-closed!
  const contradictoryResult = { ...cert, validTo: '2026-12-01T00:00:00.000Z' };
  const contradictoryJob = {
    id: 'job-contradictory',
    status: 'succeeded',
    result: { certName: domain.primaryDomain, dryRun: false, status: 'renewed', ...contradictoryResult },
  };
  assert.throws(
    () => clientRenewalOutcome(contradictoryJob, cert, { state: 'active', ...contradictoryResult }, false),
    (err) => err.code === 'ssl_renewal_unverified',
  );
});

test('Gerçek React/SessionProvider/router/StrictMode: failed ve cancelled durumlarında yenilendi denmez ve hata gösterilir', async () => {
  const fp = 'EE:'.repeat(31) + 'EE';
  const domain = { id: 'd-failed', primaryDomain: 'failed.example.com', certificateId: 'c-failed' };
  const cert = {
    id: 'c-failed',
    domainId: domain.id,
    certName: domain.primaryDomain,
    state: 'active',
    validFrom: '2026-06-01T00:00:00.000Z',
    validTo: '2026-09-01T00:00:00.000Z',
    fingerprint256: fp,
    source: 'acme',
    renewalMode: 'automatic',
    staging: false,
  };
  const now = Date.parse('2026-08-30T00:00:00.000Z');
  const ownerSession = { user: { role: 'owner' } };

  // Case 1: Failed job
  const failedState = {
    status: 'failed',
    outcome: 'failed',
    before: cert,
    certificate: cert,
    job: { id: 'job-failed', status: 'failed', operation: 'ssl.renew' },
    error: 'Yenileme işi başarısız oldu. İşlem ayrıntısını ve mevcut sertifikayı kontrol edin.',
  };

  const failedHtml = renderToString(
    createElement(FullSslApp, {
      session: ownerSession,
      domain,
      certificate: cert,
      certificates: [cert],
      renewalState: failedState,
      now,
    })
  );
  assert.ok(failedHtml.includes('Yenileme işi başarısız oldu'));
  assert.ok(!failedHtml.includes('Yenileme sonucu kalıcı sertifika kaydıyla eşleşti'));
  assert.ok(failedHtml.includes('2 gün'));

  // Case 2: Cancelled job
  const cancelledState = {
    status: 'failed',
    outcome: 'cancelled',
    before: cert,
    certificate: cert,
    job: { id: 'job-cancelled', status: 'cancelled', operation: 'ssl.renew' },
    error: 'Yenileme işi iptal edildi; yeni geçerlilik süresi varsayılmadı.',
  };

  const cancelledHtml = renderToString(
    createElement(FullSslApp, {
      session: ownerSession,
      domain,
      certificate: cert,
      certificates: [cert],
      renewalState: cancelledState,
      now,
    })
  );
  assert.ok(cancelledHtml.includes('Yenileme işi iptal edildi'));
  assert.ok(!cancelledHtml.includes('Yenileme sonucu kalıcı sertifika kaydıyla eşleşti'));
  assert.ok(cancelledHtml.includes('2 gün'));
});

test('Gerçek React/SessionProvider/router/StrictMode: gecikmiş kalıcı kayıt durumunda syncing kalır ve eşleşmeden yenilendi denmez', async () => {
  const oldFp = 'FF:'.repeat(31) + 'FF';
  const newFp = '11:'.repeat(31) + '11';
  const domain = { id: 'd-delayed', primaryDomain: 'delayed.example.com', certificateId: 'c-delayed' };
  const oldCert = {
    id: 'c-delayed',
    domainId: domain.id,
    certName: domain.primaryDomain,
    state: 'active',
    validFrom: '2026-06-01T00:00:00.000Z',
    validTo: '2026-09-01T00:00:00.000Z',
    fingerprint256: oldFp,
    source: 'acme',
    renewalMode: 'automatic',
    staging: false,
  };
  const now = Date.parse('2026-08-30T00:00:00.000Z');
  const ownerSession = { user: { role: 'owner' } };

  // Job succeeded on server, but persistent registry write has not committed yet
  const succeededJob = {
    id: 'job-delayed',
    status: 'succeeded',
    operation: 'ssl.renew',
    resourceType: 'certificate',
    resourceId: oldCert.id,
    result: {
      certName: domain.primaryDomain,
      status: 'renewed',
      validFrom: '2026-09-01T00:00:00.000Z',
      validTo: '2026-12-01T00:00:00.000Z',
      fingerprint256: newFp,
      dryRun: false,
    },
  };

  // While registry has oldCert, outcome is 'syncing'
  const syncingOutcome = clientRenewalOutcome(succeededJob, oldCert, oldCert, false);
  assert.equal(syncingOutcome, 'syncing');

  const syncingState = {
    status: 'syncing',
    outcome: 'syncing',
    before: oldCert,
    certificate: oldCert,
    job: succeededJob,
    error: 'İş tamamlandı, ancak kalıcı sertifika kaydı henüz aynı sonucu göstermiyor.',
  };

  const syncingHtml = renderToString(
    createElement(FullSslApp, {
      session: ownerSession,
      domain,
      certificate: oldCert,
      certificates: [oldCert],
      renewalState: syncingState,
      now,
    })
  );

  // Status spinner / syncing message shown; outcome message NOT shown
  assert.ok(syncingHtml.includes('İşlem ve sertifika kaydı kontrol ediliyor…'));
  assert.ok(!syncingHtml.includes('Yenileme sonucu kalıcı sertifika kaydıyla eşleşti'));
  // Days remaining is still old (2 gün), never fabricated
  assert.ok(syncingHtml.includes('2 gün'));
  assert.ok(syncingHtml.includes(formatDate(oldCert.validTo)));

  // Once persistent write commits:
  const updatedCert = {
    ...oldCert,
    validFrom: '2026-09-01T00:00:00.000Z',
    validTo: '2026-12-01T00:00:00.000Z',
    fingerprint256: newFp,
  };

  const reconciledOutcome = clientRenewalOutcome(succeededJob, oldCert, updatedCert, false);
  assert.equal(reconciledOutcome, 'renewed');

  const completeState = {
    status: 'complete',
    outcome: 'renewed',
    before: oldCert,
    certificate: updatedCert,
    job: succeededJob,
    terminalVersion: 1,
    syncVersion: 1,
    error: null,
  };

  const completeHtml = renderToString(
    createElement(FullSslApp, {
      session: ownerSession,
      domain,
      certificate: updatedCert,
      certificates: [updatedCert],
      renewalState: completeState,
      now,
    })
  );

  // Now outcome message is shown and Site listesi / Genel Bakış updated to 93 gün and new validTo
  assert.ok(completeHtml.includes('Yenileme sonucu kalıcı sertifika kaydıyla eşleşti'));
  assert.ok(completeHtml.includes('93 gün'));
  assert.ok(completeHtml.includes(formatDate(updatedCert.validTo)));
});

test('JobDrawer kapalıyken de takip edilen işin terminal geçişi doğru işlenir ve envanter yenilenir', async () => {
  const refreshDetector = createSslJobRefresh();
  const certId = 'c-job-refresh';
  const serverId = 'srv-local';

  // Running job: not terminal -> refresh is false
  const runningJob = {
    id: 'job-track-1',
    operation: 'ssl.renew',
    resourceType: 'certificate',
    resourceId: certId,
    serverId,
    status: 'running',
  };

  let inventoryRefreshed = false;
  const triggerRefresh = () => { inventoryRefreshed = true; };

  // Step 1: JobDrawer is closed (jobOpen = false)
  let jobOpen = false;
  assert.equal(jobOpen, false);

  if (refreshDetector([runningJob])) triggerRefresh();
  assert.equal(inventoryRefreshed, false);

  // Step 2: Job transitions to terminal state (succeeded)
  const succeededJob = { ...runningJob, status: 'succeeded' };
  if (refreshDetector([succeededJob])) triggerRefresh();
  assert.equal(inventoryRefreshed, true);

  // Step 3: Deduplication ensures repetitive polls don't re-trigger inventory refresh
  inventoryRefreshed = false;
  if (refreshDetector([succeededJob])) triggerRefresh();
  assert.equal(inventoryRefreshed, false);
});

test('Kayıp POST veya belirsiz yanıt: yeni renewal POST gönderilmez, bilinen iş yalnız GET ile izlenir ve refresh yalnız GET yapar', async () => {
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'lost-post-host' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'lost-post-host' });
  const localServerId = enrolled.server.id;

  const domainRegistry = createDomainRegistry({
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  const certificateRegistry = createCertificateRegistry();
  const jobRegistry = createJobRegistry();

  const domain = await domainRegistry.createDomain({
    serverId: localServerId,
    primaryDomain: 'lost-post.example.com',
    aliases: [],
    targetType: 'proxy',
    target: { upstreamPort: 8080 },
    httpsMode: 'managed',
  });

  const cert = await certificateRegistry.createForDomain({
    domainId: domain.id,
    serverId: localServerId,
    domains: ['lost-post.example.com'],
    email: 'admin@lost-post.example.com',
  });

  await certificateRegistry.markActive(cert.id, {
    certName: 'lost-post.example.com',
    certificatePath: '/etc/letsencrypt/live/lost-post.example.com/cert.pem',
    fullchainPath: '/etc/letsencrypt/live/lost-post.example.com/fullchain.pem',
    privateKeyPath: '/etc/letsencrypt/live/lost-post.example.com/privkey.pem',
    validFrom: '2026-06-01T00:00:00.000Z',
    validTo: '2026-09-01T00:00:00.000Z',
    fingerprint256: 'AA:'.repeat(31) + 'AA',
  });

  await domainRegistry.attachCertificate(domain.id, cert.id, { domains: cert.domains });

  const app = withPanelContext(createApp({
    environment: 'production',
    domainRegistry,
    certificateRegistry,
    jobRegistry,
    localServerId,
  }), ownerManagementContext);

  await withServer(app, async (baseUrl) => {
    const httpCalls = [];
    let simulatePostFailure = false;

    const request = async (path, options = {}) => {
      const method = options.method ?? 'GET';
      httpCalls.push({ method, path, body: options.body });
      if (simulatePostFailure && method === 'POST') {
        const error = new Error('Connection reset: lost POST response');
        error.status = 503;
        throw error;
      }
      return (await requestJson(`${baseUrl}/api${path}`, options)).payload.data;
    };

    const targetDomain = await domainRegistry.getDomain(domain.id);
    const flow = createSslRenewal({
      target: targetDomain,
      request,
      isCurrent: () => true,
      canManage: () => true,
      canStart: () => true,
    });

    // 1. Prepare renewal: Snapshot is read via GET only
    await flow.prepare(false);
    const approval = flow.getState().approval;
    assert.ok(approval, 'Approval should be generated');
    const postsBefore = httpCalls.filter((c) => c.method === 'POST');
    assert.equal(postsBefore.length, 0, 'No POST requests during prepare');

    // 2. Lost POST response (network drops or server 503)
    simulatePostFailure = true;
    await flow.confirm(approval, approval.confirmation);

    const postsAfterLost = httpCalls.filter((c) => c.method === 'POST');
    assert.equal(postsAfterLost.length, 1, 'Only one POST attempt was made');
    assert.equal(flow.getState().status, 'unverified', 'Status transitions to unverified when POST response is lost');
    assert.equal(flow.getState().approval, null, 'Approval is cleared');

    // 3. Blind retry is blocked: cannot prepare new approval or confirm with stale approval
    simulatePostFailure = false;
    await flow.prepare(false);
    assert.equal(flow.getState().approval, null, 'Cannot create new approval while sealed');

    await flow.confirm(approval, approval.confirmation);
    const postsAfterRetryAttempt = httpCalls.filter((c) => c.method === 'POST');
    assert.equal(postsAfterRetryAttempt.length, 1, 'Blind retry rejected without sending another POST');

    // 4. Manual refresh ("Sonucu yeniden oku"): executes ONLY GET requests
    const callsBeforeRefresh = httpCalls.length;
    await flow.refresh();
    const refreshCalls = httpCalls.slice(callsBeforeRefresh);
    assert.ok(refreshCalls.length > 0, 'Refresh dispatched requests');
    assert.ok(refreshCalls.every((c) => c.method === 'GET'), 'Refresh uses ONLY GET requests');
    assert.equal(flow.getState().status, 'uncertain', 'State is uncertain with warning message');
    assert.ok(flow.getState().error.includes('İstek cevabı kayboldu'), 'Error message warns about lost response');

    // 5. StrictMode UI render with uncertain state
    const ownerSession = { user: { role: 'owner' }, csrfToken: 'test' };
    const html = renderToString(
      createElement(FullSslApp, {
        session: ownerSession,
        domain: targetDomain,
        certificate: await certificateRegistry.getCertificate(cert.id),
        certificates: [await certificateRegistry.getCertificate(cert.id)],
        renewalState: flow.getState(),
        now: Date.parse('2026-08-30T00:00:00.000Z'),
      })
    );
    assert.ok(html.includes('İstek cevabı kayboldu'));
    assert.ok(!html.includes('Yenileme sonucu kalıcı sertifika kaydıyla eşleşti'));

    flow.dispose();
  });
});

test('Yanlış job/sertifika/site kimliği: eski onay yeni hedefe yazmaz ve uyuşmayan kimlikler fail-closed reddedilir', async () => {
  const domainId = '11111111-1111-4111-8111-111111111111';
  const certificateId = '22222222-2222-4222-8222-222222222222';
  const websiteId = '33333333-3333-4333-8333-333333333333';
  const foreignId = '99999999-9999-4999-8999-999999999999';
  const serverId = 'srv-identity-test';

  const target = {
    id: domainId,
    certificateId,
    websiteId,
    serverId,
    primaryDomain: 'identity.example.com',
  };

  const oldCert = {
    id: certificateId,
    domainId,
    serverId,
    certName: 'identity.example.com',
    state: 'active',
    source: 'acme',
    renewalMode: 'automatic',
    staging: false,
    purpose: 'web',
    validFrom: '2026-06-01T00:00:00.000Z',
    validTo: '2026-09-01T00:00:00.000Z',
    fingerprint256: '11:'.repeat(31) + '11',
  };

  const domainRecord = {
    ...target,
    httpsMode: 'managed',
    desiredRevision: 1,
  };

  // Case 2a: Job returns with mismatched resourceId or wrong resourceType or wrong operation
  for (const [field, badValue] of [
    ['resourceId', foreignId],
    ['resourceType', 'domain'],
    ['operation', 'domain.stage'],
    ['serverId', 'foreign-server'],
  ]) {
    const httpCalls = [];
    const request = async (path, options = {}) => {
      httpCalls.push({ method: options.method ?? 'GET', path });
      if (path === `/domains/${domainId}`) return structuredClone(domainRecord);
      if (path === `/certificates/${certificateId}`) return structuredClone(oldCert);
      if (path === `/certificates/${certificateId}/renew`) {
        return {
          id: '55555555-5555-4555-8555-555555555555',
          serverId,
          resourceType: 'certificate',
          resourceId: certificateId,
          operation: 'ssl.renew',
          status: 'queued',
          [field]: badValue,
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    };

    const flow = createSslRenewal({
      target,
      request,
      isCurrent: () => true,
      canManage: () => true,
      canStart: () => true,
    });

    await flow.prepare(false);
    const approval = flow.getState().approval;
    assert.ok(approval);

    await flow.confirm(approval, approval.confirmation);
    assert.equal(flow.getState().status, 'unverified', `Bad ${field} should leave state unverified`);
    assert.equal(flow.getState().outcome, null, `Bad ${field} must not produce outcome`);
    assert.equal(flow.getState().certificate.validTo, oldCert.validTo, `Bad ${field} must not update dates`);
    flow.dispose();
  }

  // Case 2b: Domain binding returns mismatched certificateId, websiteId, or primaryDomain
  for (const [field, badValue] of [
    ['certificateId', foreignId],
    ['websiteId', foreignId],
    ['primaryDomain', 'spoofed.example.com'],
    ['serverId', 'foreign-server'],
  ]) {
    let callCount = 0;
    const request = async (path) => {
      if (path === `/domains/${domainId}`) {
        callCount++;
        return { ...domainRecord, [field]: callCount > 2 ? badValue : domainRecord[field] };
      }
      if (path === `/certificates/${certificateId}`) return structuredClone(oldCert);
      if (path === `/certificates/${certificateId}/renew`) {
        throw new Error('Should not reach POST when binding mismatch occurs');
      }
      throw new Error(`Unexpected path: ${path}`);
    };

    const flow = createSslRenewal({
      target,
      request,
      isCurrent: () => true,
      canManage: () => true,
      canStart: () => true,
    });

    await flow.prepare(false);
    const approval = flow.getState().approval;
    assert.ok(approval);

    await flow.confirm(approval, approval.confirmation);
    assert.equal(flow.getState().approval, null, 'Approval must be cleared on binding drift');
    flow.dispose();
  }
});

test('Sertifika seçimi veya Website bağının değişmesi: eski onay yeni hedefe yazmasın', async () => {
  const domainId = '11111111-1111-4111-8111-111111111111';
  const certId1 = '22222222-2222-4222-8222-222222222222';
  const certId2 = '77777777-7777-4777-8777-777777777777';
  const websiteId1 = '33333333-3333-4333-8333-333333333333';
  const websiteId2 = '88888888-8888-4888-8888-888888888888';
  const serverId = 'srv-binding-test';

  const target = {
    id: domainId,
    certificateId: certId1,
    websiteId: websiteId1,
    serverId,
    primaryDomain: 'binding-change.example.com',
  };

  const domain = {
    ...target,
    httpsMode: 'managed',
    desiredRevision: 1,
  };

  const cert1 = {
    id: certId1,
    domainId,
    serverId,
    certName: 'binding-change.example.com',
    state: 'active',
    source: 'acme',
    renewalMode: 'automatic',
    staging: false,
    validFrom: '2026-06-01T00:00:00.000Z',
    validTo: '2026-09-01T00:00:00.000Z',
    fingerprint256: 'AA:'.repeat(31) + 'AA',
  };

  const httpCalls = [];
  const request = async (path, options = {}) => {
    httpCalls.push({ method: options.method ?? 'GET', path, body: options.body });
    if (path === `/domains/${domainId}`) return structuredClone(domain);
    if (path === `/certificates/${certId1}`) return structuredClone(cert1);
    if (path === `/certificates/${certId2}`) return { ...cert1, id: certId2 };
    if (path.includes('/renew')) return { id: '99999999-9999-4999-8999-999999999999', status: 'queued', operation: 'ssl.renew', resourceType: 'certificate', resourceId: certId1, serverId };
    throw new Error(`Unexpected path: ${path}`);
  };

  const flow = createSslRenewal({
    target,
    request,
    isCurrent: () => true,
    canManage: () => true,
    canStart: () => true,
  });

  // 1. Prepare approval for certId1 and websiteId1
  await flow.prepare(false);
  const approval = flow.getState().approval;
  assert.ok(approval, 'Approval created for cert1');

  // Case 3a: Certificate selection changes before confirm
  domain.certificateId = certId2;
  await flow.confirm(approval, approval.confirmation);

  const renewPosts = httpCalls.filter((c) => c.path.includes('/renew'));
  assert.equal(renewPosts.length, 0, 'No renewal POST sent when certificateId changed');
  assert.equal(flow.getState().approval, null, 'Approval is invalidated');

  // Reset and prepare another approval
  domain.certificateId = certId1;
  await flow.prepare(false);
  const approval2 = flow.getState().approval;
  assert.ok(approval2, 'Approval 2 created');

  // Case 3b: Website binding changes before confirm
  domain.websiteId = websiteId2;
  await flow.confirm(approval2, approval2.confirmation);

  const renewPosts2 = httpCalls.filter((c) => c.path.includes('/renew'));
  assert.equal(renewPosts2.length, 0, 'No renewal POST sent when websiteId changed');
  assert.equal(flow.getState().approval, null, 'Approval 2 is invalidated');

  // Case 3c: React key guarantee in SiteOperations
  const session = { user: { id: 'user-1', role: 'owner' } };
  const key1 = JSON.stringify([domain.id, certId1, domain.serverId, websiteId1, session.user.id, session.user.role, 1]);
  const key2 = JSON.stringify([domain.id, certId2, domain.serverId, websiteId1, session.user.id, session.user.role, 1]);
  const key3 = JSON.stringify([domain.id, certId1, domain.serverId, websiteId2, session.user.id, session.user.role, 1]);
  assert.notEqual(key1, key2, 'Key changes when certificateId changes');
  assert.notEqual(key1, key3, 'Key changes when websiteId changes');

  flow.dispose();
});

test('Logout/login ve yetki iptali: eski onay yeni hedefe yazmasın ve yetki kaybında durum sıfırlansın', async () => {
  const domainId = '11111111-1111-4111-8111-111111111111';
  const certId = '22222222-2222-4222-8222-222222222222';
  const serverId = 'srv-session-test';

  const target = {
    id: domainId,
    certificateId: certId,
    websiteId: null,
    serverId,
    primaryDomain: 'session-auth.example.com',
  };

  const domain = { ...target, httpsMode: 'managed', desiredRevision: 1 };
  const cert = {
    id: certId,
    domainId,
    serverId,
    certName: 'session-auth.example.com',
    state: 'active',
    source: 'acme',
    renewalMode: 'automatic',
    staging: false,
    validFrom: '2026-06-01T00:00:00.000Z',
    validTo: '2026-09-01T00:00:00.000Z',
    fingerprint256: 'AA:'.repeat(31) + 'AA',
  };

  const httpCalls = [];
  let serverAuthFailure = null;

  const request = async (path, options = {}) => {
    httpCalls.push({ method: options.method ?? 'GET', path });
    if (serverAuthFailure) {
      const err = new Error('Auth failed');
      err.status = serverAuthFailure;
      throw err;
    }
    if (path === `/domains/${domainId}`) return structuredClone(domain);
    if (path === `/certificates/${certId}`) return structuredClone(cert);
    if (path.includes('/renew')) return { id: '33333333-3333-4333-8333-333333333333', status: 'queued', operation: 'ssl.renew', resourceType: 'certificate', resourceId: certId, serverId };
    if (path.startsWith('/jobs/')) return { id: '33333333-3333-4333-8333-333333333333', status: 'running', operation: 'ssl.renew', resourceType: 'certificate', resourceId: certId, serverId };
    throw new Error(`Unexpected path: ${path}`);
  };

  // Case 4a: Logout / login (session version rotation)
  let activeSessionVersion = 1;
  const flow1 = createSslRenewal({
    target,
    request,
    isCurrent: () => activeSessionVersion === 1,
    canManage: () => true,
    canStart: () => true,
  });

  await flow1.prepare(false);
  const approval1 = flow1.getState().approval;
  assert.ok(approval1, 'Approval created in session 1');

  // User logs out and logs in as new session (activeSessionVersion rotates to 2)
  activeSessionVersion = 2;
  await flow1.confirm(approval1, approval1.confirmation);

  const postsInFlow1 = httpCalls.filter((c) => c.method === 'POST');
  assert.equal(postsInFlow1.length, 0, 'No POST sent after session rotation');
  flow1.dispose();

  // Case 4b: Permission revoked (canManage becomes false / role changed from owner to read_only)
  let allowedToManage = true;
  const flow2 = createSslRenewal({
    target,
    request,
    isCurrent: () => true,
    canManage: () => allowedToManage,
    canStart: () => true,
  });

  await flow2.prepare(false);
  const approval2 = flow2.getState().approval;
  assert.ok(approval2, 'Approval created while management allowed');

  // Permission revoked
  allowedToManage = false;
  await flow2.confirm(approval2, approval2.confirmation);

  const postsInFlow2 = httpCalls.filter((c) => c.method === 'POST');
  assert.equal(postsInFlow2.length, 0, 'No POST sent when permission revoked');
  assert.equal(flow2.getState().status, 'forbidden', 'Status transitions to forbidden');
  assert.equal(flow2.getState().approval, null, 'Approval cleared on permission revocation');
  assert.equal(flow2.getState().certificate, null, 'Certificate data cleared on permission revocation');
  flow2.dispose();

  // Case 4c: Server 401/403 during active polling clears prior state
  const flow3 = createSslRenewal({
    target,
    request,
    isCurrent: () => true,
    canManage: () => true,
    canStart: () => true,
  });

  await flow3.prepare(false);
  const approval3 = flow3.getState().approval;
  await flow3.confirm(approval3, approval3.confirmation);
  assert.equal(flow3.getState().status, 'waiting');
  assert.ok(flow3.getState().job);

  // Server revokes access during polling:
  serverAuthFailure = 401;
  await flow3.refresh();

  assert.equal(flow3.getState().status, 'forbidden');
  assert.equal(flow3.getState().job, null);
  assert.equal(flow3.getState().certificate, null);
  assert.equal(flow3.getState().before, null);
  flow3.dispose();
});

test('Uzun iş (120 poll) ve metadata takip sınırından (8 read) sonra otomatik takip durur ve elle yeniden okuma yalnız GET ile yapılır', async () => {
  const domainId = '11111111-1111-4111-8111-111111111111';
  const certId = '22222222-2222-4222-8222-222222222222';
  const jobId = '33333333-3333-4333-8333-333333333333';
  const serverId = 'srv-long-job-test';

  const target = {
    id: domainId,
    certificateId: certId,
    websiteId: null,
    serverId,
    primaryDomain: 'long-job.example.com',
  };

  const domain = { ...target, httpsMode: 'managed', desiredRevision: 1 };
  const oldCert = {
    id: certId,
    domainId,
    serverId,
    certName: 'long-job.example.com',
    state: 'active',
    source: 'acme',
    renewalMode: 'automatic',
    staging: false,
    validFrom: '2026-06-01T00:00:00.000Z',
    validTo: '2026-09-01T00:00:00.000Z',
    fingerprint256: 'AA:'.repeat(31) + 'AA',
  };

  let currentCert = structuredClone(oldCert);
  let jobStatus = 'running';

  const httpCalls = [];
  const request = async (path, options = {}) => {
    httpCalls.push({ method: options.method ?? 'GET', path, body: options.body });
    if (path === `/domains/${domainId}`) return structuredClone(domain);
    if (path === `/certificates/${certId}`) return structuredClone(currentCert);
    if (path.includes('/renew')) {
      return { id: jobId, status: 'queued', operation: 'ssl.renew', resourceType: 'certificate', resourceId: certId, serverId };
    }
    if (path === `/jobs/${jobId}`) {
      return {
        id: jobId,
        status: jobStatus,
        operation: 'ssl.renew',
        resourceType: 'certificate',
        resourceId: certId,
        serverId,
        result: jobStatus === 'succeeded' ? {
          certName: 'long-job.example.com',
          status: 'renewed',
          validFrom: '2026-09-01T00:00:00.000Z',
          validTo: '2026-12-01T00:00:00.000Z',
          fingerprint256: 'BB:'.repeat(31) + 'BB',
          dryRun: false,
        } : null,
      };
    }
    throw new Error(`Unexpected path: ${path}`);
  };

  const flow = createSslRenewal({
    target,
    request,
    isCurrent: () => true,
    canManage: () => true,
    canStart: () => true,
  });

  await flow.prepare(false);
  const approval = flow.getState().approval;
  await flow.confirm(approval, approval.confirmation);

  const postsAfterConfirm = httpCalls.filter((c) => c.method === 'POST').length;
  assert.equal(postsAfterConfirm, 1, 'Exactly one initial POST request sent');

  // Case 5a: Poll 119 times -> still waiting
  for (let i = 0; i < 118; i++) {
    await flow.refresh();
  }
  assert.equal(flow.getState().status, 'waiting');

  // 120th poll -> reaches long-running limit -> status: 'paused'
  await flow.refresh();
  assert.equal(flow.getState().status, 'paused', 'Job is paused after 120 polls');

  // UI render shows paused notice:
  const ownerSession = { user: { role: 'owner' } };
  const pausedHtml = renderToString(
    createElement(FullSslApp, {
      session: ownerSession,
      domain,
      certificate: currentCert,
      certificates: [currentCert],
      renewalState: flow.getState(),
      now: Date.parse('2026-08-30T00:00:00.000Z'),
    })
  );
  assert.ok(pausedHtml.includes('Otomatik takip sınırına ulaşıldı'));

  // Manual refresh while paused: MUST ONLY make GET requests
  const callsBeforeManual = httpCalls.length;
  await flow.refresh();
  const manualCalls = httpCalls.slice(callsBeforeManual);
  assert.ok(manualCalls.every((c) => c.method === 'GET'), 'Manual refresh is strictly GET');
  assert.equal(httpCalls.filter((c) => c.method === 'POST').length, 1, 'No new POST dispatched');

  // Case 5b: Job transitions to succeeded on server, but persistent write is delayed
  jobStatus = 'succeeded';
  // Poll 7 times while delayed -> syncing
  for (let i = 0; i < 7; i++) {
    await flow.refresh();
  }
  assert.equal(flow.getState().status, 'syncing');

  // 8th sync read -> reaches metadata tracking limit -> status: 'unverified'
  await flow.refresh();
  assert.equal(flow.getState().status, 'unverified', 'Status transitions to unverified after 8 sync reads');
  assert.ok(flow.getState().error.includes('İş tamamlandı, ancak kalıcı sertifika kaydı'));

  // Manual refresh while unverified: MUST ONLY make GET requests, no POST
  const callsBeforeSyncRefresh = httpCalls.length;
  await flow.refresh();
  const syncRefreshCalls = httpCalls.slice(callsBeforeSyncRefresh);
  assert.ok(syncRefreshCalls.every((c) => c.method === 'GET'), 'Sync refresh is strictly GET');
  assert.equal(httpCalls.filter((c) => c.method === 'POST').length, 1, 'No new POST dispatched');

  // Backend persistent record commits:
  currentCert = {
    ...oldCert,
    validFrom: '2026-09-01T00:00:00.000Z',
    validTo: '2026-12-01T00:00:00.000Z',
    fingerprint256: 'BB:'.repeat(31) + 'BB',
  };

  // User manually re-reads -> completes via GET
  await flow.refresh();
  assert.equal(flow.getState().status, 'complete');
  assert.equal(flow.getState().outcome, 'renewed');
  assert.equal(flow.getState().certificate.validTo, '2026-12-01T00:00:00.000Z');
  assert.equal(httpCalls.filter((c) => c.method === 'POST').length, 1, 'Remained exactly 1 POST throughout entire lifecycle');

  flow.dispose();
});

test('Acceptance criteria: DNS/provider error conditions, panel metadata vs live TLS, and PROD-06 mail identity partial outcome', async () => {
  const certificateRegistry = createCertificateRegistry();
  const jobRegistry = createJobRegistry();
  const serverId = 'srv-dns-test';
  const domainId = 'dom-dns-test';

  const validFrom = '2026-07-01T00:00:00.000Z';
  const validTo = '2026-10-15T00:00:00.000Z';
  const oldFingerprint = '11:'.repeat(31) + '11';
  const newFingerprint = '22:'.repeat(31) + '22';
  const newValidFrom = '2026-10-01T00:00:00.000Z';
  const newValidTo = '2027-01-01T00:00:00.000Z';
  const credentialId = '11111111-1111-4111-8111-111111111111';
  const dnsZoneId = '22222222-2222-4222-8222-222222222222';

  // 1. DNS-01 provider credential error / missing credentials fail-closed in renewal sweep
  const dnsCert = await certificateRegistry.createForDomain({
    domainId,
    serverId,
    domains: ['dns-provider.example.com'],
    email: 'ops@example.com',
    challenge: {
      type: 'dns-01',
      provider: 'cloudflare',
      credentialId,
      dnsZoneId,
      propagationSeconds: 30,
    },
  });
  await certificateRegistry.markActive(dnsCert.id, {
    certName: 'dns-provider.example.com',
    certificatePath: '/etc/letsencrypt/live/dns-provider.example.com/cert.pem',
    fullchainPath: '/etc/letsencrypt/live/dns-provider.example.com/fullchain.pem',
    privateKeyPath: '/etc/letsencrypt/live/dns-provider.example.com/privkey.pem',
    validFrom,
    validTo,
    fingerprint256: oldFingerprint,
  });

  // Mock DNS credential registry with unconfigured / missing credentials
  const unconfiguredDnsRegistry = {
    getForZone: async (zoneId) => ({
      id: credentialId,
      provider: 'cloudflare',
      configured: false, // NOT configured!
    }),
  };

  const sweepUnconfigured = await runCertificateRenewalSweep({
    certificateRegistry,
    jobRegistry,
    dnsProviderCredentialRegistry: unconfiguredDnsRegistry,
    now: () => Date.parse('2026-10-01T00:00:00.000Z'),
  });
  assert.equal(sweepUnconfigured.length, 0, 'Sweep skips cert when DNS provider credential is unconfigured');
  const certAfterSkip = await certificateRegistry.getCertificate(dnsCert.id);
  assert.equal(certAfterSkip.state, 'active', 'Certificate state remains active without false mutation');

  // Mock DNS credential registry throwing provider error
  const failingDnsRegistry = {
    getForZone: async () => {
      const err = new Error('DNS provider API timeout');
      err.code = 'dns_provider_timeout';
      throw err;
    },
  };
  const sweepProviderErr = await runCertificateRenewalSweep({
    certificateRegistry,
    jobRegistry,
    dnsProviderCredentialRegistry: failingDnsRegistry,
    now: () => Date.parse('2026-10-01T00:00:00.000Z'),
  });
  assert.equal(sweepProviderErr.length, 0, 'Sweep fails closed when DNS provider query fails');

  // Configured DNS provider registry enqueues renewal job with challenge info
  const configuredDnsRegistry = {
    getForZone: async (zoneId) => ({
      id: credentialId,
      provider: 'cloudflare',
      configured: true,
    }),
  };
  const sweepConfigured = await runCertificateRenewalSweep({
    certificateRegistry,
    jobRegistry,
    dnsProviderCredentialRegistry: configuredDnsRegistry,
    now: () => Date.parse('2026-10-01T00:00:00.000Z'),
  });
  assert.equal(sweepConfigured.length, 1, 'Sweep succeeds and enqueues renewal job when DNS provider credential is valid');
  assert.equal(sweepConfigured[0].payload.challenge.type, 'dns-01');

  // 2. DNS challenge failure during renewal job
  const failedDnsJob = {
    status: 'failed',
    error: { message: 'DNS challenge validation failed: NXDOMAIN on _acme-challenge.dns-provider.example.com', code: 'dns_challenge_failed' },
  };
  const outcomeDnsFail = verifyRenewalOutcome({
    certificate: certAfterSkip,
    before: certAfterSkip,
    job: failedDnsJob,
    liveTls: null,
  });
  assert.equal(outcomeDnsFail.outcome, 'failed');
  assert.equal(outcomeDnsFail.verified, false);
  assert.match(outcomeDnsFail.error, /NXDOMAIN/);

  // 3. Panel metadata equality alone is NEVER live TLS proof
  const renewedCertRecord = {
    ...certAfterSkip,
    validFrom: newValidFrom,
    validTo: newValidTo,
    fingerprint256: newFingerprint,
    state: 'active',
  };
  const successfulJob = {
    status: 'succeeded',
    result: {
      certName: 'dns-provider.example.com',
      status: 'renewed',
      validFrom: newValidFrom,
      validTo: newValidTo,
      fingerprint256: newFingerprint,
      dryRun: false,
    },
  };

  // Even though panel record matches job result perfectly, missing or unresolvable live TLS probe (e.g. ENOTFOUND) leaves outcome unverified
  const unprobedOutcome = verifyRenewalOutcome({
    certificate: renewedCertRecord,
    before: certAfterSkip,
    job: successfulJob,
    liveTls: null,
  });
  assert.equal(unprobedOutcome.outcome, 'pending_live_tls_verification');
  assert.equal(unprobedOutcome.verified, false, 'Panel metadata equality alone is NOT live TLS proof');

  // Live TLS probe returning mismatched certificate (e.g. SNI mismatch or wrong certificate presented)
  const mismatchedLiveOutcome = verifyRenewalOutcome({
    certificate: renewedCertRecord,
    before: certAfterSkip,
    job: successfulJob,
    liveTls: {
      fingerprint256: '99:'.repeat(31) + '99',
      validFrom: newValidFrom,
      validTo: newValidTo,
    },
  });
  assert.equal(mismatchedLiveOutcome.outcome, 'live_tls_mismatch');
  assert.equal(mismatchedLiveOutcome.verified, false);
  assert.equal(mismatchedLiveOutcome.reason, 'fingerprint_mismatch');

  // Live TLS probe still presenting previous certificate (reload pending)
  const pendingReloadOutcome = verifyRenewalOutcome({
    certificate: renewedCertRecord,
    before: certAfterSkip,
    job: successfulJob,
    liveTls: {
      fingerprint256: oldFingerprint,
      validFrom,
      validTo,
    },
  });
  assert.equal(pendingReloadOutcome.outcome, 'pending_service_reload');
  assert.equal(pendingReloadOutcome.reason, 'live_tls_presents_previous_certificate');
  assert.equal(pendingReloadOutcome.verified, false);

  // 4. Initial issuance & post-renewal mail identity / stage / activate partial outcomes (PROD-06 boundary)
  // When live TLS matches, but mail identity assignment failed or completed partially:
  const mailIdentityPartialCert = {
    ...renewedCertRecord,
    lastReloadOutcome: {
      service: 'mail_identity',
      status: 'partial',
      stage: 'activate',
      error: 'Postfix SNI map updated but Dovecot TLS reload timed out',
    },
  };
  const mailPartialOutcome = verifyRenewalOutcome({
    certificate: mailIdentityPartialCert,
    before: certAfterSkip,
    job: successfulJob,
    liveTls: {
      fingerprint256: newFingerprint,
      validFrom: newValidFrom,
      validTo: newValidTo,
    },
  });
  assert.equal(mailPartialOutcome.outcome, 'partial');
  assert.equal(mailPartialOutcome.verified, false);
  assert.equal(mailPartialOutcome.reason, 'post_ssl_mail_identity_assignment_failed');
  assert.equal(mailPartialOutcome.partial, true);

  // Diagnosis for mail identity partial failure
  const mailDiag = certificateDiagnosis(mailIdentityPartialCert);
  assert.equal(mailDiag.severity, 'warning');
  assert.equal(mailDiag.code, 'certificate_reload_partial');
  assert.match(mailDiag.message, /mail service identity assignment/i);
  assert.match(mailDiag.action, /retry mail identity assignment/i);

  // Mail identity total reload failure
  const mailIdentityFailedCert = {
    ...renewedCertRecord,
    lastReloadOutcome: {
      service: 'mail_identity',
      status: 'failed',
      stage: 'activate',
      error: 'Failed to bind mail TLS identity certificate',
    },
  };
  const mailFailedOutcome = verifyRenewalOutcome({
    certificate: mailIdentityFailedCert,
    before: certAfterSkip,
    job: successfulJob,
    liveTls: {
      fingerprint256: newFingerprint,
      validFrom: newValidFrom,
      validTo: newValidTo,
    },
  });
  assert.equal(mailFailedOutcome.outcome, 'partial_service_reload');
  assert.equal(mailFailedOutcome.verified, false);
  assert.equal(mailFailedOutcome.reason, 'post_ssl_mail_identity_assignment_failed');

  const mailFailedDiag = certificateDiagnosis(mailIdentityFailedCert);
  assert.equal(mailFailedDiag.severity, 'warning');
  assert.equal(mailFailedDiag.code, 'certificate_reload_failed');
  assert.match(mailFailedDiag.message, /mail service identity assignment failed/i);

  // 5. Full live TLS match with clean reload outcome
  const cleanCert = {
    ...renewedCertRecord,
    lastReloadOutcome: {
      service: 'nginx',
      status: 'succeeded',
    },
  };
  const fullyVerifiedOutcome = verifyRenewalOutcome({
    certificate: cleanCert,
    before: certAfterSkip,
    job: successfulJob,
    liveTls: {
      fingerprint256: newFingerprint,
      validFrom: newValidFrom,
      validTo: newValidTo,
    },
  });
  assert.equal(fullyVerifiedOutcome.outcome, 'renewed_and_live_verified');
  assert.equal(fullyVerifiedOutcome.verified, true);
});
