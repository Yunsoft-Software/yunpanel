import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createDomainRegistry, DomainRegistryError } from '../src/domain-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createWebsiteRegistry } from '../src/website-registry.js';

test('creates normalized domain desired state for an existing server', async () => {
  const registry = createDomainRegistry({ serverExists: async (serverId) => serverId === 'server-1' });
  const domain = await registry.createDomain({
    serverId: 'server-1',
    primaryDomain: 'Example.COM',
    aliases: ['www.example.com', 'WWW.EXAMPLE.COM.'],
    targetType: 'static',
    target: { root: '/var/lib/yunpanel/apps/example/current', spaFallback: true },
  });

  assert.equal(domain.primaryDomain, 'example.com');
  assert.deepEqual(domain.aliases, ['www.example.com']);
  assert.equal(domain.state, 'draft');
  assert.equal(domain.desiredRevision, 1);
  assert.equal(domain.appliedRevision, 0);
});

test('rejects duplicate primary domains and aliases across records', async () => {
  const registry = createDomainRegistry({ serverExists: async () => true });
  await registry.createDomain({
    serverId: 'server-1',
    primaryDomain: 'example.com',
    aliases: ['www.example.com'],
    targetType: 'proxy',
    target: { upstreamPort: 3000 },
  });

  await assert.rejects(
    registry.createDomain({
      serverId: 'server-2',
      primaryDomain: 'www.example.com',
      targetType: 'proxy',
      target: { upstreamPort: 3001 },
    }),
    (error) => error instanceof DomainRegistryError && error.code === 'domain_conflict' && error.status === 409,
  );
});

test('rejects domains for unknown servers and unsafe target values', async () => {
  const registry = createDomainRegistry({ serverExists: async () => false });
  await assert.rejects(
    registry.createDomain({
      serverId: 'missing',
      primaryDomain: 'example.com',
      targetType: 'proxy',
      target: { upstreamPort: 3000 },
    }),
    (error) => error instanceof DomainRegistryError && error.code === 'server_not_found',
  );

  const existingServerRegistry = createDomainRegistry({ serverExists: async () => true });
  await assert.rejects(
    existingServerRegistry.createDomain({
      serverId: 'server-1',
      primaryDomain: 'api.example.com',
      targetType: 'proxy',
      target: { upstreamPort: 80 },
    }),
    (error) => error instanceof DomainRegistryError && error.code === 'invalid_upstream_port',
  );
});

test('external proxy targets canonicalize safe DNS and IPv6 hosts without URL injection', async () => {
  const registry = createDomainRegistry();
  const dns = await registry.createDomain({
    serverId: 'local',
    primaryDomain: 'edge.example.com',
    targetType: 'proxy',
    target: { upstreamHost: 'ORIGIN.Example.NET.', upstreamPort: 8443, websocket: false },
  });
  assert.deepEqual(dns.target, { upstreamHost: 'origin.example.net', upstreamPort: 8443, websocket: false });
  const ipv6 = await registry.createDomain({
    serverId: 'local',
    primaryDomain: 'ipv6.example.com',
    targetType: 'proxy',
    target: { upstreamHost: '[2001:0DB8:0:0:0:0:0:1]', upstreamPort: 8080 },
  });
  assert.equal(ipv6.target.upstreamHost, '2001:db8::1');

  await assert.rejects(
    registry.createDomain({
      serverId: 'local',
      primaryDomain: 'unsafe.example.com',
      targetType: 'proxy',
      target: { upstreamHost: 'https://origin.example.net/path', upstreamPort: 8443 },
    }),
    (error) => error instanceof DomainRegistryError && error.code === 'invalid_upstream_host',
  );
});

test('internal deterministic Domain identity is idempotent without resetting applied state', async () => {
  const registry = createDomainRegistry();
  const domainId = '234cd749-403d-4bb1-b122-5693d36af3fe';
  const input = {
    domainId,
    serverId: 'local',
    primaryDomain: 'stable.example.com',
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 3100 },
  };
  const created = await registry.createDomain(input);
  await registry.markStaged(created.id, {
    revision: created.desiredRevision,
    checksum: 'a'.repeat(64),
    configName: 'stable.example.com.conf',
  });
  await registry.markApplied(created.id, { checksum: 'a'.repeat(64) });

  const retried = await registry.createDomain(input);
  assert.equal(retried.id, domainId);
  assert.equal(retried.state, 'active');
  assert.equal(retried.appliedRevision, 1);
  assert.equal((await registry.listDomains()).length, 1);

  await assert.rejects(
    registry.createDomain({ ...input, primaryDomain: 'reused.example.com' }),
    (error) => error instanceof DomainRegistryError && error.code === 'domain_identity_conflict' && error.status === 409,
  );
});

test('tracks appliedChecksum metadata across provisioning, activation, updates, certificate attachment, staging and failures', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'domain-applied-checksum-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const servers = createServerRegistry({ filePath: path.join(dir, 'servers.json') });
  await servers.init();
  const server = await servers.createLocalServer({ hostname: 'checksum-panel.example.test' });
  const applications = createApplicationRegistry({
    filePath: path.join(dir, 'applications.json'),
    serverExists: async (id) => Boolean(await servers.getServer(id)),
  });
  await applications.init();
  const application = await applications.createPhpApplication({ serverId: server.id, name: 'Checksum PHP' });
  const websites = createWebsiteRegistry({
    filePath: path.join(dir, 'websites.json'),
    serverExists: async (id) => Boolean(await servers.getServer(id)),
    getApplication: (id) => applications.getApplication(id),
  });
  await websites.init();
  const website = await websites.createWebsite({
    serverId: server.id,
    name: 'Checksum site',
    applicationId: application.id,
    runtimeType: 'php',
  });
  const websiteId = website.id;
  const applicationId = application.id;
  const registry = createDomainRegistry({
    filePath: path.join(dir, 'domains.json'),
    serverExists: async (id) => Boolean(await servers.getServer(id)),
    getWebsite: (id) => websites.getWebsite(id),
  });
  await registry.init();

  const provisioned = await registry.createDomain({
    serverId: server.id,
    websiteId,
    primaryDomain: 'php-site.example.test',
    targetType: 'php',
    target: { applicationId },
    httpsMode: 'off',
  });
  assert.equal(provisioned.appliedChecksum, null);

  const rev1Checksum = '1'.repeat(64);
  const [activatedProvisioned] = await registry.activateProvisionedDomains({
    websiteId,
    domains: [{ domainId: provisioned.id, expectedRevision: 1 }],
    checksum: rev1Checksum,
    configName: 'yunpanel-php-site.example.test.conf',
  });
  assert.equal(activatedProvisioned.state, 'active');
  assert.equal(activatedProvisioned.appliedRevision, 1);
  assert.equal(activatedProvisioned.stagedChecksum, rev1Checksum);
  assert.equal(activatedProvisioned.appliedChecksum, rev1Checksum);
  assert.equal(activatedProvisioned.appliedPrimaryDomain, 'php-site.example.test');

  const [resetProvisioned] = await registry.resetProvisionedDomains({
    websiteId,
    domains: [{ domainId: provisioned.id, expectedRevision: 1 }],
    checksum: rev1Checksum,
    configName: 'yunpanel-php-site.example.test.conf',
  });
  assert.equal(resetProvisioned.state, 'draft');
  assert.equal(resetProvisioned.appliedRevision, 0);
  assert.equal(resetProvisioned.stagedChecksum, null);
  assert.equal(resetProvisioned.appliedChecksum, null);
  assert.equal(resetProvisioned.appliedPrimaryDomain, null);

  await registry.markStaged(provisioned.id, {
    expectedRevision: 1,
    checksum: rev1Checksum,
    configName: 'yunpanel-php-site.example.test.conf',
  });
  assert.equal((await registry.getDomain(provisioned.id)).appliedChecksum, null);

  const markedActive = await registry.markApplied(provisioned.id, { checksum: rev1Checksum });
  assert.equal(markedActive.appliedRevision, 1);
  assert.equal(markedActive.appliedChecksum, rev1Checksum);
  assert.equal(markedActive.appliedPrimaryDomain, 'php-site.example.test');

  const updatePreview = await registry.previewDomainUpdate({
    domainId: provisioned.id,
    changes: {
      primaryDomain: 'renamed-php.example.test',
      httpsMode: 'managed',
      nginxSettings: { staticAssetCacheSeconds: 120 },
    },
  });
  const { domain: afterUpdate } = await registry.updateDomain({
    domainId: provisioned.id,
    changes: {
      primaryDomain: 'renamed-php.example.test',
      httpsMode: 'managed',
      nginxSettings: { staticAssetCacheSeconds: 120 },
    },
    previewDigest: updatePreview.previewDigest,
  });
  assert.equal(afterUpdate.state, 'draft');
  assert.equal(afterUpdate.desiredRevision, 2);
  assert.equal(afterUpdate.stagedRevision, 0);
  assert.equal(afterUpdate.stagedChecksum, null);
  assert.equal(afterUpdate.appliedRevision, 1);
  assert.equal(afterUpdate.appliedChecksum, rev1Checksum);
  assert.equal(afterUpdate.appliedPrimaryDomain, 'php-site.example.test');

  const afterCert = await registry.attachCertificate(provisioned.id, 'cert-1', {
    domains: ['renamed-php.example.test'],
  });
  assert.equal(afterCert.state, 'draft');
  assert.equal(afterCert.desiredRevision, 3);
  assert.equal(afterCert.stagedChecksum, null);
  assert.equal(afterCert.appliedRevision, 1);
  assert.equal(afterCert.appliedChecksum, rev1Checksum);
  assert.equal(afterCert.appliedPrimaryDomain, 'php-site.example.test');

  const rev3StagedChecksum = '3'.repeat(64);
  const afterStaged = await registry.markStaged(provisioned.id, {
    expectedRevision: 3,
    checksum: rev3StagedChecksum,
    configName: 'yunpanel-renamed-php.example.test.conf',
  });
  assert.equal(afterStaged.state, 'staged');
  assert.equal(afterStaged.stagedChecksum, rev3StagedChecksum);
  assert.equal(afterStaged.appliedRevision, 1);
  assert.equal(afterStaged.appliedChecksum, rev1Checksum);
  assert.equal(afterStaged.appliedPrimaryDomain, 'php-site.example.test');

  const afterFailed = await registry.markFailed(provisioned.id, 'invalid_operation_payload');
  assert.equal(afterFailed.state, 'error');
  assert.equal(afterFailed.appliedRevision, 1);
  assert.equal(afterFailed.appliedChecksum, rev1Checksum);
  assert.equal(afterFailed.appliedPrimaryDomain, 'php-site.example.test');
  const reloaded = createDomainRegistry({
    filePath: path.join(dir, 'domains.json'),
    serverExists: async (id) => Boolean(await servers.getServer(id)),
    getWebsite: (id) => websites.getWebsite(id),
  });
  await reloaded.init();
  const persisted = await reloaded.getDomain(provisioned.id);
  assert.equal(persisted.state, 'error');
  assert.equal(persisted.appliedChecksum, rev1Checksum);
  assert.equal(persisted.stagedChecksum, rev3StagedChecksum);
  assert.equal(persisted.appliedPrimaryDomain, 'php-site.example.test');
});

test('hydrates legacy persisted Domain records and rejects invalid appliedChecksum invariants', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'domain-registry-hydrate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'domains.json');

  const seedRegistry = createDomainRegistry({ filePath });
  const activeSeed = await seedRegistry.createDomain({
    serverId: 'local',
    primaryDomain: 'active-legacy.example.test',
    targetType: 'proxy',
    target: { upstreamPort: 3000 },
  });
  await seedRegistry.markStaged(activeSeed.id, {
    expectedRevision: 1,
    checksum: 'a'.repeat(64),
    configName: 'yunpanel-active-legacy.example.test.conf',
  });
  await seedRegistry.markApplied(activeSeed.id, { checksum: 'a'.repeat(64) });

  const suspendedSeed = await seedRegistry.createDomain({
    serverId: 'local',
    primaryDomain: 'suspended-legacy.example.test',
    targetType: 'proxy',
    target: { upstreamPort: 3001 },
  });
  await seedRegistry.markStaged(suspendedSeed.id, {
    expectedRevision: 1,
    checksum: 'b'.repeat(64),
    configName: 'yunpanel-suspended-legacy.example.test.conf',
  });
  await seedRegistry.markApplied(suspendedSeed.id, { checksum: 'b'.repeat(64) });
  await seedRegistry.markSuspended(suspendedSeed.id, {
    expectedRevision: 1,
    checksum: 'b'.repeat(64),
    operationId: 'suspend-op-legacy-1',
  });

  const pendingDraftSeed = await seedRegistry.createDomain({
    serverId: 'local',
    primaryDomain: 'draft-legacy.example.test',
    targetType: 'proxy',
    target: { upstreamPort: 3002 },
  });
  await seedRegistry.markStaged(pendingDraftSeed.id, {
    expectedRevision: 1,
    checksum: 'c'.repeat(64),
    configName: 'yunpanel-draft-legacy.example.test.conf',
  });
  await seedRegistry.markApplied(pendingDraftSeed.id, { checksum: 'c'.repeat(64) });
  const preview = await seedRegistry.previewDomainUpdate({
    domainId: pendingDraftSeed.id,
    changes: { nginxSettings: { proxyTimeoutSeconds: 45 } },
  });
  await seedRegistry.updateDomain({
    domainId: pendingDraftSeed.id,
    changes: { nginxSettings: { proxyTimeoutSeconds: 45 } },
    previewDigest: preview.previewDigest,
  });

  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  for (const record of persisted.domains) {
    delete record.appliedChecksum;
  }
  await writeFile(filePath, JSON.stringify(persisted, null, 2), 'utf8');

  const reloaded = createDomainRegistry({ filePath });
  await reloaded.init();
  assert.equal((await reloaded.getDomain(activeSeed.id)).appliedChecksum, 'a'.repeat(64));
  assert.equal((await reloaded.getDomain(suspendedSeed.id)).appliedChecksum, 'b'.repeat(64));
  assert.equal((await reloaded.getDomain(pendingDraftSeed.id)).appliedChecksum, null);

  const invalidUnpublished = structuredClone(persisted);
  invalidUnpublished.domains[0] = {
    ...invalidUnpublished.domains[0],
    state: 'draft',
    stagedRevision: 0,
    stagedChecksum: null,
    appliedRevision: 0,
    appliedPrimaryDomain: null,
    appliedChecksum: 'a'.repeat(64),
  };
  const invalidPath = path.join(dir, 'invalid-domains.json');
  await writeFile(invalidPath, JSON.stringify(invalidUnpublished, null, 2), 'utf8');
  const brokenRegistry = createDomainRegistry({ filePath: invalidPath });
  await assert.rejects(
    brokenRegistry.init(),
    (error) => error instanceof DomainRegistryError && error.code === 'invalid_domain_state' && error.status === 409,
  );
});

test('markSuspended rejects allowDraft when appliedRevision > 0 and supports allowPriorAppliedForRemoval only with exact appliedChecksum', async () => {
  const registry = createDomainRegistry();
  const domain = await registry.createDomain({
    serverId: 'local',
    primaryDomain: 'prior-applied.example.test',
    targetType: 'proxy',
    target: { upstreamPort: 3010 },
  });
  const rev1Checksum = 'd'.repeat(64);
  await registry.markStaged(domain.id, {
    expectedRevision: 1,
    checksum: rev1Checksum,
    configName: 'yunpanel-prior-applied.example.test.conf',
  });
  await registry.markApplied(domain.id, { checksum: rev1Checksum });

  const updatePreview = await registry.previewDomainUpdate({
    domainId: domain.id,
    changes: { primaryDomain: 'next-prior-applied.example.test' },
  });
  await registry.updateDomain({
    domainId: domain.id,
    changes: { primaryDomain: 'next-prior-applied.example.test' },
    previewDigest: updatePreview.previewDigest,
  });

  await assert.rejects(
    registry.markSuspended(domain.id, {
      expectedRevision: 2,
      checksum: 'e'.repeat(64),
      operationId: 'domain-remove-suspend:op-1',
      allowDraft: true,
    }),
    (error) => error instanceof DomainRegistryError
      && error.code === 'domain_suspension_state_drift'
      && error.status === 409,
  );

  await assert.rejects(
    registry.markSuspended(domain.id, {
      expectedRevision: 2,
      checksum: 'f'.repeat(64),
      operationId: 'domain-remove-suspend:op-1',
      allowPriorAppliedForRemoval: true,
    }),
    (error) => error instanceof DomainRegistryError
      && error.code === 'domain_suspension_state_drift'
      && error.status === 409,
  );

  const suspended = await registry.markSuspended(domain.id, {
    expectedRevision: 2,
    checksum: rev1Checksum,
    operationId: 'domain-remove-suspend:op-1',
    allowPriorAppliedForRemoval: true,
  });
  assert.equal(suspended.state, 'suspended');
  assert.equal(suspended.desiredRevision, 2);
  assert.equal(suspended.stagedRevision, 2);
  assert.equal(suspended.appliedRevision, 2);
  assert.equal(suspended.stagedChecksum, rev1Checksum);
  assert.equal(suspended.appliedChecksum, rev1Checksum);
  assert.equal(suspended.suspendedChecksum, rev1Checksum);
  assert.equal(suspended.appliedPrimaryDomain, 'next-prior-applied.example.test');
  assert.equal(suspended.suspensionOperationId, 'domain-remove-suspend:op-1');
});
