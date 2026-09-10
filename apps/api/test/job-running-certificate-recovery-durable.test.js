import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createCertificateOperationReceiptStore } from '../src/certificate-operation-receipt.js';
import { createCertificateRegistry } from '../src/certificate-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createJobRecoveryContextReader } from '../src/job-recovery-context.js';
import { createJobRegistry } from '../src/job-registry.js';
import { recoverRunningCertificateOperation } from '../src/job-running-certificate-recovery.js';
import { createServerRegistry } from '../src/server-registry.js';

const fingerprint = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, '0')).join(':').toUpperCase();
const renewedFingerprint = Array.from({ length: 32 }, (_, index) => (31 - index).toString(16).padStart(2, '0')).join(':').toUpperCase();

function liveCertificate({ fingerprint256 = fingerprint, validFrom = '2026-09-10T00:00:00.000Z', validTo = '2026-12-09T00:00:00.000Z' } = {}) {
  const base = '/etc/letsencrypt/live/example.com';
  return {
    certName: 'example.com',
    certificatePath: `${base}/cert.pem`,
    fullchainPath: `${base}/fullchain.pem`,
    privateKeyPath: `${base}/privkey.pem`,
    subject: 'CN=example.com',
    issuer: 'CN=Test CA',
    subjectAltName: 'DNS:example.com, DNS:www.example.com',
    validFrom,
    validTo,
    fingerprint256,
  };
}

async function fixture(t, kind) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-certificate-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const serverRegistry = createServerRegistry({ filePath: path.join(root, 'servers.json') });
  await serverRegistry.init();
  const server = await serverRegistry.createLocalServer({ hostname: 'certificate-recovery-host' });

  const domainRegistry = createDomainRegistry({
    filePath: path.join(root, 'domains.json'),
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
  });
  await domainRegistry.init();
  const domain = await domainRegistry.createDomain({
    serverId: server.id,
    primaryDomain: 'example.com',
    aliases: ['www.example.com'],
    targetType: 'static',
    target: { root: '/var/www/example.com' },
    httpsMode: 'managed',
  });

  const staging = kind === 'staging-issue';
  const certificateRegistry = createCertificateRegistry({ filePath: path.join(root, 'certificates.json') });
  await certificateRegistry.init();
  const certificate = await certificateRegistry.createForDomain({
    domainId: domain.id,
    serverId: server.id,
    domains: ['example.com', 'www.example.com'],
    email: 'ops@example.com',
    staging,
  });

  const renewing = kind === 'dry-run-renew' || kind === 'production-renew';
  if (renewing) {
    await certificateRegistry.setState(certificate.id, 'issuing');
    await certificateRegistry.markActive(certificate.id, liveCertificate());
    await domainRegistry.attachCertificate(domain.id, certificate.id);
    if (kind === 'production-renew') await certificateRegistry.setState(certificate.id, 'renewing');
  } else {
    await certificateRegistry.setState(certificate.id, 'issuing');
  }

  const operation = renewing ? OPERATIONS.SSL_RENEW : OPERATIONS.SSL_ISSUE;
  const payload = renewing
    ? { certName: 'example.com', dryRun: kind === 'dry-run-renew' }
    : { domains: ['example.com', 'www.example.com'], email: 'ops@example.com', staging };
  const jobStore = path.join(root, 'jobs.json');
  const first = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await first.init();
  const queued = await first.enqueue({
    serverId: server.id,
    type: operation,
    operation,
    payload,
    resourceType: 'certificate',
    resourceId: certificate.id,
  });
  const claimed = await first.claimNext(server.id);
  assert.equal(claimed.job.id, queued.id);

  const restarted = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await restarted.init();
  assert.equal(restarted.recovery().jobs[0].jobId, queued.id);

  return {
    root,
    server,
    domain,
    certificate,
    domainRegistry,
    certificateRegistry,
    jobId: queued.id,
    jobRegistry: restarted,
    contextReader: createJobRecoveryContextReader({ filePath: jobStore }),
    receiptStore: createCertificateOperationReceiptStore({ root: path.join(root, 'receipts') }),
    operation,
    payload,
  };
}

const stoppedConsumers = async () => ({ apiActive: false, agentActive: false });

for (const kind of ['staging-issue', 'production-issue', 'dry-run-renew', 'production-renew']) {
  test(`verified ${kind} receipt closes the same durable certificate job`, async (t) => {
    const fx = await fixture(t, kind);
    let result;
    let live = null;
    if (kind === 'staging-issue') {
      result = { certName: 'example.com', domains: ['example.com', 'www.example.com'], staging: true, status: 'validated' };
    } else if (kind === 'production-issue') {
      live = liveCertificate();
      result = { ...live, domains: ['example.com', 'www.example.com'], staging: false, status: 'issued' };
    } else if (kind === 'dry-run-renew') {
      result = { certName: 'example.com', dryRun: true, status: 'validated' };
    } else {
      live = liveCertificate({
        fingerprint256: renewedFingerprint,
        validFrom: '2026-09-11T00:00:00.000Z',
        validTo: '2026-12-10T00:00:00.000Z',
      });
      result = { ...live, dryRun: false, status: 'renewed' };
    }
    await fx.receiptStore.write({
      serverId: fx.server.id,
      jobId: fx.jobId,
      certificateId: fx.certificate.id,
      operation: fx.operation,
      result,
    });

    const recovered = await recoverRunningCertificateOperation({
      serverId: fx.server.id,
      jobId: fx.jobId,
      jobRegistry: fx.jobRegistry,
      domainRegistry: fx.domainRegistry,
      certificateRegistry: fx.certificateRegistry,
      serviceStatus: stoppedConsumers,
      loadJobContext: (id) => fx.contextReader.read(id),
      readCertificateReceipt: (serverId, jobId) => fx.receiptStore.read(serverId, jobId),
      inspectCertificate: async () => live,
    });

    assert.equal(recovered.status, 'succeeded');
    assert.equal(fx.jobRegistry.recovery(), null);
    assert.equal((await fx.jobRegistry.getJob(fx.jobId)).status, 'succeeded');

    const certificate = await fx.certificateRegistry.getCertificate(fx.certificate.id);
    const domain = await fx.domainRegistry.getDomain(fx.domain.id);
    if (kind === 'staging-issue') {
      assert.equal(certificate.state, 'validated');
      assert.ok(certificate.lastValidatedAt);
      assert.equal(domain.certificateId, null);
    } else if (kind === 'production-issue') {
      assert.equal(certificate.state, 'active');
      assert.equal(certificate.fingerprint256, fingerprint);
      assert.equal(domain.certificateId, certificate.id);
      assert.ok(certificate.lastIssuedAt);
    } else if (kind === 'dry-run-renew') {
      assert.equal(certificate.state, 'active');
      assert.equal(certificate.fingerprint256, fingerprint);
      assert.equal(domain.certificateId, certificate.id);
    } else {
      assert.equal(certificate.state, 'active');
      assert.equal(certificate.fingerprint256, renewedFingerprint);
      assert.equal(domain.certificateId, certificate.id);
      assert.ok(certificate.lastRenewedAt);
    }
  });
}

test('missing certificate receipt preserves durable running state', async (t) => {
  const fx = await fixture(t, 'production-issue');
  await assert.rejects(
    recoverRunningCertificateOperation({
      serverId: fx.server.id,
      jobId: fx.jobId,
      jobRegistry: fx.jobRegistry,
      domainRegistry: fx.domainRegistry,
      certificateRegistry: fx.certificateRegistry,
      serviceStatus: stoppedConsumers,
      loadJobContext: (id) => fx.contextReader.read(id),
      readCertificateReceipt: (serverId, jobId) => fx.receiptStore.read(serverId, jobId),
      inspectCertificate: async () => liveCertificate(),
    }),
    { code: 'job_certificate_recovery_receipt_missing' },
  );
  assert.equal((await fx.jobRegistry.getJob(fx.jobId)).status, 'running');
  assert.equal(fx.jobRegistry.recovery().jobs[0].jobId, fx.jobId);
});
