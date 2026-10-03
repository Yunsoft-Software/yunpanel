import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createCertificateMaterialManager } from '../src/certificate-material-manager.js';
import { createCertificateRegistry } from '../src/certificate-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createWebsiteRegistry } from '../src/website-registry.js';
import { withPanelContext } from './helpers/panel-auth-fixture.js';

const execFileAsync = promisify(execFile);

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

async function requestJson(url, { method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

async function generateCertificate(directory, name) {
  const certificatePath = path.join(directory, `${name}.crt`);
  const privateKeyPath = path.join(directory, `${name}.key`);
  await execFileAsync('/usr/bin/openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-subj', '/CN=secure.example.com',
    '-addext', 'subjectAltName=DNS:secure.example.com,DNS:www.secure.example.com',
    '-keyout', privateKeyPath,
    '-out', certificatePath,
  ], { timeout: 15_000, maxBuffer: 1024 * 1024 });
  return {
    certificatePem: await readFile(certificatePath, 'utf8'),
    chainPem: '',
    privateKeyPem: await readFile(privateKeyPath, 'utf8'),
  };
}

test('Owner imports and reselects matched custom certificates without exposing PEM material', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-certificate-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const customRoot = path.join(directory, 'custom-certificates');
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'custom-certificate-host' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'custom-certificate-host' });
  const domainRegistry = createDomainRegistry({
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  const domain = await domainRegistry.createDomain({
    serverId: enrolled.server.id,
    primaryDomain: 'secure.example.com',
    aliases: ['www.secure.example.com'],
    targetType: 'proxy',
    target: { upstreamPort: 4301 },
    httpsMode: 'managed',
  });
  const certificateRegistry = createCertificateRegistry({ customRoot });
  const certificateMaterialManager = createCertificateMaterialManager({ customRoot, getUid: () => 0 });
  const app = withPanelContext(createApp({
    environment: 'production',
    registry: serverRegistry,
    domainRegistry,
    certificateRegistry,
    certificateMaterialManager,
    jobRegistry: createJobRegistry(),
    localServerId: enrolled.server.id,
  }));
  const firstMaterial = await generateCertificate(directory, 'first');
  const secondMaterial = await generateCertificate(directory, 'second');

  await withServer(app, async (baseUrl) => {
    async function importCertificate(material) {
      const preview = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/custom-preview`, {
        method: 'POST', body: material,
      });
      assert.equal(preview.response.status, 200);
      assert.match(preview.payload.data.previewDigest, /^[a-f0-9]{64}$/);
      assert.equal(preview.payload.data.certificate.source, 'custom');
      const applied = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/custom`, {
        method: 'POST',
        body: {
          ...material,
          previewDigest: preview.payload.data.previewDigest,
          confirmation: preview.payload.data.confirmation,
        },
      });
      assert.equal(applied.response.status, 201);
      assert.doesNotMatch(JSON.stringify(applied.payload), /BEGIN (?:CERTIFICATE|PRIVATE KEY)|privateKeyPath|materialDigest/);
      return applied.payload.data.certificate;
    }

    const concurrentPreview = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/custom-preview`, {
      method: 'POST', body: firstMaterial,
    });
    assert.equal(concurrentPreview.response.status, 200);
    const concurrentBody = {
      ...firstMaterial,
      previewDigest: concurrentPreview.payload.data.previewDigest,
      confirmation: concurrentPreview.payload.data.confirmation,
    };
    const concurrent = await Promise.all([
      requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/custom`, { method: 'POST', body: concurrentBody }),
      requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/custom`, { method: 'POST', body: concurrentBody }),
    ]);
    assert.deepEqual(concurrent.map((entry) => entry.response.status).sort(), [201, 409]);
    const first = concurrent.find((entry) => entry.response.status === 201).payload.data.certificate;
    assert.equal((await certificateRegistry.listCertificates()).length, 1);
    assert.equal((await domainRegistry.getDomain(domain.id)).certificateId, first.id);
    const second = await importCertificate(secondMaterial);
    assert.equal((await certificateRegistry.getCertificate(first.id)).state, 'superseded');
    assert.equal((await domainRegistry.getDomain(domain.id)).certificateId, second.id);

    const preview = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/${first.id}/select-preview`, {
      method: 'POST', body: {},
    });
    assert.equal(preview.response.status, 200);
    const selected = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/${first.id}/select`, {
      method: 'POST',
      body: { previewDigest: preview.payload.data.previewDigest, confirmation: preview.payload.data.confirmation },
    });
    assert.equal(selected.response.status, 200);
    assert.equal((await domainRegistry.getDomain(domain.id)).certificateId, first.id);
    assert.equal((await certificateRegistry.getCertificate(first.id)).state, 'active');
    assert.equal((await certificateRegistry.getCertificate(second.id)).state, 'superseded');
    assert.doesNotMatch(JSON.stringify(selected.payload), /privateKeyPath|materialDigest|BEGIN/);

    const selectedRecord = await certificateRegistry.getCertificate(first.id);
    await writeFile(selectedRecord.privateKeyPath, secondMaterial.privateKeyPem, 'utf8');
    const tamperedStage = await requestJson(`${baseUrl}/api/domains/${domain.id}/stage`, { method: 'POST' });
    assert.equal(tamperedStage.response.status, 409);
    assert.equal(tamperedStage.payload.error.code, 'certificate_private_key_mismatch');
    assert.equal((await certificateRegistry.getCertificate(first.id)).state, 'active');
  });
});

test('custom certificate API rejects mismatched keys and remote Domains before persistence', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-certificate-http-denied-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await generateCertificate(directory, 'first');
  const second = await generateCertificate(directory, 'second');
  const domainRegistry = createDomainRegistry();
  const domain = await domainRegistry.createDomain({
    serverId: 'remote', primaryDomain: 'secure.example.com', aliases: ['www.secure.example.com'],
    targetType: 'proxy', target: { upstreamPort: 4301 }, httpsMode: 'managed',
  });
  const customRoot = path.join(directory, 'custom-certificates');
  const certificateRegistry = createCertificateRegistry({ customRoot });
  const app = withPanelContext(createApp({
    environment: 'production',
    domainRegistry,
    certificateRegistry,
    certificateMaterialManager: createCertificateMaterialManager({ customRoot, getUid: () => 0 }),
    jobRegistry: createJobRegistry(),
    localServerId: 'local',
  }));

  await withServer(app, async (baseUrl) => {
    const remote = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/custom-preview`, {
      method: 'POST', body: first,
    });
    assert.equal(remote.response.status, 409);
    assert.equal(remote.payload.error.code, 'local_certificate_required');

    const localRegistry = createDomainRegistry();
    const local = await localRegistry.createDomain({
      serverId: 'local', primaryDomain: 'secure.example.com', aliases: ['www.secure.example.com'],
      targetType: 'proxy', target: { upstreamPort: 4301 }, httpsMode: 'managed',
    });
    const localApp = withPanelContext(createApp({
      environment: 'production', domainRegistry: localRegistry, certificateRegistry,
      certificateMaterialManager: createCertificateMaterialManager({ customRoot, getUid: () => 0 }),
      jobRegistry: createJobRegistry(), localServerId: 'local',
    }));
    await withServer(localApp, async (localBaseUrl) => {
      const mismatch = await requestJson(`${localBaseUrl}/api/domains/${local.id}/certificates/custom-preview`, {
        method: 'POST',
        body: { ...first, privateKeyPem: second.privateKeyPem },
      });
      assert.equal(mismatch.response.status, 409);
      assert.equal(mismatch.payload.error.code, 'certificate_private_key_mismatch');
      assert.doesNotMatch(JSON.stringify(mismatch.payload), /BEGIN|PRIVATE KEY/);
      assert.equal((await certificateRegistry.listCertificates()).length, 0);
    });
  });
});

test('Certificate GC preview and sweep routes expose retention candidates and sweep results', async () => {
  const certificateRegistry = createCertificateRegistry();
  const mockGc = {
    async inspectGcCandidates({ retentionDays }) {
      return {
        inspectedAt: '2026-10-30T00:00:00.000Z',
        retentionDays: retentionDays ?? 30,
        totalCertificates: 1,
        eligibleCount: 1,
        retainedCount: 0,
        sharedActiveCount: 0,
        sharedRetainedCount: 0,
        alreadyPurgedCount: 0,
        notRetiredCount: 0,
        eligible: [{ id: 'cert-1', certName: 'test.com', source: 'custom' }],
      };
    },
    async sweep({ retentionDays, dryRun }) {
      return {
        sweptCount: 1,
        sweptCertificates: [{ id: 'cert-1', certName: 'test.com', source: 'custom' }],
        purgedAt: '2026-10-30T00:00:00.000Z',
        dryRun: Boolean(dryRun),
      };
    },
  };

  const app = withPanelContext(createApp({
    certificateRegistry,
    certificateMaterialGc: mockGc,
    localServerId: 'local',
  }));

  await withServer(app, async (baseUrl) => {
    // 1. Preview
    const preview = await requestJson(`${baseUrl}/api/certificates/gc/preview?retentionDays=14`);
    assert.equal(preview.response.status, 200);
    assert.equal(preview.payload.data.retentionDays, 14);
    assert.equal(preview.payload.data.eligibleCount, 1);

    // 2. Sweep dry-run
    const drySweep = await requestJson(`${baseUrl}/api/certificates/gc/sweep`, {
      method: 'POST',
      body: { dryRun: true },
    });
    assert.equal(drySweep.response.status, 200);
    assert.equal(drySweep.payload.data.dryRun, true);
    assert.equal(drySweep.payload.data.sweptCount, 1);

    // 3. Real sweep
    const realSweep = await requestJson(`${baseUrl}/api/certificates/gc/sweep`, {
      method: 'POST',
      body: { dryRun: false },
    });
    assert.equal(realSweep.response.status, 200);
    assert.equal(realSweep.payload.data.dryRun, false);
    assert.equal(realSweep.payload.data.sweptCount, 1);
  });
});

test('Verify-TLS, renewal-outcome, and reload-outcome endpoints expose presentation checks and handle partial reloads gracefully (live TLS and registry state)', async () => {
  const certificateRegistry = createCertificateRegistry();
  const domainRegistry = createDomainRegistry();
  const jobRegistry = createJobRegistry();
  const localServerId = 'server-local-1';

  const domain = await domainRegistry.createDomain({
    serverId: localServerId,
    primaryDomain: 'tls-probe.example.com',
    aliases: [],
    targetType: 'proxy',
    target: { upstreamPort: 8080 },
    httpsMode: 'managed',
  });

  const validFrom = '2026-09-01T00:00:00.000Z';
  const validTo = '2026-12-01T00:00:00.000Z';
  const fingerprint256 = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';

  const certificate = await certificateRegistry.createForDomain({
    domainId: domain.id,
    serverId: localServerId,
    domains: ['tls-probe.example.com'],
    email: 'admin@example.com',
  });

  await certificateRegistry.markActive(certificate.id, {
    certName: 'tls-probe.example.com',
    certificatePath: `/etc/letsencrypt/live/tls-probe.example.com/cert.pem`,
    fullchainPath: `/etc/letsencrypt/live/tls-probe.example.com/fullchain.pem`,
    privateKeyPath: `/etc/letsencrypt/live/tls-probe.example.com/privkey.pem`,
    validFrom,
    validTo,
    fingerprint256,
  });

  const app = withPanelContext(createApp({
    certificateRegistry,
    domainRegistry,
    jobRegistry,
    localServerId,
  }));

  await withServer(app, async (baseUrl) => {
    // 1. Verify-TLS matching
    const matchRes = await requestJson(`${baseUrl}/api/certificates/${certificate.id}/verify-tls`, {
      method: 'POST',
      body: {
        liveTls: {
          validFrom,
          validTo,
          fingerprint256,
        },
      },
    });
    assert.equal(matchRes.response.status, 200);
    assert.equal(matchRes.payload.data.matches, true);
    assert.equal(matchRes.payload.data.fingerprint256, fingerprint256);

    // 2. Verify-TLS mismatch
    const mismatchRes = await requestJson(`${baseUrl}/api/certificates/${certificate.id}/verify-tls`, {
      method: 'POST',
      body: {
        liveTls: {
          validFrom,
          validTo,
          fingerprint256: '00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
        },
      },
    });
    assert.equal(mismatchRes.response.status, 200);
    assert.equal(mismatchRes.payload.data.matches, false);
    assert.equal(mismatchRes.payload.data.reason, 'fingerprint_mismatch');

    // 3. Domain-scoped verify-tls
    const domainScoped = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/${certificate.id}/verify-tls`, {
      method: 'POST',
      body: {
        liveTls: { validFrom, validTo, fingerprint256 },
      },
    });
    assert.equal(domainScoped.response.status, 200);
    assert.equal(domainScoped.payload.data.matches, true);
    assert.equal(domainScoped.payload.data.domainId, domain.id);

    // 4. Renewal outcome endpoint
    const renewalJob = await jobRegistry.enqueue({
      serverId: localServerId,
      type: 'ssl.renew',
      operation: 'ssl.renew',
      payload: { certName: 'tls-probe.example.com', dryRun: false },
      resourceType: 'certificate',
      resourceId: certificate.id,
    });
    await jobRegistry.claimNext(localServerId);
    await jobRegistry.complete({
      serverId: localServerId,
      jobId: renewalJob.id,
      status: 'succeeded',
      result: {
        certName: 'tls-probe.example.com',
        certificatePath: '/etc/letsencrypt/live/tls-probe.example.com/cert.pem',
        fullchainPath: '/etc/letsencrypt/live/tls-probe.example.com/fullchain.pem',
        privateKeyPath: '/etc/letsencrypt/live/tls-probe.example.com/privkey.pem',
        status: 'renewed',
        validFrom,
        validTo,
        fingerprint256,
      },
    });

    const renewalOutcomeRes = await requestJson(`${baseUrl}/api/certificates/${certificate.id}/renewal-outcome`, {
      method: 'POST',
      body: {
        jobId: renewalJob.id,
        liveTls: { validFrom, validTo, fingerprint256 },
      },
    });
    assert.equal(renewalOutcomeRes.response.status, 200);
    assert.equal(renewalOutcomeRes.payload.data.verified, true);

    // 5. Reload outcome handling: partial reload gracefully handled without corrupting certificate
    const partialReloadRes = await requestJson(`${baseUrl}/api/certificates/${certificate.id}/reload-outcome`, {
      method: 'POST',
      body: {
        service: 'nginx',
        status: 'partial',
        stage: 'stage',
        error: 'nginx reload warning on secondary listener',
      },
    });
    assert.equal(partialReloadRes.response.status, 200);
    assert.equal(partialReloadRes.payload.data.certificate.state, 'active');
    assert.equal(partialReloadRes.payload.data.certificate.lastReloadOutcome.status, 'partial');
    assert.equal(partialReloadRes.payload.data.certificate.lastReloadOutcome.service, 'nginx');

    const updatedCert = await certificateRegistry.getCertificate(certificate.id);
    assert.equal(updatedCert.state, 'active');
    assert.equal(updatedCert.diagnosis.code, 'certificate_reload_partial');
    assert.equal(updatedCert.diagnosis.severity, 'warning');

    // 6. Reload outcome: succeed clears warning
    const successReloadRes = await requestJson(`${baseUrl}/api/certificates/${certificate.id}/reload-outcome`, {
      method: 'POST',
      body: {
        service: 'nginx',
        status: 'succeeded',
      },
    });
    assert.equal(successReloadRes.response.status, 200);
    assert.equal(successReloadRes.payload.data.certificate.lastReloadOutcome.status, 'succeeded');
    assert.equal(successReloadRes.payload.data.certificate.diagnosis, null);

    const clearedCert = await certificateRegistry.getCertificate(certificate.id);
    assert.equal(clearedCert.state, 'active');
    assert.equal(clearedCert.diagnosis, null);
  });
});

test('Verify-TLS, renewal-outcome, and reload-outcome endpoints expose presentation checks and handle partial reloads gracefully (presentation checks and service matrix)', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-cert-presentation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const customRoot = path.join(directory, 'custom-certificates');
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'presentation-host' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'presentation-host' });

  const domainRegistry = createDomainRegistry({
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  const domain = await domainRegistry.createDomain({
    serverId: enrolled.server.id,
    primaryDomain: 'secure.example.com',
    aliases: ['www.secure.example.com'],
    targetType: 'proxy',
    target: { upstreamPort: 4301 },
    httpsMode: 'managed',
  });

  const certificateRegistry = createCertificateRegistry({ customRoot });
  const certificateMaterialManager = createCertificateMaterialManager({ customRoot, getUid: () => 0 });
  const jobRegistry = createJobRegistry();
  const testJobs = new Map();
  const baseGetJob = jobRegistry.getJob.bind(jobRegistry);
  const baseListJobs = jobRegistry.listJobs.bind(jobRegistry);

  jobRegistry.createJob = async ({ serverId, operation, resourceType, resourceId }) => {
    const id = randomUUID();
    const job = {
      id,
      serverId,
      operation,
      resourceType,
      resourceId,
      status: 'queued',
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
    };
    testJobs.set(id, job);
    return job;
  };

  jobRegistry.updateJobStatus = async (id, status, { result = null, error = null } = {}) => {
    const job = testJobs.get(id);
    if (job) {
      job.status = status;
      job.result = result;
      job.error = error;
      job.finishedAt = new Date().toISOString();
    }
    return job;
  };

  jobRegistry.getJob = async (id) => {
    if (testJobs.has(id)) {
      return testJobs.get(id);
    }
    return baseGetJob(id);
  };

  jobRegistry.listJobs = async (filter) => {
    const fromBase = await baseListJobs(filter);
    const fromCustom = Array.from(testJobs.values()).filter((j) => {
      if (filter?.serverId && j.serverId !== filter.serverId) return false;
      if (filter?.resourceType && j.resourceType !== filter.resourceType) return false;
      if (filter?.resourceId && j.resourceId !== filter.resourceId) return false;
      if (filter?.status && j.status !== filter.status) return false;
      return true;
    });
    return [...fromBase, ...fromCustom];
  };

  const app = withPanelContext(createApp({
    environment: 'production',
    registry: serverRegistry,
    domainRegistry,
    certificateRegistry,
    certificateMaterialManager,
    jobRegistry,
    localServerId: enrolled.server.id,
  }));

  const material = await generateCertificate(directory, 'presentation');

  await withServer(app, async (baseUrl) => {
    // 1. Import a custom certificate to test against
    const preview = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/custom-preview`, {
      method: 'POST',
      body: material,
    });
    assert.equal(preview.response.status, 200);

    const apply = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/custom`, {
      method: 'POST',
      body: {
        ...material,
        previewDigest: preview.payload.data.previewDigest,
        confirmation: preview.payload.data.confirmation,
      },
    });
    assert.equal(apply.response.status, 201);
    const cert = apply.payload.data.certificate;

    // 2. Test Verify-TLS endpoint exposes presentation checks
    const verifyTls = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/${cert.id}/verify-tls`);
    assert.equal(verifyTls.response.status, 200);
    assert.equal(verifyTls.payload.data.verified, true);
    assert.equal(verifyTls.payload.data.status, 'valid');
    assert.equal(verifyTls.payload.data.code, 'tls_verified');
    assert.ok(verifyTls.payload.data.presentationChecks);
    assert.equal(verifyTls.payload.data.presentationChecks.domainsMatch, true);
    assert.equal(verifyTls.payload.data.presentationChecks.notExpired, true);
    assert.equal(verifyTls.payload.data.presentationChecks.fingerprintValid, true);
    assert.equal(verifyTls.payload.data.presentationChecks.materialVerified, true);
    assert.equal(verifyTls.payload.data.presentationChecks.isExpiringSoon, true);

    // Also test verify-tls directly via domain route
    const domainVerifyTls = await requestJson(`${baseUrl}/api/domains/${domain.id}/verify-tls`);
    assert.equal(domainVerifyTls.response.status, 200);
    assert.equal(domainVerifyTls.payload.data.verified, true);

    // 3. Test Renewal-outcome endpoint with various job states and safe undefined handling
    // 3a. Initial state (no jobs yet)
    const initialRenewal = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/${cert.id}/renewal-outcome`);
    assert.equal(initialRenewal.response.status, 200);
    assert.equal(initialRenewal.payload.data.outcome, 'idle');
    assert.equal(initialRenewal.payload.data.presentationChecks.waiting, false);
    assert.equal(initialRenewal.payload.data.presentationChecks.failed, false);

    // 3b. Succeeded dryRun job -> outcome 'tested'
    const dryRunJob = await jobRegistry.createJob({
      serverId: enrolled.server.id,
      operation: 'ssl.renew',
      resourceType: 'certificate',
      resourceId: cert.id,
    });
    await jobRegistry.updateJobStatus(dryRunJob.id, 'succeeded', {
      result: { dryRun: true, status: 'validated', certName: 'secure.example.com' },
    });

    const dryRunRenewal = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/${cert.id}/renewal-outcome?jobId=${dryRunJob.id}`);
    assert.equal(dryRunRenewal.response.status, 200);
    assert.equal(dryRunRenewal.payload.data.outcome, 'tested');
    assert.equal(dryRunRenewal.payload.data.code, 'tested');
    assert.equal(dryRunRenewal.payload.data.presentationChecks.tested, true);

    // 3c. Failed job with undefined error object (verifying code property does not throw TypeError)
    const failedJob = await jobRegistry.createJob({
      serverId: enrolled.server.id,
      operation: 'ssl.renew',
      resourceType: 'certificate',
      resourceId: cert.id,
    });
    // Deliberately set status failed without an error.code property
    await jobRegistry.updateJobStatus(failedJob.id, 'failed');

    const failedRenewal = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/${cert.id}/renewal-outcome?jobId=${failedJob.id}`);
    assert.equal(failedRenewal.response.status, 200);
    assert.equal(failedRenewal.payload.data.outcome, 'failed');
    assert.equal(failedRenewal.payload.data.code, 'renewal_job_failed');
    assert.equal(failedRenewal.payload.data.presentationChecks.failed, true);
    assert.ok(failedRenewal.payload.data.error);
    assert.equal(failedRenewal.payload.data.error.code, 'renewal_job_failed');

    // 4. Test Reload-outcome endpoint handling partial reloads gracefully
    // 4a. Complete reload (all services ok)
    const completeReload = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/${cert.id}/reload-outcome`, {
      method: 'POST',
      body: {
        services: {
          nginx: { ok: true },
        },
      },
    });
    assert.equal(completeReload.response.status, 200);
    assert.equal(completeReload.payload.data.status, 'reloaded');
    assert.equal(completeReload.payload.data.partial, false);
    assert.equal(completeReload.payload.data.outcome, 'complete_reload');
    assert.equal(completeReload.payload.data.code, 'reload_succeeded');
    assert.equal(completeReload.payload.data.presentationChecks.allServicesReloaded, true);
    assert.equal(completeReload.payload.data.presentationChecks.partialReload, false);

    // 4b. Partial reload where mail service fails and its error object or error.code is undefined
    const partialReload = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/${cert.id}/reload-outcome`, {
      method: 'POST',
      body: {
        services: {
          nginx: { ok: true },
          mail: { ok: false }, // Note: error object is omitted/undefined!
        },
      },
    });
    assert.equal(partialReload.response.status, 200);
    assert.equal(partialReload.payload.data.status, 'partial');
    assert.equal(partialReload.payload.data.partial, true);
    assert.equal(partialReload.payload.data.outcome, 'partial_reload');
    assert.equal(partialReload.payload.data.code, 'partial_reload');
    assert.equal(partialReload.payload.data.presentationChecks.partialReload, true);
    assert.equal(partialReload.payload.data.presentationChecks.hasFailures, true);

    const nginxService = partialReload.payload.data.services.find((s) => s.service === 'nginx');
    const mailService = partialReload.payload.data.services.find((s) => s.service === 'mail');
    assert.ok(nginxService);
    assert.equal(nginxService.ok, true);
    assert.equal(nginxService.code, 'ok');
    assert.equal(nginxService.error, null);

    assert.ok(mailService);
    assert.equal(mailService.ok, false);
    assert.equal(mailService.code, 'service_reload_failed');
    assert.ok(mailService.error);
    assert.equal(mailService.error.code, 'service_reload_failed');

    // 4c. Partial reload with array representation and explicit error code
    const arrayReload = await requestJson(`${baseUrl}/api/domains/${domain.id}/reload-outcome`, {
      method: 'POST',
      body: {
        services: [
          { service: 'nginx', ok: true },
          { service: 'mail', ok: false, error: { code: 'postfix_reload_failed', message: 'Postfix reload failed' } },
        ],
      },
    });
    assert.equal(arrayReload.response.status, 200);
    assert.equal(arrayReload.payload.data.partial, true);
    const failedArrayMail = arrayReload.payload.data.services.find((s) => s.service === 'mail');
    assert.equal(failedArrayMail.error.code, 'postfix_reload_failed');
  });
});

test('SSL certificate issuance endpoint validates contact email, preserves user payload, and avoids silent global ACME fallback (BUG-04/05)', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-cert-issue-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const customRoot = path.join(directory, 'custom-certificates');
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'issue-host' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'issue-host' });

  const domainRegistry = createDomainRegistry({
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  const domain = await domainRegistry.createDomain({
    serverId: enrolled.server.id,
    primaryDomain: 'issue.example.com',
    aliases: ['www.issue.example.com'],
    targetType: 'proxy',
    target: { upstreamPort: 8080 },
    httpsMode: 'managed',
  });

  const checksum = 'c'.repeat(64);
  await domainRegistry.markStaged(domain.id, {
    checksum,
    configName: 'yunpanel-issue.example.com.conf',
  });
  await domainRegistry.markApplied(domain.id, { checksum });

  const certificateRegistry = createCertificateRegistry({ customRoot });
  const certificateMaterialManager = createCertificateMaterialManager({ customRoot, getUid: () => 0 });
  const jobRegistry = createJobRegistry();

  const app = withPanelContext(createApp({
    environment: 'production',
    registry: serverRegistry,
    domainRegistry,
    certificateRegistry,
    certificateMaterialManager,
    jobRegistry,
    localServerId: enrolled.server.id,
  }));

  await withServer(app, async (baseUrl) => {
    // 1. Missing contact email is rejected with invalid_acme_email (no silent global fallback - BUG-05)
    const missingEmail = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/issue`, {
      method: 'POST',
      body: { staging: true },
    });
    assert.equal(missingEmail.response.status, 400);
    assert.equal(missingEmail.payload.error.code, 'invalid_acme_email');

    // 2. Malformed contact email is rejected without throwing unhandled errors
    const invalidEmail = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/issue`, {
      method: 'POST',
      body: { email: 'not-an-email', staging: true },
    });
    assert.equal(invalidEmail.response.status, 400);
    assert.equal(invalidEmail.payload.error.code, 'invalid_acme_email');

    // 3. Valid user-provided contact email and explicit domain list are accepted and preserved (BUG-04/05 payload preservation)
    const validIssue = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/issue`, {
      method: 'POST',
      body: {
        email: 'user.contact@example.test',
        staging: true,
        domains: ['issue.example.com', 'www.issue.example.com'],
      },
    });
    assert.equal(validIssue.response.status, 202);
    assert.equal(validIssue.payload.data.certificate.email, 'user.contact@example.test');
    assert.deepEqual(validIssue.payload.data.certificate.certificateNames, ['issue.example.com', 'www.issue.example.com']);
    assert.ok(validIssue.payload.data.job);

    const queuedJob = await jobRegistry.getJob(validIssue.payload.data.job.id);
    assert.equal(queuedJob.operation, 'ssl.issue');
    assert.equal(queuedJob.payload.email, 'user.contact@example.test');
    assert.deepEqual(queuedJob.payload.domains, ['issue.example.com', 'www.issue.example.com']);
    assert.equal(queuedJob.payload.staging, true);

    // 4. Verify BUG-06 boundary: certificate issuance is distinct from renewal synchronization
    const certRecord = await certificateRegistry.getCertificate(validIssue.payload.data.certificate.id);
    assert.equal(certRecord.state, 'validating');
    assert.equal(validIssue.payload.data.certificate.state, 'validating');
    const outcomeRes = await requestJson(`${baseUrl}/api/certificates/${certRecord.id}/renewal-outcome?jobId=${queuedJob.id}`);
    assert.equal(outcomeRes.response.status, 200);
    assert.notEqual(outcomeRes.payload.data.outcome, 'renewed');

    // 5. Verify production issuance (staging: false) moves certificate to 'issuing' state
    const prodIssue = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/issue`, {
      method: 'POST',
      body: {
        email: 'user.contact@example.test',
        staging: false,
        domains: ['issue.example.com', 'www.issue.example.com'],
      },
    });
    assert.equal(prodIssue.response.status, 202);
    assert.equal(prodIssue.payload.data.certificate.email, 'user.contact@example.test');
    assert.equal(prodIssue.payload.data.certificate.state, 'issuing');
    const prodRecord = await certificateRegistry.getCertificate(prodIssue.payload.data.certificate.id);
    assert.equal(prodRecord.state, 'issuing');
  });
});

test('SSL certificate issuance validates Owner and authorized site account roles, user switching, email payload verification, cross-tenant isolation, and error responses (BUG-20260923-05)', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cert-http-role-test-'));
  try {
    const customRoot = path.join(directory, 'custom-certificates');
    const serverRegistry = createServerRegistry();
    const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'issue-role-host' });
    const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'issue-role-host' });

    const websiteRegistry = createWebsiteRegistry({
      serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
    });
    const websiteA = await websiteRegistry.createWebsite({
      serverId: enrolled.server.id,
      name: 'SiteA',
      runtimeType: 'proxy',
    });
    const websiteB = await websiteRegistry.createWebsite({
      serverId: enrolled.server.id,
      name: 'SiteB',
      runtimeType: 'proxy',
    });
    const websiteAId = websiteA.id;
    const websiteBId = websiteB.id;

    const domainRegistry = createDomainRegistry({
      getWebsite: async (id) => websiteRegistry.getWebsite(id),
      serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
    });

    // Domain A attached to Website A
    const domainA = await domainRegistry.createDomain({
      serverId: enrolled.server.id,
      websiteId: websiteAId,
      primaryDomain: 'site-a.example.com',
      aliases: ['www.site-a.example.com'],
      targetType: 'proxy',
      target: { upstreamPort: 8081 },
      httpsMode: 'managed',
    });
    const checksumA = 'a'.repeat(64);
    await domainRegistry.markStaged(domainA.id, {
      checksum: checksumA,
      configName: 'yunpanel-site-a.example.com.conf',
    });
    await domainRegistry.markApplied(domainA.id, { checksum: checksumA });

    // Additional domains on Website A for testing role switches and submissions
    const domainA2 = await domainRegistry.createDomain({
      serverId: enrolled.server.id,
      websiteId: websiteAId,
      primaryDomain: 'mgr-site-a.example.com',
      aliases: [],
      targetType: 'proxy',
      target: { upstreamPort: 8082 },
      httpsMode: 'managed',
    });
    await domainRegistry.markStaged(domainA2.id, {
      checksum: checksumA,
      configName: 'yunpanel-mgr-site-a.example.com.conf',
    });
    await domainRegistry.markApplied(domainA2.id, { checksum: checksumA });

    const domainA3 = await domainRegistry.createDomain({
      serverId: enrolled.server.id,
      websiteId: websiteAId,
      primaryDomain: 'cust-site-a.example.com',
      aliases: [],
      targetType: 'proxy',
      target: { upstreamPort: 8083 },
      httpsMode: 'managed',
    });
    await domainRegistry.markStaged(domainA3.id, {
      checksum: checksumA,
      configName: 'yunpanel-cust-site-a.example.com.conf',
    });
    await domainRegistry.markApplied(domainA3.id, { checksum: checksumA });

    const domainA4 = await domainRegistry.createDomain({
      serverId: enrolled.server.id,
      websiteId: websiteAId,
      primaryDomain: 'res-site-a.example.com',
      aliases: [],
      targetType: 'proxy',
      target: { upstreamPort: 8084 },
      httpsMode: 'managed',
    });
    await domainRegistry.markStaged(domainA4.id, {
      checksum: checksumA,
      configName: 'yunpanel-res-site-a.example.com.conf',
    });
    await domainRegistry.markApplied(domainA4.id, { checksum: checksumA });

    const domainA5 = await domainRegistry.createDomain({
      serverId: enrolled.server.id,
      websiteId: websiteAId,
      primaryDomain: 'edit-site-a.example.com',
      aliases: [],
      targetType: 'proxy',
      target: { upstreamPort: 8085 },
      httpsMode: 'managed',
    });
    await domainRegistry.markStaged(domainA5.id, {
      checksum: checksumA,
      configName: 'yunpanel-edit-site-a.example.com.conf',
    });
    await domainRegistry.markApplied(domainA5.id, { checksum: checksumA });

    // Domain B attached to Website B
    const domainB = await domainRegistry.createDomain({
      serverId: enrolled.server.id,
      websiteId: websiteBId,
      primaryDomain: 'site-b.example.com',
      aliases: [],
      targetType: 'proxy',
      target: { upstreamPort: 8086 },
      httpsMode: 'managed',
    });
    const checksumB = 'b'.repeat(64);
    await domainRegistry.markStaged(domainB.id, {
      checksum: checksumB,
      configName: 'yunpanel-site-b.example.com.conf',
    });
    await domainRegistry.markApplied(domainB.id, { checksum: checksumB });

    const certificateRegistry = createCertificateRegistry({ customRoot });
    const certificateMaterialManager = createCertificateMaterialManager({ customRoot, getUid: () => 0 });
    const jobRegistry = createJobRegistry();

    let currentAuthContext = null;
    const app = withPanelContext(createApp({
      environment: 'production',
      registry: serverRegistry,
      domainRegistry,
      websiteRegistry,
      certificateRegistry,
      certificateMaterialManager,
      jobRegistry,
      localServerId: enrolled.server.id,
    }), () => currentAuthContext);

    const ownerAuth = {
      user: { id: 'owner-user', username: 'owner-user', role: 'owner', email: 'owner@example.test' },
      security: { ownerMfaRequired: true, enrollmentRequired: false, managementAllowed: true },
      access: { mode: 'management', permissions: ['*'] },
    };

    const siteManagerAAuth = {
      user: { id: 'mgr-a', username: 'mgr-a', role: 'site_manager', websiteIds: [websiteAId], email: 'manager-a@site-a.test' },
      security: { managementAllowed: true },
      access: { mode: 'site_management' },
    };

    const customerAAuth = {
      user: { id: 'cust-a', username: 'cust-a', role: 'customer', websiteIds: [websiteAId], email: 'customer-a@site-a.test' },
      security: { managementAllowed: true },
      access: { mode: 'site_management' },
    };

    const resellerAAuth = {
      user: { id: 'res-a', username: 'res-a', role: 'reseller', websiteIds: [websiteAId], email: 'reseller-a@site-a.test' },
      security: { managementAllowed: true },
      access: { mode: 'site_management' },
    };

    const customerBAuth = {
      user: { id: 'cust-b', username: 'cust-b', role: 'customer', websiteIds: [websiteBId], email: 'customer-b@site-b.test' },
      security: { managementAllowed: true },
      access: { mode: 'site_management' },
    };

    const readOnlyAuth = {
      user: { id: 'reader', username: 'reader', role: 'read_only' },
      security: { managementAllowed: false },
      access: { mode: 'read_only', permissions: ['domains.read'] },
    };

    await withServer(app, async (baseUrl) => {
      // 1. Owner session issuing SSL certificate with user contact email in payload
      currentAuthContext = ownerAuth;
      const ownerIssue = await requestJson(`${baseUrl}/api/domains/${domainA.id}/certificates/issue`, {
        method: 'POST',
        body: { email: 'owner@example.test', staging: true },
      });
      assert.equal(ownerIssue.response.status, 202);
      assert.equal(ownerIssue.payload.data.certificate.email, 'owner@example.test');
      assert.ok(ownerIssue.payload.data.job);
      const ownerJob = await jobRegistry.getJob(ownerIssue.payload.data.job.id);
      assert.equal(ownerJob.operation, 'ssl.issue');
      assert.equal(ownerJob.payload.email, 'owner@example.test');

      // 2. Switching user session to authorized site manager (mgr-a) -> correct manager email in payload
      currentAuthContext = siteManagerAAuth;
      const mgrIssue = await requestJson(`${baseUrl}/api/domains/${domainA2.id}/certificates/issue`, {
        method: 'POST',
        body: { email: 'manager-a@site-a.test', staging: true },
      });
      assert.equal(mgrIssue.response.status, 202);
      assert.equal(mgrIssue.payload.data.certificate.email, 'manager-a@site-a.test');
      assert.ok(mgrIssue.payload.data.job);
      const mgrJob = await jobRegistry.getJob(mgrIssue.payload.data.job.id);
      assert.equal(mgrJob.operation, 'ssl.issue');
      assert.equal(mgrJob.payload.email, 'manager-a@site-a.test');

      // 3. Switching user session to authorized customer (cust-a) -> correct customer email in payload
      currentAuthContext = customerAAuth;
      const custIssue = await requestJson(`${baseUrl}/api/domains/${domainA3.id}/certificates/issue`, {
        method: 'POST',
        body: { email: 'customer-a@site-a.test', staging: true },
      });
      assert.equal(custIssue.response.status, 202);
      assert.equal(custIssue.payload.data.certificate.email, 'customer-a@site-a.test');
      assert.ok(custIssue.payload.data.job);
      const custJob = await jobRegistry.getJob(custIssue.payload.data.job.id);
      assert.equal(custJob.operation, 'ssl.issue');
      assert.equal(custJob.payload.email, 'customer-a@site-a.test');

      // 4. Switching user session to authorized reseller (res-a) -> correct reseller email in payload
      currentAuthContext = resellerAAuth;
      const resIssue = await requestJson(`${baseUrl}/api/domains/${domainA4.id}/certificates/issue`, {
        method: 'POST',
        body: { email: 'reseller-a@site-a.test', staging: true },
      });
      assert.equal(resIssue.response.status, 202);
      assert.equal(resIssue.payload.data.certificate.email, 'reseller-a@site-a.test');
      assert.ok(resIssue.payload.data.job);
      const resJob = await jobRegistry.getJob(resIssue.payload.data.job.id);
      assert.equal(resJob.operation, 'ssl.issue');
      assert.equal(resJob.payload.email, 'reseller-a@site-a.test');

      // 5. Cross-tenant isolation: Customer B attempting to issue certificate on Website A's domain -> 403 Forbidden
      currentAuthContext = customerBAuth;
      const crossDenied = await requestJson(`${baseUrl}/api/domains/${domainA5.id}/certificates/issue`, {
        method: 'POST',
        body: { email: 'customer-b@site-b.test', staging: true },
      });
      assert.equal(crossDenied.response.status, 403);
      assert.equal(crossDenied.payload.error.code, 'site_scope_forbidden');

      // 6. Read-only user attempt -> 403 Forbidden
      currentAuthContext = readOnlyAuth;
      const readOnlyDenied = await requestJson(`${baseUrl}/api/domains/${domainA5.id}/certificates/issue`, {
        method: 'POST',
        body: { email: 'reader@example.test', staging: true },
      });
      assert.equal(readOnlyDenied.response.status, 403);
      assert.equal(readOnlyDenied.payload.error.code, 'forbidden');

      // 7. Unauthenticated request -> 401 Unauthorized
      currentAuthContext = null;
      const unauthDenied = await requestJson(`${baseUrl}/api/domains/${domainA5.id}/certificates/issue`, {
        method: 'POST',
        body: { email: 'anon@example.test', staging: true },
      });
      assert.equal(unauthDenied.response.status, 401);
      assert.equal(unauthDenied.payload.error.code, 'unauthorized');

      // 8. Missing email in payload -> 400 invalid_acme_email (no silent global fallback)
      currentAuthContext = ownerAuth;
      const missingEmail = await requestJson(`${baseUrl}/api/domains/${domainA5.id}/certificates/issue`, {
        method: 'POST',
        body: { staging: true },
      });
      assert.equal(missingEmail.response.status, 400);
      assert.equal(missingEmail.payload.error.code, 'invalid_acme_email');

      // 9. Malformed email in payload -> 400 invalid_acme_email
      const malformedEmail = await requestJson(`${baseUrl}/api/domains/${domainA5.id}/certificates/issue`, {
        method: 'POST',
        body: { email: 'invalid-address@', staging: true },
      });
      assert.equal(malformedEmail.response.status, 400);
      assert.equal(malformedEmail.payload.error.code, 'invalid_acme_email');

      // 10. User-edited valid email is preserved in payload and job
      const customEmailIssue = await requestJson(`${baseUrl}/api/domains/${domainA5.id}/certificates/issue`, {
        method: 'POST',
        body: { email: 'custom.ssl@company.org', staging: true },
      });
      assert.equal(customEmailIssue.response.status, 202);
      assert.equal(customEmailIssue.payload.data.certificate.email, 'custom.ssl@company.org');
      const customJob = await jobRegistry.getJob(customEmailIssue.payload.data.job.id);
      assert.equal(customJob.payload.email, 'custom.ssl@company.org');
    });
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});
