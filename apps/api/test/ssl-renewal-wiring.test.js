import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApp } from '../src/app.js';
import { createCertificateRegistry } from '../src/certificate-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createWebsiteRegistry } from '../src/website-registry.js';
import { startCertificateRenewalScheduler } from '../src/certificate-renewal-scheduler.js';
import { withPanelContext, ownerManagementContext, readOnlyManagementContext } from './helpers/panel-auth-fixture.js';

// Execute the web workspace renewal-wiring test suite
import '../../web/test/ssl-renewal-wiring.test.js';

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

test('Backend renewal wiring: routes are mounted and protected by panel guard', async () => {
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'wiring-host' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'wiring-host' });
  const domainRegistry = createDomainRegistry({
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  const certificateRegistry = createCertificateRegistry();
  const jobRegistry = createJobRegistry();
  const localServerId = enrolled.server.id;

  const domain = await domainRegistry.createDomain({
    serverId: localServerId,
    primaryDomain: 'wiring.example.com',
    aliases: [],
    targetType: 'proxy',
    target: { upstreamPort: 3000 },
    httpsMode: 'managed',
  });

  const cert = await certificateRegistry.createForDomain({
    domainId: domain.id,
    serverId: localServerId,
    domains: ['wiring.example.com'],
    email: 'admin@wiring.example.com',
  });

  await certificateRegistry.markActive(cert.id, {
    certName: 'wiring.example.com',
    certificatePath: '/etc/letsencrypt/live/wiring.example.com/cert.pem',
    fullchainPath: '/etc/letsencrypt/live/wiring.example.com/fullchain.pem',
    privateKeyPath: '/etc/letsencrypt/live/wiring.example.com/privkey.pem',
    validFrom: '2026-09-01T00:00:00.000Z',
    validTo: '2026-12-01T00:00:00.000Z',
    fingerprint256: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
  });

  // 1. Unauthenticated app rejects renewal
  const rawApp = createApp({
    environment: 'production',
    domainRegistry,
    certificateRegistry,
    jobRegistry,
    localServerId,
  });

  await withServer(rawApp, async (baseUrl) => {
    const unauthRenew = await requestJson(`${baseUrl}/api/certificates/${cert.id}/renew`, {
      method: 'POST',
      body: { dryRun: true },
    });
    assert.equal(unauthRenew.response.status, 401);
  });

  // 2. Read-only context rejects renewal mutation
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
      body: { dryRun: true },
    });
    assert.equal(readerRenew.response.status, 403);
  });

  // 3. Owner context can renew and check outcome
  const ownerApp = withPanelContext(createApp({
    environment: 'production',
    domainRegistry,
    certificateRegistry,
    jobRegistry,
    localServerId,
  }), ownerManagementContext);

  await withServer(ownerApp, async (baseUrl) => {
    // Renew dry-run
    const renewRes = await requestJson(`${baseUrl}/api/certificates/${cert.id}/renew`, {
      method: 'POST',
      body: { dryRun: true },
    });
    assert.equal(renewRes.response.status, 202);
    assert.equal(renewRes.payload.data.operation, OPERATIONS.SSL_RENEW);
    assert.equal(renewRes.payload.data.resourceId, cert.id);

    // GET renewal outcome is read-only and does not dispatch another job
    const jobsBefore = await jobRegistry.listJobs({ resourceType: 'certificate', resourceId: cert.id });
    const outcomeRes = await requestJson(`${baseUrl}/api/certificates/${cert.id}/renewal-outcome`);
    assert.equal(outcomeRes.response.status, 200);
    assert.equal(outcomeRes.payload.data.outcome, 'waiting');
    const jobsAfter = await jobRegistry.listJobs({ resourceType: 'certificate', resourceId: cert.id });
    assert.equal(jobsAfter.length, jobsBefore.length);

    // Domain-scoped GET renewal outcome is also wired
    const domainOutcomeRes = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/${cert.id}/renewal-outcome`);
    assert.equal(domainOutcomeRes.response.status, 200);
    assert.equal(domainOutcomeRes.payload.data.outcome, 'waiting');
  });
});

test('Backend renewal wiring: startCertificateRenewalScheduler handles initialization and shutdown', () => {
  const certificateRegistry = createCertificateRegistry();
  const jobRegistry = createJobRegistry();

  const scheduler = startCertificateRenewalScheduler({
    certificateRegistry,
    jobRegistry,
    intervalMs: 10 * 60 * 1000,
    renewBeforeMs: 30 * 24 * 60 * 60 * 1000,
  });

  assert.equal(typeof scheduler.sweepNow, 'function');
  assert.equal(typeof scheduler.stop, 'function');

  // Calling stop cancels timer cleanly
  scheduler.stop();
});

test('TLS-01 tenant isolation: certificate renew, renewal-outcome, reload-outcome, verify-tls, and detail routes reject foreign or unassigned tenants while allowing assigned tenant and Owner', async () => {
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'tls01-host' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'tls01-host' });
  const localServerId = enrolled.server.id;

  const websiteRegistry = createWebsiteRegistry({
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  const websiteA = await websiteRegistry.createWebsite({
    serverId: localServerId,
    name: 'TenantASite',
    runtimeType: 'proxy',
  });
  const websiteB = await websiteRegistry.createWebsite({
    serverId: localServerId,
    name: 'TenantBSite',
    runtimeType: 'proxy',
  });

  const domainRegistry = createDomainRegistry({
    getWebsite: async (id) => websiteRegistry.getWebsite(id),
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  const certificateRegistry = createCertificateRegistry();
  const jobRegistry = createJobRegistry();

  const domainA = await domainRegistry.createDomain({
    serverId: localServerId,
    websiteId: websiteA.id,
    primaryDomain: 'ttls01-a2.webrich.news',
    aliases: [],
    targetType: 'proxy',
    target: { upstreamPort: 3001 },
    httpsMode: 'managed',
  });

  const certA = await certificateRegistry.createForDomain({
    domainId: domainA.id,
    serverId: localServerId,
    domains: ['ttls01-a2.webrich.news'],
    email: 'owner@webrich.news',
  });

  const fingerprintA = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
  await certificateRegistry.markActive(certA.id, {
    certName: 'ttls01-a2.webrich.news',
    certificatePath: '/etc/letsencrypt/live/ttls01-a2.webrich.news/cert.pem',
    fullchainPath: '/etc/letsencrypt/live/ttls01-a2.webrich.news/fullchain.pem',
    privateKeyPath: '/etc/letsencrypt/live/ttls01-a2.webrich.news/privkey.pem',
    validFrom: '2026-09-01T00:00:00.000Z',
    validTo: '2026-12-01T00:00:00.000Z',
    fingerprint256: fingerprintA,
  });
  await domainRegistry.attachCertificate(domainA.id, certA.id, { domains: ['ttls01-a2.webrich.news'] });

  let currentContext = ownerManagementContext;
  const app = withPanelContext(createApp({
    environment: 'production',
    registry: serverRegistry,
    websiteRegistry,
    domainRegistry,
    certificateRegistry,
    jobRegistry,
    localServerId,
  }), () => currentContext);

  const emptyCustomerContext = {
    user: {
      id: 'ttls01-a2-cust',
      username: 'ttls01-a2-cust',
      role: 'customer',
      hosting: { kind: 'customer', resellerId: null },
      websiteIds: [],
    },
    security: { managementAllowed: true },
    access: { mode: 'site_management' },
  };

  const foreignCustomerContext = {
    user: {
      id: 'cust-b',
      username: 'cust-b',
      role: 'customer',
      hosting: { kind: 'customer', resellerId: null },
      websiteIds: [websiteB.id],
    },
    security: { managementAllowed: true },
    access: { mode: 'site_management' },
  };

  const foreignResellerContext = {
    user: {
      id: 'reseller-b',
      username: 'reseller-b',
      role: 'reseller',
      hosting: { kind: 'reseller', resellerId: null },
      websiteIds: [websiteB.id],
    },
    security: { managementAllowed: true },
    access: { mode: 'site_management' },
  };

  const assignedCustomerContext = {
    user: {
      id: 'cust-a',
      username: 'cust-a',
      role: 'customer',
      hosting: { kind: 'customer', resellerId: null },
      websiteIds: [websiteA.id],
    },
    security: { managementAllowed: true },
    access: { mode: 'site_management' },
  };

  await withServer(app, async (baseUrl) => {
    // 1. Customer with no websites (ttls01-a2-cust) and foreign Customer/Reseller must be rejected (403)
    for (const unauthorizedCtx of [emptyCustomerContext, foreignCustomerContext, foreignResellerContext]) {
      currentContext = unauthorizedCtx;

      const renewDenied = await requestJson(`${baseUrl}/api/certificates/${certA.id}/renew`, {
        method: 'POST',
        body: { dryRun: true },
      });
      assert.equal(renewDenied.response.status, 403);

      const getCertDenied = await requestJson(`${baseUrl}/api/certificates/${certA.id}`);
      assert.equal(getCertDenied.response.status, 403);

      const outcomeGetDenied = await requestJson(`${baseUrl}/api/certificates/${certA.id}/renewal-outcome`);
      assert.equal(outcomeGetDenied.response.status, 403);

      const outcomePostDenied = await requestJson(`${baseUrl}/api/certificates/${certA.id}/renewal-outcome`, {
        method: 'POST',
        body: { jobId: '00000000-0000-4000-8000-000000000001' },
      });
      assert.equal(outcomePostDenied.response.status, 403);

      const reloadPostDenied = await requestJson(`${baseUrl}/api/certificates/${certA.id}/reload-outcome`, {
        method: 'POST',
        body: { service: 'nginx', status: 'partial', error: 'unauthorized write attempt' },
      });
      assert.equal(reloadPostDenied.response.status, 403);

      const reloadGetDenied = await requestJson(`${baseUrl}/api/certificates/${certA.id}/reload-outcome`);
      assert.equal(reloadGetDenied.response.status, 403);

      const verifyGetDenied = await requestJson(`${baseUrl}/api/certificates/${certA.id}/verify-tls`);
      assert.equal(verifyGetDenied.response.status, 403);

      const verifyPostDenied = await requestJson(`${baseUrl}/api/certificates/${certA.id}/verify-tls`, {
        method: 'POST',
        body: {
          liveTls: {
            validFrom: '2026-09-01T00:00:00.000Z',
            validTo: '2026-12-01T00:00:00.000Z',
            fingerprint256: fingerprintA,
          },
        },
      });
      assert.equal(verifyPostDenied.response.status, 403);

      const listCerts = await requestJson(`${baseUrl}/api/certificates`);
      assert.equal(listCerts.response.status, 200);
      assert.deepEqual(listCerts.payload.data, []);
    }

    // Verify no renewal jobs were enqueued by unauthorized requests and reload outcome was not mutated
    const jobsAfterUnauthorized = await jobRegistry.listJobs({ resourceType: 'certificate', resourceId: certA.id });
    assert.equal(jobsAfterUnauthorized.length, 0);
    const certRecordAfterUnauthorized = await certificateRegistry.getCertificate(certA.id);
    assert.equal(certRecordAfterUnauthorized.lastReloadOutcome, null);

    // 2. Assigned customer (cust-a) who owns websiteA CAN access and dry-run renew their certificate
    currentContext = assignedCustomerContext;
    const assignedGet = await requestJson(`${baseUrl}/api/certificates/${certA.id}`);
    assert.equal(assignedGet.response.status, 200);
    assert.equal(assignedGet.payload.data.id, certA.id);

    const assignedRenew = await requestJson(`${baseUrl}/api/certificates/${certA.id}/renew`, {
      method: 'POST',
      body: { dryRun: true },
    });
    assert.equal(assignedRenew.response.status, 202);
    const jobId = assignedRenew.payload.data.id;

    const assignedOutcome = await requestJson(`${baseUrl}/api/certificates/${certA.id}/renewal-outcome?jobId=${jobId}`);
    assert.equal(assignedOutcome.response.status, 200);
    assert.equal(assignedOutcome.payload.data.outcome, 'waiting');

    // 3. Even with a known jobId, emptyCustomerContext still cannot read renewal-outcome
    currentContext = emptyCustomerContext;
    const leakedJobOutcomeDenied = await requestJson(`${baseUrl}/api/certificates/${certA.id}/renewal-outcome?jobId=${jobId}`);
    assert.equal(leakedJobOutcomeDenied.response.status, 403);
  });
});
