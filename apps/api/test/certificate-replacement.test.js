import assert from 'node:assert/strict';
import test from 'node:test';
import { createCertificateRegistry, CertificateRegistryError } from '../src/certificate-registry.js';
import { createDomainRegistry, DomainRegistryError } from '../src/domain-registry.js';

function result(certName, domains) {
  return {
    certName,
    domains,
    certificatePath: `/etc/letsencrypt/live/${certName}/cert.pem`,
    fullchainPath: `/etc/letsencrypt/live/${certName}/fullchain.pem`,
    privateKeyPath: `/etc/letsencrypt/live/${certName}/privkey.pem`,
    validFrom: '2026-09-01T00:00:00.000Z',
    validTo: '2026-12-01T00:00:00.000Z',
    fingerprint256: Array.from({ length: 32 }, () => 'AB').join(':'),
  };
}

test('managed certificate replacement supersedes the detached active record only after success', async () => {
  const registry = createCertificateRegistry();
  const first = await registry.createForDomain({
    domainId: 'domain-1', serverId: 'server-1', domains: ['old.example.com'], email: 'ops@example.com',
  });
  await registry.markActive(first.id, result(first.certName, first.domains));

  await assert.rejects(
    registry.createForDomain({
      domainId: 'domain-1', serverId: 'server-1', domains: ['new.example.com'], email: 'ops@example.com',
    }),
    (error) => error instanceof CertificateRegistryError && error.code === 'certificate_exists',
  );
  const replacement = await registry.createForDomain({
    domainId: 'domain-1', serverId: 'server-1', domains: ['new.example.com'], email: 'ops@example.com', replaceExisting: true,
  });
  assert.equal((await registry.getCertificate(first.id)).state, 'active');
  await registry.markActive(replacement.id, result(replacement.certName, replacement.domains));
  assert.equal((await registry.getCertificate(first.id)).state, 'active');
  await registry.commitSelection(replacement.id);
  assert.equal((await registry.getCertificate(first.id)).state, 'superseded');
  assert.equal((await registry.getCertificate(replacement.id)).state, 'active');
});

test('certificate attachment rejects a hostname set that drifted during issuance', async () => {
  const registry = createDomainRegistry();
  const domain = await registry.createDomain({
    serverId: 'local', primaryDomain: 'current.example.com', aliases: ['www.current.example.com'],
    targetType: 'proxy', target: { upstreamPort: 4301 }, httpsMode: 'managed',
  });
  await assert.rejects(
    registry.attachCertificate(domain.id, 'certificate-1', { domains: ['stale.example.com'] }),
    (error) => error instanceof DomainRegistryError && error.code === 'certificate_domain_mismatch',
  );
  assert.equal((await registry.getDomain(domain.id)).certificateId, null);
});
