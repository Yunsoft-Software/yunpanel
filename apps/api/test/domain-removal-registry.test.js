import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDomainRegistry,
  DomainRegistryError,
  domainRegistryInternals,
} from '../src/domain-registry.js';

const domainId = '12345678-1234-4234-8234-123456789012';
const childId = '22345678-1234-4234-8234-123456789012';
const operationId = '32345678-1234-4234-8234-123456789012';
const websiteId = '42345678-1234-4234-8234-123456789012';
const checksum = 'a'.repeat(64);

async function createSuspendedDomain(registry, {
  id = domainId,
  primaryDomain = 'example.com',
  parentDomainId = null,
  websiteId: boundWebsiteId = null,
  httpsMode = 'off',
  certificateId = null,
} = {}) {
  let domain = await registry.createDomain({
    domainId: id,
    serverId: 'local',
    websiteId: boundWebsiteId,
    primaryDomain,
    parentDomainId,
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: id === childId ? 3301 : 3300 },
    httpsMode,
  });
  if (certificateId) {
    domain = await registry.attachCertificate(domain.id, certificateId);
  }
  await registry.markStaged(domain.id, {
    checksum,
    configName: 'yunpanel-' + primaryDomain + '.conf',
  });
  await registry.markApplied(domain.id, { checksum });
  return registry.markSuspended(domain.id, {
    expectedRevision: domain.desiredRevision,
    checksum,
    operationId,
  });
}

function confirmation(revision = 1) {
  return domainRegistryInternals.removalConfirmation({
    domainId,
    operationId,
    expectedRevision: revision,
    checksum,
  });
}

test('finalizes only exact suspended Domain metadata and leaves registry hierarchy valid', async () => {
  const registry = createDomainRegistry();
  const suspended = await createSuspendedDomain(registry);

  const result = await registry.finalizeDomainRemoval(domainId, {
    operationId,
    expectedRevision: suspended.desiredRevision,
    checksum,
    confirmation: confirmation(suspended.desiredRevision),
  });

  assert.equal(result.removed, true);
  assert.deepEqual(result.domain, {
    id: domainId,
    serverId: 'local',
    primaryDomain: 'example.com',
    parentDomainId: null,
    desiredRevision: suspended.desiredRevision,
    suspensionOperationId: operationId,
    suspendedChecksum: checksum,
  });
  assert.equal(await registry.getDomain(domainId), null);
  assert.deepEqual(await registry.listDomains(), []);
});

test('finalization refuses child Domain dependencies', async () => {
  const registry = createDomainRegistry();
  const suspended = await createSuspendedDomain(registry);
  await registry.createDomain({
    domainId: childId,
    serverId: 'local',
    primaryDomain: 'api.example.com',
    parentDomainId: domainId,
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 3301 },
  });

  await assert.rejects(
    registry.finalizeDomainRemoval(domainId, {
      operationId,
      expectedRevision: suspended.desiredRevision,
      checksum,
      confirmation: confirmation(suspended.desiredRevision),
    }),
    (error) => error instanceof DomainRegistryError
      && error.code === 'domain_removal_descendants_present',
  );
  assert.ok(await registry.getDomain(domainId));
});

test('Website removal detachment is exact, idempotent and suspension-bound', async () => {
  const registry = createDomainRegistry({
    getWebsite: async (id) => id === websiteId ? { id, serverId: 'local' } : null,
  });
  const suspended = await createSuspendedDomain(registry, { websiteId });

  const detached = await registry.detachWebsiteForRemoval(domainId, {
    expectedWebsiteId: websiteId,
    expectedRevision: suspended.desiredRevision,
    checksum,
    suspensionOperationId: operationId,
  });
  assert.equal(detached.changed, true);
  assert.equal(detached.detachedWebsiteId, websiteId);
  assert.equal(detached.domain.websiteId, null);
  assert.equal(detached.domain.state, 'suspended');

  const retried = await registry.detachWebsiteForRemoval(domainId, {
    expectedWebsiteId: websiteId,
    expectedRevision: suspended.desiredRevision,
    checksum,
    suspensionOperationId: operationId,
  });
  assert.equal(retried.changed, false);
  assert.equal(retried.domain.websiteId, null);

  await assert.rejects(
    registry.detachWebsiteForRemoval(domainId, {
      expectedWebsiteId: websiteId,
      expectedRevision: suspended.desiredRevision,
      checksum,
      suspensionOperationId: otherOperationId,
    }),
    (error) => error instanceof DomainRegistryError
      && error.code === 'domain_removal_suspension_evidence_invalid',
  );
});

test('certificate removal detachment preserves certificate resource and clears only exact Domain binding', async () => {
  const registry = createDomainRegistry();
  const suspended = await createSuspendedDomain(registry, {
    httpsMode: 'managed',
    certificateId: 'certificate-1',
  });

  const detached = await registry.detachCertificateForRemoval(domainId, {
    expectedCertificateId: 'certificate-1',
    expectedRevision: suspended.desiredRevision,
    checksum,
    suspensionOperationId: operationId,
  });
  assert.equal(detached.changed, true);
  assert.equal(detached.detachedCertificateId, 'certificate-1');
  assert.equal(detached.domain.certificateId, null);
  assert.equal(detached.domain.state, 'suspended');

  const retried = await registry.detachCertificateForRemoval(domainId, {
    expectedCertificateId: 'certificate-1',
    expectedRevision: suspended.desiredRevision,
    checksum,
    suspensionOperationId: operationId,
  });
  assert.equal(retried.changed, false);

  await assert.rejects(
    registry.detachCertificateForRemoval(domainId, {
      expectedCertificateId: 'other-certificate',
      expectedRevision: suspended.desiredRevision,
      checksum,
      suspensionOperationId: operationId,
    }),
    (error) => error instanceof DomainRegistryError
      && error.code === 'domain_removal_certificate_binding_drift',
  );
});

test('finalization refuses Website binding until reverse dependency cleanup detached it', async () => {
  const registry = createDomainRegistry({
    getWebsite: async (id) => id === websiteId ? { id, serverId: 'local' } : null,
  });
  const suspended = await createSuspendedDomain(registry, { websiteId });

  await assert.rejects(
    registry.finalizeDomainRemoval(domainId, {
      operationId,
      expectedRevision: suspended.desiredRevision,
      checksum,
      confirmation: confirmation(suspended.desiredRevision),
    }),
    (error) => error instanceof DomainRegistryError
      && error.code === 'domain_removal_website_binding_present',
  );
});

test('finalization refuses certificate binding until certificate lifecycle is completed', async () => {
  const registry = createDomainRegistry();
  const suspended = await createSuspendedDomain(registry, {
    httpsMode: 'managed',
    certificateId: 'certificate-1',
  });

  await assert.rejects(
    registry.finalizeDomainRemoval(domainId, {
      operationId,
      expectedRevision: suspended.desiredRevision,
      checksum,
      confirmation: confirmation(suspended.desiredRevision),
    }),
    (error) => error instanceof DomainRegistryError
      && error.code === 'domain_removal_certificate_present',
  );
});

test('finalization is bound to exact suspension operation, revision, checksum and typed confirmation', async () => {
  const registry = createDomainRegistry();
  const suspended = await createSuspendedDomain(registry);

  for (const [input, code] of [
    [{
      operationId: '52345678-1234-4234-8234-123456789012',
      expectedRevision: suspended.desiredRevision,
      checksum,
      confirmation: confirmation(suspended.desiredRevision),
    }, 'domain_removal_confirmation_invalid'],
    [{
      operationId,
      expectedRevision: suspended.desiredRevision,
      checksum: 'b'.repeat(64),
      confirmation: confirmation(suspended.desiredRevision),
    }, 'domain_removal_confirmation_invalid'],
    [{
      operationId,
      expectedRevision: suspended.desiredRevision,
      checksum,
      confirmation: 'wrong',
    }, 'domain_removal_confirmation_invalid'],
    [{
      operationId,
      expectedRevision: suspended.desiredRevision + 1,
      checksum,
      confirmation: domainRegistryInternals.removalConfirmation({
        domainId,
        operationId,
        expectedRevision: suspended.desiredRevision + 1,
        checksum,
      }),
    }, 'domain_removal_suspension_evidence_invalid'],
  ]) {
    await assert.rejects(
      registry.finalizeDomainRemoval(domainId, input),
      (error) => error instanceof DomainRegistryError && error.code === code,
    );
    assert.ok(await registry.getDomain(domainId));
  }
});

test('active or resumed Domain cannot be finalized as removed', async () => {
  const registry = createDomainRegistry();
  let domain = await registry.createDomain({
    domainId,
    serverId: 'local',
    primaryDomain: 'example.com',
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 3300 },
  });
  await registry.markStaged(domain.id, {
    checksum,
    configName: 'yunpanel-example.com.conf',
  });
  domain = await registry.markApplied(domain.id, { checksum });

  await assert.rejects(
    registry.finalizeDomainRemoval(domainId, {
      operationId,
      expectedRevision: domain.desiredRevision,
      checksum,
      confirmation: confirmation(domain.desiredRevision),
    }),
    (error) => error instanceof DomainRegistryError
      && error.code === 'domain_removal_suspension_evidence_invalid',
  );

  await registry.markSuspended(domainId, {
    expectedRevision: domain.desiredRevision,
    checksum,
    operationId,
  });
  await registry.markResumed(domainId, {
    expectedRevision: domain.desiredRevision,
    checksum,
    operationId,
  });
  await assert.rejects(
    registry.finalizeDomainRemoval(domainId, {
      operationId,
      expectedRevision: domain.desiredRevision,
      checksum,
      confirmation: confirmation(domain.desiredRevision),
    }),
    (error) => error instanceof DomainRegistryError
      && error.code === 'domain_removal_suspension_evidence_invalid',
  );
});
