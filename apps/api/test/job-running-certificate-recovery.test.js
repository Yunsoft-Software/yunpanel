import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { recoverRunningCertificateOperation } from '../src/job-running-certificate-recovery.js';

const serverId = 'server-1';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';
const certificateId = '2f334b35-03ce-4aa0-a8e4-b2ad4f592541';
const fingerprint = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, '0')).join(':').toUpperCase();
const validFrom = '2026-09-10T00:00:00.000Z';
const validTo = '2026-12-09T00:00:00.000Z';

function liveCertificate(certName = 'example.com') {
  const base = `/etc/letsencrypt/live/${certName}`;
  return {
    certName,
    certificatePath: `${base}/cert.pem`,
    fullchainPath: `${base}/fullchain.pem`,
    privateKeyPath: `${base}/privkey.pem`,
    subject: 'CN=example.com',
    issuer: 'CN=Test CA',
    subjectAltName: 'DNS:example.com, DNS:www.example.com',
    validFrom,
    validTo,
    fingerprint256: fingerprint,
  };
}

function scenarioData(kind) {
  if (kind === 'staging-issue') return {
    operation: OPERATIONS.SSL_ISSUE,
    payload: { domains: ['example.com', 'www.example.com'], email: 'ops@example.com', staging: true },
    certificate: { certName: 'example.com', domains: ['example.com', 'www.example.com'], email: 'ops@example.com', staging: true, state: 'validating' },
    receipt: { certName: 'example.com', domains: ['example.com', 'www.example.com'], staging: true, dryRun: null, status: 'validated', fingerprint256: null, validFrom: null, validTo: null },
    live: false,
  };
  if (kind === 'production-issue') return {
    operation: OPERATIONS.SSL_ISSUE,
    payload: { domains: ['example.com', 'www.example.com'], email: 'ops@example.com', staging: false },
    certificate: { certName: 'example.com', domains: ['example.com', 'www.example.com'], email: 'ops@example.com', staging: false, state: 'issuing' },
    receipt: { certName: 'example.com', domains: ['example.com', 'www.example.com'], staging: false, dryRun: null, status: 'issued', fingerprint256: fingerprint, validFrom, validTo },
    live: true,
  };
  if (kind === 'dry-run-renew') return {
    operation: OPERATIONS.SSL_RENEW,
    payload: { certName: 'example.com', dryRun: true },
    certificate: { certName: 'example.com', domains: ['example.com', 'www.example.com'], email: 'ops@example.com', staging: false, state: 'active' },
    receipt: { certName: 'example.com', domains: null, staging: null, dryRun: true, status: 'validated', fingerprint256: null, validFrom: null, validTo: null },
    live: false,
  };
  return {
    operation: OPERATIONS.SSL_RENEW,
    payload: { certName: 'example.com', dryRun: false },
    certificate: { certName: 'example.com', domains: ['example.com', 'www.example.com'], email: 'ops@example.com', staging: false, state: 'renewing' },
    receipt: { certName: 'example.com', domains: null, staging: null, dryRun: false, status: 'renewed', fingerprint256: fingerprint, validFrom, validTo },
    live: true,
  };
}

function fixture(kind, { receiptPresent = true, fingerprintOverride = null } = {}) {
  const data = scenarioData(kind);
  const events = [];
  let status = 'running';
  let completedResult = null;
  const jobRegistry = {
    async getJob() {
      events.push('get');
      return { id: jobId, serverId, status, operation: data.operation, resourceType: 'certificate', resourceId: certificateId };
    },
    async beginReconciliation() { events.push('begin'); return { serverId, jobId, status: 'running', pending: true }; },
    async complete(input) {
      events.push('complete');
      status = input.status;
      completedResult = input.result;
      return { id: jobId, serverId, status, operation: data.operation, resourceType: 'certificate', resourceId: certificateId, result: input.result };
    },
    async acknowledgeReconciliation() { events.push('ack'); return { serverId, jobId, status: 'succeeded', acknowledged: true }; },
  };
  const certificate = { id: certificateId, serverId, domainId: 'domain-1', ...data.certificate };
  return {
    data,
    events,
    completedResult: () => completedResult,
    options: {
      serverId,
      jobId,
      jobRegistry,
      domainRegistry: {},
      certificateRegistry: {
        async getCertificate() { events.push('certificate'); return certificate; },
      },
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      inspect: async () => ({ jobs: [{ jobId, serverId, status: 'running', operation: data.operation, resourceType: 'certificate', resourceId: certificateId }] }),
      loadJobContext: async () => {
        events.push('context');
        return { id: jobId, serverId, status: 'running', operation: data.operation, resourceType: 'certificate', resourceId: certificateId, payload: data.payload };
      },
      readCertificateReceipt: async () => {
        events.push('receipt');
        if (!receiptPresent) return null;
        return { serverId, jobId, certificateId, operation: data.operation, ...data.receipt };
      },
      inspectCertificate: async () => {
        events.push('live');
        return liveCertificate('example.com', fingerprintOverride);
      },
      reconcile: async () => { events.push('reconcile'); return { reconciled: true, error: null }; },
    },
  };
}

for (const kind of ['staging-issue', 'production-issue', 'dry-run-renew', 'production-renew']) {
  test(`verified ${kind} receipt resolves certificate recovery safely`, async () => {
    const fx = fixture(kind);
    if (kind === 'production-issue' || kind === 'production-renew') {
      const original = fx.options.inspectCertificate;
      fx.options.inspectCertificate = async () => {
        const live = await original();
        return live;
      };
    }
    const result = await recoverRunningCertificateOperation(fx.options);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.operation, fx.data.operation);
    assert.equal(result.recoveryMethod, fx.data.live ? 'verified_certificate_receipt_and_live_x509' : 'verified_certificate_operation_receipt');
    const expected = fx.data.live
      ? ['get', 'context', 'certificate', 'receipt', 'live', 'begin', 'complete', 'reconcile', 'ack']
      : ['get', 'context', 'certificate', 'receipt', 'begin', 'complete', 'reconcile', 'ack'];
    assert.deepEqual(fx.events, expected);
    if (kind === 'staging-issue') assert.equal(fx.completedResult().staging, true);
    if (kind === 'dry-run-renew') assert.equal(fx.completedResult().dryRun, true);
    if (fx.data.live) assert.equal(fx.completedResult().fingerprint256, fingerprint);
  });
}

test('missing certificate receipt leaves the running job unresolved before live inspection', async () => {
  const fx = fixture('production-issue', { receiptPresent: false });
  await assert.rejects(recoverRunningCertificateOperation(fx.options), { code: 'job_certificate_recovery_receipt_missing' });
  assert.deepEqual(fx.events, ['get', 'context', 'certificate', 'receipt']);
});

test('production certificate fingerprint drift is rejected before reconciliation', async () => {
  const fx = fixture('production-renew');
  fx.options.inspectCertificate = async () => {
    fx.events.push('live');
    return { ...liveCertificate(), fingerprint256: Array.from({ length: 32 }, () => 'AA').join(':') };
  };
  await assert.rejects(recoverRunningCertificateOperation(fx.options), { code: 'job_certificate_recovery_evidence_not_satisfied' });
  assert.deepEqual(fx.events, ['get', 'context', 'certificate', 'receipt', 'live']);
});
