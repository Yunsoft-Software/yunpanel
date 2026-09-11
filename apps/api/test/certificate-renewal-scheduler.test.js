import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createCertificateRegistry } from '../src/certificate-registry.js';
import { runCertificateRenewalSweep } from '../src/certificate-renewal-scheduler.js';
import { createJobRegistry } from '../src/job-registry.js';

function metadata(certName, validTo) {
  return {
    certName,
    certificatePath: `/etc/letsencrypt/live/${certName}/cert.pem`,
    fullchainPath: `/etc/letsencrypt/live/${certName}/fullchain.pem`,
    privateKeyPath: `/etc/letsencrypt/live/${certName}/privkey.pem`,
    subject: `CN=${certName}`,
    issuer: 'CN=Test CA',
    subjectAltName: `DNS:${certName}`,
    validFrom: '2026-08-01T00:00:00.000Z',
    validTo,
    fingerprint256: Array.from({ length: 32 }, () => 'AB').join(':'),
  };
}

async function activeCertificate(registry, {
  domainId,
  serverId,
  certName,
  validTo,
  staging = false,
  certificateNames = [certName],
  challenge,
}) {
  const certificate = await registry.createForDomain({
    domainId,
    serverId,
    domains: [certName],
    certificateNames,
    challenge,
    email: 'admin@example.com',
    staging,
  });
  if (staging) {
    await registry.markValidated(certificate.id, {
      certName,
      domains: [certName],
      status: 'validated',
      staging: true,
    });
  } else {
    await registry.markActive(certificate.id, metadata(certName, validTo));
  }
  return registry.getCertificate(certificate.id);
}

test('renewal sweep queues only expiring production certificates and avoids duplicates', async () => {
  const nowMs = Date.parse('2026-09-08T21:00:00.000Z');
  const certificates = createCertificateRegistry({ now: () => nowMs });
  const jobs = createJobRegistry({ now: () => nowMs });

  const expiring = await activeCertificate(certificates, {
    domainId: 'domain-expiring',
    serverId: 'server-1',
    certName: 'expiring.example.com',
    validTo: '2026-09-20T00:00:00.000Z',
  });
  await activeCertificate(certificates, {
    domainId: 'domain-future',
    serverId: 'server-1',
    certName: 'future.example.com',
    validTo: '2026-12-31T00:00:00.000Z',
  });
  await activeCertificate(certificates, {
    domainId: 'domain-staging',
    serverId: 'server-1',
    certName: 'staging.example.com',
    validTo: '2026-09-15T00:00:00.000Z',
    staging: true,
  });

  const queued = await runCertificateRenewalSweep({
    certificateRegistry: certificates,
    jobRegistry: jobs,
    now: () => nowMs,
  });

  assert.equal(queued.length, 1);
  assert.equal(queued[0].operation, OPERATIONS.SSL_RENEW);
  assert.equal(queued[0].resourceId, expiring.id);
  assert.equal(queued[0].status, 'queued');
  assert.equal((await certificates.getCertificate(expiring.id)).state, 'renewing');

  await certificates.setState(expiring.id, 'active');
  const secondSweep = await runCertificateRenewalSweep({
    certificateRegistry: certificates,
    jobRegistry: jobs,
    now: () => nowMs,
  });
  assert.equal(secondSweep.length, 0);

  const renewalJobs = await jobs.listJobs({ resourceType: 'certificate', resourceId: expiring.id });
  assert.equal(renewalJobs.length, 1);
  assert.deepEqual(renewalJobs[0].operation, OPERATIONS.SSL_RENEW);
});

test('DNS renewal sweep requires the exact configured provider credential', async () => {
  const nowMs = Date.parse('2026-09-08T21:00:00.000Z');
  const certificates = createCertificateRegistry({ now: () => nowMs });
  const jobs = createJobRegistry({ now: () => nowMs });
  const challenge = {
    type: 'dns-01',
    provider: 'cloudflare',
    credentialId: '12345678-1234-4234-8234-123456789012',
    dnsZoneId: '22345678-1234-4234-8234-123456789012',
    propagationSeconds: 30,
  };
  const certificate = await activeCertificate(certificates, {
    domainId: 'domain-dns',
    serverId: 'server-dns',
    certName: 'example.com',
    certificateNames: ['example.com', '*.example.com'],
    challenge,
    validTo: '2026-09-20T00:00:00.000Z',
  });

  assert.deepEqual(await runCertificateRenewalSweep({
    certificateRegistry: certificates,
    jobRegistry: jobs,
    now: () => nowMs,
  }), []);
  assert.equal((await certificates.getCertificate(certificate.id)).state, 'active');

  assert.deepEqual(await runCertificateRenewalSweep({
    certificateRegistry: certificates,
    jobRegistry: jobs,
    dnsProviderCredentialRegistry: {
      getForZone: async () => ({ configured: true, provider: 'cloudflare', id: '32345678-1234-4234-8234-123456789012' }),
    },
    now: () => nowMs,
  }), []);

  const queued = await runCertificateRenewalSweep({
    certificateRegistry: certificates,
    jobRegistry: jobs,
    dnsProviderCredentialRegistry: {
      getForZone: async (dnsZoneId) => ({
        configured: dnsZoneId === challenge.dnsZoneId,
        provider: challenge.provider,
        id: challenge.credentialId,
      }),
    },
    now: () => nowMs,
  });
  assert.equal(queued.length, 1);
  const claimed = await jobs.claimNext(certificate.serverId);
  assert.equal(claimed.envelope.operation, OPERATIONS.SSL_RENEW);
  assert.deepEqual(claimed.envelope.payload.challenge, challenge);
});
