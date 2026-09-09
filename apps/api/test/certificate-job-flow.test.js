import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApp } from '../src/app.js';
import { createCertificateRegistry } from '../src/certificate-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { withPanelContext } from './helpers/panel-auth-fixture.js';

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
  return { response, payload: response.status === 204 ? null : await response.json() };
}

function productionCertificateResult(certName, domains, overrides = {}) {
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
    staging: false,
    status: 'issued',
    ...overrides,
  };
}

async function createTestContext(hostname) {
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: hostname });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname });
  const domainRegistry = createDomainRegistry({
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  const jobRegistry = createJobRegistry();
  const certificateRegistry = createCertificateRegistry();
  return { serverRegistry, enrolled, domainRegistry, jobRegistry, certificateRegistry };
}

async function activateHttpDomain(domainRegistry, domain) {
  const checksum = 'a'.repeat(64);
  await domainRegistry.markStaged(domain.id, {
    checksum,
    configName: `yunpanel-${domain.primaryDomain}.conf`,
  });
  await domainRegistry.markApplied(domain.id, { checksum });
}

test('ACME dry-run validation stores no certificate files and does not block production issuance', async () => {
  const context = await createTestContext('validation-host');
  const { serverRegistry, enrolled, domainRegistry, jobRegistry, certificateRegistry } = context;
  const app = withPanelContext(createApp({
    environment: 'production',
    registry: serverRegistry,
    domainRegistry,
    jobRegistry,
    certificateRegistry,
  }));

  const domain = await domainRegistry.createDomain({
    serverId: enrolled.server.id,
    primaryDomain: 'validate.example.com',
    aliases: ['www.validate.example.com'],
    targetType: 'proxy',
    target: { upstreamPort: 3200 },
    httpsMode: 'managed',
  });
  await activateHttpDomain(domainRegistry, domain);

  await withServer(app, async (baseUrl) => {
    const validation = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/issue`, {
      method: 'POST',
      body: { email: 'Admin@Example.com', staging: true },
    });
    assert.equal(validation.response.status, 202);
    const validationRecord = validation.payload.data.certificate;
    assert.equal(validationRecord.state, 'validating');
    assert.equal(validationRecord.staging, true);

    const claim = await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/next`, {
      token: enrolled.agentToken,
    });
    assert.equal(claim.payload.data.envelope.operation, OPERATIONS.SSL_ISSUE);
    assert.equal(claim.payload.data.envelope.payload.staging, true);

    const completed = await requestJson(
      `${baseUrl}/api/servers/${enrolled.server.id}/commands/${claim.payload.data.job.id}/result`,
      {
        method: 'POST',
        token: enrolled.agentToken,
        body: {
          status: 'succeeded',
          result: {
            certName: validationRecord.certName,
            domains: validationRecord.domains,
            staging: true,
            status: 'validated',
          },
        },
      },
    );
    assert.equal(completed.response.status, 200);

    const validated = await certificateRegistry.getCertificate(validationRecord.id);
    assert.equal(validated.state, 'validated');
    assert.equal(validated.certificatePath, null);
    assert.equal(validated.privateKeyPath, null);
    assert.ok(validated.lastValidatedAt);
    assert.equal((await domainRegistry.getDomain(domain.id)).certificateId, null);

    const production = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/issue`, {
      method: 'POST',
      body: { email: 'admin@example.com', staging: false },
    });
    assert.equal(production.response.status, 202);
    assert.equal(production.payload.data.certificate.state, 'issuing');
    assert.equal(production.payload.data.certificate.staging, false);
  });
});

test('production certificate attaches to HTTPS desired state and supports renewal', async () => {
  const context = await createTestContext('production-cert-host');
  const { serverRegistry, enrolled, domainRegistry, jobRegistry, certificateRegistry } = context;
  const app = withPanelContext(createApp({
    environment: 'production',
    registry: serverRegistry,
    domainRegistry,
    jobRegistry,
    certificateRegistry,
  }));

  const domain = await domainRegistry.createDomain({
    serverId: enrolled.server.id,
    primaryDomain: 'prod.example.com',
    aliases: [],
    targetType: 'static',
    target: { root: '/var/lib/yunpanel/apps/prod/current' },
    httpsMode: 'managed',
  });
  await activateHttpDomain(domainRegistry, domain);

  await withServer(app, async (baseUrl) => {
    const issued = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/issue`, {
      method: 'POST',
      body: { email: 'admin@example.com', staging: false },
    });
    assert.equal(issued.response.status, 202);
    const certificate = issued.payload.data.certificate;

    const issueClaim = await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/next`, {
      token: enrolled.agentToken,
    });
    await requestJson(
      `${baseUrl}/api/servers/${enrolled.server.id}/commands/${issueClaim.payload.data.job.id}/result`,
      {
        method: 'POST',
        token: enrolled.agentToken,
        body: {
          status: 'succeeded',
          result: productionCertificateResult(certificate.certName, certificate.domains),
        },
      },
    );

    const activeCertificate = await certificateRegistry.getCertificate(certificate.id);
    assert.equal(activeCertificate.state, 'active');
    assert.ok(activeCertificate.lastIssuedAt);

    const attachedDomain = await domainRegistry.getDomain(domain.id);
    assert.equal(attachedDomain.certificateId, certificate.id);
    assert.equal(attachedDomain.desiredRevision, 2);
    assert.equal(attachedDomain.appliedRevision, 1);
    assert.equal(attachedDomain.state, 'draft');

    const dryRun = await requestJson(`${baseUrl}/api/certificates/${certificate.id}/renew`, {
      method: 'POST',
      body: { dryRun: true },
    });
    assert.equal(dryRun.response.status, 202);

    const dryRunClaim = await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/next`, {
      token: enrolled.agentToken,
    });
    await requestJson(
      `${baseUrl}/api/servers/${enrolled.server.id}/commands/${dryRunClaim.payload.data.job.id}/result`,
      {
        method: 'POST',
        token: enrolled.agentToken,
        body: {
          status: 'succeeded',
          result: { certName: certificate.certName, dryRun: true, status: 'validated' },
        },
      },
    );
    assert.equal((await certificateRegistry.getCertificate(certificate.id)).state, 'active');

    const renewal = await requestJson(`${baseUrl}/api/certificates/${certificate.id}/renew`, {
      method: 'POST',
      body: { dryRun: false },
    });
    assert.equal(renewal.response.status, 202);
    assert.equal((await certificateRegistry.getCertificate(certificate.id)).state, 'renewing');

    const renewalClaim = await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/next`, {
      token: enrolled.agentToken,
    });
    const renewedResult = productionCertificateResult(certificate.certName, certificate.domains, {
      validFrom: '2026-10-01T00:00:00.000Z',
      validTo: '2026-12-30T00:00:00.000Z',
      dryRun: false,
      status: 'renewed',
    });
    await requestJson(
      `${baseUrl}/api/servers/${enrolled.server.id}/commands/${renewalClaim.payload.data.job.id}/result`,
      {
        method: 'POST',
        token: enrolled.agentToken,
        body: { status: 'succeeded', result: renewedResult },
      },
    );

    const renewedCertificate = await certificateRegistry.getCertificate(certificate.id);
    assert.equal(renewedCertificate.state, 'active');
    assert.equal(renewedCertificate.validTo, '2026-12-30T00:00:00.000Z');
    assert.ok(renewedCertificate.lastRenewedAt);

    const stage = await requestJson(`${baseUrl}/api/domains/${domain.id}/stage`, {
      method: 'POST',
    });
    assert.equal(stage.response.status, 202);
    const stageClaim = await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/next`, {
      token: enrolled.agentToken,
    });
    assert.deepEqual(stageClaim.payload.data.envelope.payload.tls, {
      fullchainPath: '/etc/letsencrypt/live/prod.example.com/fullchain.pem',
      privateKeyPath: '/etc/letsencrypt/live/prod.example.com/privkey.pem',
    });
  });
});
