import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApp } from '../src/app.js';
import { createCertificateRegistry } from '../src/certificate-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createServerRegistry } from '../src/server-registry.js';

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function requestJson(url, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    response,
    payload: response.status === 204 ? null : await response.json(),
  };
}

function certificateResult(certName, domains) {
  return {
    certName,
    domains,
    certificatePath: `/etc/letsencrypt/live/${certName}/cert.pem`,
    fullchainPath: `/etc/letsencrypt/live/${certName}/fullchain.pem`,
    privateKeyPath: `/etc/letsencrypt/live/${certName}/privkey.pem`,
    subject: `CN=${certName}`,
    issuer: 'CN=Test ACME CA',
    subjectAltName: domains.map((domain) => `DNS:${domain}`).join(', '),
    validFrom: '2026-09-08T20:00:00.000Z',
    validTo: '2026-12-07T20:00:00.000Z',
    fingerprint256: Array.from({ length: 32 }, () => 'AA').join(':'),
    staging: true,
  };
}

test('certificate issuance requires active HTTP domain and reconciles agent metadata', async () => {
  const adminToken = 'certificate-admin-token';
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'cert-test' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'cert-host' });

  const domainRegistry = createDomainRegistry({
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  const jobRegistry = createJobRegistry();
  const certificateRegistry = createCertificateRegistry();
  const app = createApp({
    environment: 'production',
    registry: serverRegistry,
    domainRegistry,
    jobRegistry,
    certificateRegistry,
    adminToken,
  });

  const domain = await domainRegistry.createDomain({
    serverId: enrolled.server.id,
    primaryDomain: 'secure.example.com',
    aliases: ['www.secure.example.com'],
    targetType: 'proxy',
    target: { upstreamPort: 3200 },
    httpsMode: 'managed',
  });

  await withServer(app, async (baseUrl) => {
    const tooEarly = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/issue`, {
      method: 'POST',
      token: adminToken,
      body: { email: 'admin@example.com', staging: true },
    });
    assert.equal(tooEarly.response.status, 409);
    assert.equal(tooEarly.payload.error.code, 'http_domain_not_active');

    await domainRegistry.markStaged(domain.id, {
      checksum: 'a'.repeat(64),
      configName: 'secure.example.com.conf',
    });
    await domainRegistry.markApplied(domain.id, { checksum: 'a'.repeat(64) });

    const issued = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/issue`, {
      method: 'POST',
      token: adminToken,
      body: { email: 'Admin@Example.com', staging: true },
    });
    assert.equal(issued.response.status, 202);
    const certificate = issued.payload.data.certificate;
    assert.equal(certificate.state, 'issuing');
    assert.equal(certificate.email, 'admin@example.com');
    assert.deepEqual(certificate.domains, ['secure.example.com', 'www.secure.example.com']);
    assert.equal(issued.payload.data.job.operation, OPERATIONS.SSL_ISSUE);

    const claimed = await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/next`, {
      token: enrolled.agentToken,
    });
    assert.equal(claimed.response.status, 200);
    assert.equal(claimed.payload.data.envelope.operation, OPERATIONS.SSL_ISSUE);

    const agentResult = certificateResult(certificate.certName, certificate.domains);
    const completed = await requestJson(
      `${baseUrl}/api/servers/${enrolled.server.id}/commands/${claimed.payload.data.job.id}/result`,
      {
        method: 'POST',
        token: enrolled.agentToken,
        body: { status: 'succeeded', result: agentResult },
      },
    );
    assert.equal(completed.response.status, 200);

    const active = await requestJson(`${baseUrl}/api/certificates/${certificate.id}`, { token: adminToken });
    assert.equal(active.payload.data.state, 'active');
    assert.equal(active.payload.data.certName, 'secure.example.com');
    assert.equal(active.payload.data.privateKeyPath, '/etc/letsencrypt/live/secure.example.com/privkey.pem');
    assert.equal(active.payload.data.lastError, null);

    const dryRun = await requestJson(`${baseUrl}/api/certificates/${certificate.id}/renew`, {
      method: 'POST',
      token: adminToken,
      body: { dryRun: true },
    });
    assert.equal(dryRun.response.status, 202);
    assert.equal(dryRun.payload.data.operation, OPERATIONS.SSL_RENEW);

    const claimedDryRun = await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/next`, {
      token: enrolled.agentToken,
    });
    assert.equal(claimedDryRun.payload.data.envelope.payload.dryRun, true);

    await requestJson(
      `${baseUrl}/api/servers/${enrolled.server.id}/commands/${claimedDryRun.payload.data.job.id}/result`,
      {
        method: 'POST',
        token: enrolled.agentToken,
        body: {
          status: 'succeeded',
          result: { certName: certificate.certName, dryRun: true, status: 'validated' },
        },
      },
    );

    const afterDryRun = await certificateRegistry.getCertificate(certificate.id);
    assert.equal(afterDryRun.state, 'active');

    const renewal = await requestJson(`${baseUrl}/api/certificates/${certificate.id}/renew`, {
      method: 'POST',
      token: adminToken,
      body: { dryRun: false },
    });
    assert.equal(renewal.response.status, 202);
    assert.equal((await certificateRegistry.getCertificate(certificate.id)).state, 'renewing');

    const claimedRenewal = await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/next`, {
      token: enrolled.agentToken,
    });
    const renewedResult = {
      ...certificateResult(certificate.certName, certificate.domains),
      validFrom: '2026-10-01T00:00:00.000Z',
      validTo: '2026-12-30T00:00:00.000Z',
      dryRun: false,
      status: 'renewed',
    };

    const renewed = await requestJson(
      `${baseUrl}/api/servers/${enrolled.server.id}/commands/${claimedRenewal.payload.data.job.id}/result`,
      {
        method: 'POST',
        token: enrolled.agentToken,
        body: { status: 'succeeded', result: renewedResult },
      },
    );
    assert.equal(renewed.response.status, 200);

    const finalCertificate = await certificateRegistry.getCertificate(certificate.id);
    assert.equal(finalCertificate.state, 'active');
    assert.equal(finalCertificate.validTo, '2026-12-30T00:00:00.000Z');
    assert.ok(finalCertificate.lastRenewedAt);
  });
});
