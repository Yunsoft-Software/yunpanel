import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApp } from '../src/app.js';
import { createCertificateRegistry } from '../src/certificate-registry.js';
import { createDnsHostingRegistry } from '../src/dns-hosting-registry.js';
import { createDnsProviderCredentialRegistry } from '../src/dns-provider-credential-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { reconcileCompletedJob } from '../src/job-reconciliation.js';
import { createServerRegistry } from '../src/server-registry.js';
import { withPanelContext } from './helpers/panel-auth-fixture.js';

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function requestJson(url, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { response, payload: response.status === 204 ? null : await response.json() };
}

test('local Owner issues and renews a wildcard certificate through encrypted Cloudflare DNS-01 intent', async () => {
  const registry = createServerRegistry();
  const enrollment = await registry.issueEnrollmentToken({ label: 'dns-certificate-host' });
  const enrolled = await registry.enrollServer({ token: enrollment.token, hostname: 'dns-certificate-host' });
  const domainRegistry = createDomainRegistry({
    serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
  });
  const domain = await domainRegistry.createDomain({
    serverId: enrolled.server.id,
    primaryDomain: 'example.com',
    aliases: ['www.example.com'],
    targetType: 'proxy',
    target: { upstreamPort: 4302 },
    httpsMode: 'managed',
  });
  const dnsHostingRegistry = createDnsHostingRegistry({
    getWebDomain: async (domainId) => domainRegistry.getDomain(domainId),
  });
  const zone = await dnsHostingRegistry.createZone({
    zoneName: 'example.com', webDomainId: domain.id, managementMode: 'external',
  });
  const providerToken = 'cloudflare_dns_issue_private_token_1234';
  const dnsProviderCredentialRegistry = createDnsProviderCredentialRegistry({
    masterKey: randomBytes(32),
    getDnsZone: async (dnsZoneId) => dnsHostingRegistry.getZone(dnsZoneId),
  });
  const credential = await dnsProviderCredentialRegistry.setCredential({
    dnsZoneId: zone.id, provider: 'cloudflare', token: providerToken,
  });
  const certificateRegistry = createCertificateRegistry();
  const jobRegistry = createJobRegistry();
  const app = withPanelContext(createApp({
    environment: 'production',
    registry,
    domainRegistry,
    dnsHostingRegistry,
    dnsProviderCredentialRegistry,
    certificateRegistry,
    jobRegistry,
    localServerId: enrolled.server.id,
  }));

  await withServer(app, async (baseUrl) => {
    const invalid = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/issue`, {
      method: 'POST',
      body: {
        email: 'owner@example.com',
        staging: 'false',
        challenge: { type: 'dns-01', dnsZoneId: zone.id, wildcard: true },
      },
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.payload.error.code, 'invalid_certificate_request');

    const issued = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/issue`, {
      method: 'POST',
      body: {
        email: 'owner@example.com',
        staging: false,
        challenge: { type: 'dns-01', dnsZoneId: zone.id, wildcard: true },
      },
    });
    assert.equal(issued.response.status, 202);
    const certificate = issued.payload.data.certificate;
    assert.deepEqual(certificate.domains, ['example.com', 'www.example.com']);
    assert.deepEqual(certificate.certificateNames, ['example.com', '*.example.com']);
    assert.equal(certificate.challenge.credentialId, credential.id);
    assert.doesNotMatch(JSON.stringify(issued.payload), new RegExp(providerToken));

    const issueClaim = await jobRegistry.claimNext(enrolled.server.id);
    assert.equal(issueClaim.envelope.operation, OPERATIONS.SSL_ISSUE);
    assert.deepEqual(issueClaim.envelope.payload.domains, ['example.com', '*.example.com']);
    assert.deepEqual(issueClaim.envelope.payload.challenge, certificate.challenge);
    assert.doesNotMatch(JSON.stringify(issueClaim), new RegExp(providerToken));

    const result = {
      certName: 'example.com',
      domains: ['example.com', '*.example.com'],
      certificatePath: '/etc/letsencrypt/live/example.com/cert.pem',
      fullchainPath: '/etc/letsencrypt/live/example.com/fullchain.pem',
      privateKeyPath: '/etc/letsencrypt/live/example.com/privkey.pem',
      subject: 'CN=example.com',
      issuer: 'CN=Test ACME CA',
      subjectAltName: 'DNS:example.com, DNS:*.example.com',
      validFrom: '2026-09-11T00:00:00.000Z',
      validTo: '2026-12-11T00:00:00.000Z',
      fingerprint256: Array.from({ length: 32 }, () => 'AB').join(':'),
      staging: false,
      status: 'issued',
    };
    const completed = await jobRegistry.complete({
      serverId: enrolled.server.id, jobId: issueClaim.job.id, status: 'succeeded', result,
    });
    await reconcileCompletedJob({ domainRegistry, certificateRegistry, job: completed });
    assert.equal((await domainRegistry.getDomain(domain.id)).certificateId, certificate.id);

    const invalidRenewal = await requestJson(`${baseUrl}/api/certificates/${certificate.id}/renew`, {
      method: 'POST', body: { dryRun: 'true' },
    });
    assert.equal(invalidRenewal.response.status, 400);
    assert.equal(invalidRenewal.payload.error.code, 'invalid_certificate_renewal_request');

    const renewal = await requestJson(`${baseUrl}/api/certificates/${certificate.id}/renew`, {
      method: 'POST', body: { dryRun: true },
    });
    assert.equal(renewal.response.status, 202);
    assert.doesNotMatch(JSON.stringify(renewal.payload), new RegExp(providerToken));
    const renewalClaim = await jobRegistry.claimNext(enrolled.server.id);
    assert.equal(renewalClaim.envelope.operation, OPERATIONS.SSL_RENEW);
    assert.deepEqual(renewalClaim.envelope.payload.challenge, certificate.challenge);
    assert.doesNotMatch(JSON.stringify(renewalClaim), new RegExp(providerToken));
  });
});

test('DNS-01 refuses remote Domains and zones outside the current hostname set', async () => {
  const domainRegistry = createDomainRegistry();
  const domain = await domainRegistry.createDomain({
    serverId: 'remote', primaryDomain: 'app.example.com', aliases: [],
    targetType: 'proxy', target: { upstreamPort: 4302 }, httpsMode: 'managed',
  });
  const dnsHostingRegistry = createDnsHostingRegistry();
  const zone = await dnsHostingRegistry.createZone({ zoneName: 'other.test', managementMode: 'external' });
  const dnsProviderCredentialRegistry = createDnsProviderCredentialRegistry({
    masterKey: randomBytes(32), getDnsZone: async (id) => dnsHostingRegistry.getZone(id),
  });
  await dnsProviderCredentialRegistry.setCredential({
    dnsZoneId: zone.id, provider: 'cloudflare', token: 'cloudflare_dns_issue_private_token_1234',
  });
  const app = withPanelContext(createApp({
    environment: 'production', domainRegistry, dnsHostingRegistry, dnsProviderCredentialRegistry,
    certificateRegistry: createCertificateRegistry(), jobRegistry: createJobRegistry(), localServerId: 'local',
  }));
  await withServer(app, async (baseUrl) => {
    const response = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/issue`, {
      method: 'POST',
      body: {
        email: 'owner@example.com', staging: true,
        challenge: { type: 'dns-01', dnsZoneId: zone.id, wildcard: true },
      },
    });
    assert.equal(response.response.status, 404);
    assert.equal(response.payload.error.code, 'domain_not_found');
  });
});
