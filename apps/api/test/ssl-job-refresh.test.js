import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createCertificateRegistry } from '../src/certificate-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import {
  verifyRenewalOutcome,
  verifyCertificateRenewalOutcome,
  runCertificateRenewalSweep,
} from '../src/certificate-renewal-scheduler.js';
import { certificateHttpInternals } from '../src/certificate-http.js';

// Execute the web workspace job-refresh test suite
import '../../web/test/ssl-job-refresh.test.js';

const { renewalOutcome } = certificateHttpInternals;

test('Backend job refresh: verifyRenewalOutcome tracks job status transitions', () => {
  const cert = {
    id: 'cert-1',
    certName: 'example.com',
    state: 'active',
    validFrom: '2026-09-01T00:00:00.000Z',
    validTo: '2026-12-01T00:00:00.000Z',
    fingerprint256: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
  };
  const before = {
    validFrom: '2026-06-01T00:00:00.000Z',
    validTo: '2026-09-01T00:00:00.000Z',
    fingerprint256: '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00',
  };

  // 1. Queued
  const queuedJob = { status: 'queued', operation: 'ssl.renew' };
  const queuedOutcome = verifyRenewalOutcome({ certificate: cert, before, job: queuedJob });
  assert.equal(queuedOutcome.outcome, 'job_not_terminal');
  assert.equal(queuedOutcome.verified, false);
  assert.equal(renewalOutcome(queuedJob, before, cert), 'waiting');

  // 2. Running
  const runningJob = { status: 'running', operation: 'ssl.renew' };
  const runningOutcome = verifyRenewalOutcome({ certificate: cert, before, job: runningJob });
  assert.equal(runningOutcome.outcome, 'job_not_terminal');
  assert.equal(runningOutcome.verified, false);
  assert.equal(renewalOutcome(runningJob, before, cert), 'waiting');

  // 3. Failed
  const failedJob = { status: 'failed', operation: 'ssl.renew', error: { message: 'ACME challenge failed' } };
  const failedOutcome = verifyRenewalOutcome({ certificate: cert, before, job: failedJob });
  assert.equal(failedOutcome.outcome, 'failed');
  assert.equal(failedOutcome.verified, false);
  assert.equal(renewalOutcome(failedJob, before, cert), 'failed');

  // 4. Cancelled
  const cancelledJob = { status: 'cancelled', operation: 'ssl.renew' };
  const cancelledOutcome = verifyRenewalOutcome({ certificate: cert, before, job: cancelledJob });
  assert.equal(cancelledOutcome.outcome, 'cancelled');
  assert.equal(cancelledOutcome.verified, false);
  assert.equal(renewalOutcome(cancelledJob, before, cert), 'cancelled');

  // 5. Succeeded
  const succeededJob = {
    status: 'succeeded',
    operation: 'ssl.renew',
    result: {
      certName: 'example.com',
      status: 'renewed',
      validFrom: cert.validFrom,
      validTo: cert.validTo,
      fingerprint256: cert.fingerprint256,
      dryRun: false,
    },
  };
  const succeededOutcome = verifyRenewalOutcome({
    certificate: cert,
    before,
    job: succeededJob,
    liveTls: {
      validFrom: cert.validFrom,
      validTo: cert.validTo,
      fingerprint256: cert.fingerprint256,
    },
  });
  assert.equal(succeededOutcome.outcome, 'renewed_and_live_verified');
  assert.equal(succeededOutcome.verified, true);
  assert.equal(renewalOutcome(succeededJob, before, cert), 'renewed');
});

test('Backend job refresh: verifyCertificateRenewalOutcome integrates registries dynamically', async () => {
  const certificateRegistry = createCertificateRegistry();
  const jobRegistry = createJobRegistry();
  const serverId = 'srv-test-refresh';

  const cert = await certificateRegistry.createForDomain({
    domainId: 'domain-1',
    serverId,
    domains: ['refresh.example.com'],
    email: 'admin@refresh.example.com',
  });

  const validFrom = '2026-09-01T00:00:00.000Z';
  const validTo = '2026-12-01T00:00:00.000Z';
  const fingerprint256 = '55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55';

  await certificateRegistry.markActive(cert.id, {
    certName: 'refresh.example.com',
    certificatePath: '/etc/letsencrypt/live/refresh.example.com/cert.pem',
    fullchainPath: '/etc/letsencrypt/live/refresh.example.com/fullchain.pem',
    privateKeyPath: '/etc/letsencrypt/live/refresh.example.com/privkey.pem',
    validFrom,
    validTo,
    fingerprint256,
  });

  const job = await jobRegistry.enqueue({
    serverId,
    type: 'ssl.renew',
    operation: 'ssl.renew',
    payload: { certName: 'refresh.example.com', dryRun: false },
    resourceType: 'certificate',
    resourceId: cert.id,
  });

  // Check state while job is queued
  const queuedCheck = await verifyCertificateRenewalOutcome({
    certificateId: cert.id,
    certificateRegistry,
    jobRegistry,
    jobId: job.id,
  });
  assert.equal(queuedCheck.outcome, 'job_not_terminal');
  assert.equal(queuedCheck.status, 'queued');

  // Claim and check state while job is running
  await jobRegistry.claimNext(serverId);
  const runningCheck = await verifyCertificateRenewalOutcome({
    certificateId: cert.id,
    certificateRegistry,
    jobRegistry,
    jobId: job.id,
  });
  assert.equal(runningCheck.outcome, 'job_not_terminal');
  assert.equal(runningCheck.status, 'running');

  // Complete job
  await jobRegistry.complete({
    serverId,
    jobId: job.id,
    status: 'succeeded',
    result: {
      certName: 'refresh.example.com',
      certificatePath: '/etc/letsencrypt/live/refresh.example.com/cert.pem',
      fullchainPath: '/etc/letsencrypt/live/refresh.example.com/fullchain.pem',
      privateKeyPath: '/etc/letsencrypt/live/refresh.example.com/privkey.pem',
      status: 'renewed',
      validFrom,
      validTo,
      fingerprint256,
    },
  });

  // Verify completion with live TLS inspector
  const completedCheck = await verifyCertificateRenewalOutcome({
    certificateId: cert.id,
    certificateRegistry,
    jobRegistry,
    jobId: job.id,
    tlsInspector: async () => ({ validFrom, validTo, fingerprint256 }),
  });
  assert.equal(completedCheck.outcome, 'renewed_and_live_verified');
  assert.equal(completedCheck.verified, true);
});

test('Backend job refresh: renewal sweep deduplicates against queued and running jobs', async () => {
  const certificateRegistry = createCertificateRegistry();
  const jobRegistry = createJobRegistry();
  const serverId = 'srv-sweep-dedup';

  const cert = await certificateRegistry.createForDomain({
    domainId: 'domain-dedup',
    serverId,
    domains: ['dedup.example.com'],
    email: 'admin@dedup.example.com',
  });

  const nowTime = Date.parse('2026-10-01T00:00:00.000Z');
  const validFrom = '2026-07-01T00:00:00.000Z';
  const validTo = '2026-10-15T00:00:00.000Z'; // 14 days remaining (< 30 days)
  const fingerprint256 = '66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66:66';

  await certificateRegistry.markActive(cert.id, {
    certName: 'dedup.example.com',
    certificatePath: '/etc/letsencrypt/live/dedup.example.com/cert.pem',
    fullchainPath: '/etc/letsencrypt/live/dedup.example.com/fullchain.pem',
    privateKeyPath: '/etc/letsencrypt/live/dedup.example.com/privkey.pem',
    validFrom,
    validTo,
    fingerprint256,
  });

  // First sweep should enqueue a renewal job
  const sweep1 = await runCertificateRenewalSweep({
    certificateRegistry,
    jobRegistry,
    now: () => nowTime,
  });
  assert.equal(sweep1.length, 1);
  assert.equal(sweep1[0].operation, OPERATIONS.SSL_RENEW);
  assert.equal(sweep1[0].resourceId, cert.id);

  // Second sweep with the job queued must NOT enqueue a duplicate
  const sweep2 = await runCertificateRenewalSweep({
    certificateRegistry,
    jobRegistry,
    now: () => nowTime,
  });
  assert.equal(sweep2.length, 0);

  // Claim job to make it running
  await jobRegistry.claimNext(serverId);

  // Third sweep with the job running must NOT enqueue a duplicate
  const sweep3 = await runCertificateRenewalSweep({
    certificateRegistry,
    jobRegistry,
    now: () => nowTime,
  });
  assert.equal(sweep3.length, 0);
});

test('Backend job refresh: unrelated jobs do not trigger certificate renewal or change outcome', () => {
  const cert = {
    id: 'cert-unrelated',
    certName: 'unrelated.example.com',
    state: 'active',
    validFrom: '2026-09-01T00:00:00.000Z',
    validTo: '2026-12-01T00:00:00.000Z',
    fingerprint256: '77:77:77:77:77:77:77:77:77:77:77:77:77:77:77:77:77:77:77:77:77:77:77:77:77:77:77:77:77:77:77:77',
  };

  const domainJob = {
    id: 'job-domain',
    operation: 'domain.stage',
    resourceType: 'domain',
    status: 'succeeded',
    result: { checksum: 'abc' },
  };

  const domainOutcome = verifyRenewalOutcome({ certificate: cert, job: domainJob });
  assert.equal(domainOutcome.outcome, 'unverified');
  assert.equal(domainOutcome.verified, false);
  assert.equal(domainOutcome.reason, 'job_status_not_renewed');
});
