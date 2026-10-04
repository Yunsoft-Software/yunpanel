import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApp } from '../src/app.js';
import { createCertificateRegistry } from '../src/certificate-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
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
