import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDnsHostingRegistry } from '../src/dns-hosting-registry.js';
import { createDnsProviderCredentialRegistry } from '../src/dns-provider-credential-registry.js';
import { createDnsRequirementsService } from '../src/dns-requirements-service.js';
import { createDomainReparentHandler, createDomainUpdateHandler } from '../src/domain-http.js';
import { createDomainRegistry, DomainRegistryError } from '../src/domain-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createMailAliasRegistry } from '../src/mail-alias-registry.js';
import { mailboxAliasReferences } from '../src/mailbox-alias-references.js';
import { createMailDiscoveryEndpointResolver } from '../src/mail-discovery-endpoint-resolver.js';
import { createMailDiscoveryService } from '../src/mail-discovery-service.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createSiteMutationLock } from '../src/site-mutation-lock.js';
import { createSiteResourceBoundary } from '../src/site-resource-boundary.js';

function responseRecorder() {
  return {
    code: 200,
    payload: null,
    status(c) {
      this.code = c;
      return this;
    },
    json(p) {
      this.payload = p;
      return this;
    },
  };
}

test('domain alias update acquires shared backend resource lock and blocks concurrent mutations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-alias-lock-test-'));
  try {
    const lockA = createSiteMutationLock({ root, pid: 1001, signalProcess: () => true });
    const lockB = createSiteMutationLock({ root, pid: 1002, signalProcess: () => true });

    const serverId = randomUUID();
    const websiteId = randomUUID();

    const domainRegistry = createDomainRegistry({
      getWebsite: async (id) => (id === websiteId ? { id: websiteId, serverId, runtimeType: 'proxy' } : null),
      serverExists: async (id) => id === serverId,
      siteMutationLock: lockA,
    });

    const domain = await domainRegistry.createDomain({
      serverId,
      websiteId,
      primaryDomain: 'example.com',
      aliases: ['www.example.com'],
      targetType: 'proxy',
      target: { upstreamPort: 8080 },
      httpsMode: 'off',
    });

    // 1. When another process holds the website lock, domain update HTTP handler is rejected with 409 site_mutation_locked
    let releaseHold;
    const holdPromise = new Promise((resolve) => { releaseHold = resolve; });
    const holdTask = lockB.withWebsiteLock(websiteId, async () => {
      await holdPromise;
      return 'held';
    });
    await new Promise((resolve) => setTimeout(resolve, 15));

    const preview = await domainRegistry.previewDomainUpdate({
      domainId: domain.id,
      changes: { aliases: ['www.example.com', 'app.example.com'] },
    });

    const updateHandler = createDomainUpdateHandler(domainRegistry, {
      siteMutationLock: lockA,
      localServerId: serverId,
    });

    const response = responseRecorder();
    let handledError = null;
    await updateHandler(
      {
        params: { domainId: domain.id },
        body: {
          changes: { aliases: ['www.example.com', 'app.example.com'] },
          previewDigest: preview.previewDigest,
          confirmation: preview.confirmation,
        },
      },
      response,
      (err) => { handledError = err; },
    );

    assert.ok(handledError, 'Expected error when website lock is held');
    assert.equal(handledError.code, 'site_mutation_locked');
    assert.equal(handledError.status, 409);

    // Release the website lock
    releaseHold();
    await holdTask;

    // 2. Now domain update succeeds with lock acquired and released
    const successResponse = responseRecorder();
    let successError = null;
    await updateHandler(
      {
        params: { domainId: domain.id },
        body: {
          changes: { aliases: ['www.example.com', 'app.example.com'] },
          previewDigest: preview.previewDigest,
          confirmation: preview.confirmation,
        },
      },
      successResponse,
      (err) => { successError = err; },
    );

    assert.equal(successError, null);
    assert.deepEqual(successResponse.payload.data.domain.aliases, ['www.example.com', 'app.example.com']);

    // 3. Directly calling updateDomain with siteMutationLock when domain is locked by another process fails with 409
    let releaseDomainHold;
    const domainHoldPromise = new Promise((resolve) => { releaseDomainHold = resolve; });
    const domainHoldTask = lockB.withDomainLock(domain.id, async () => {
      await domainHoldPromise;
      return 'domain-held';
    });
    await new Promise((resolve) => setTimeout(resolve, 15));

    const nextPreview = await domainRegistry.previewDomainUpdate({
      domainId: domain.id,
      changes: { aliases: ['www.example.com'] },
    });

    await assert.rejects(
      () => domainRegistry.updateDomain({
        domainId: domain.id,
        changes: { aliases: ['www.example.com'] },
        previewDigest: nextPreview.previewDigest,
      }),
      (err) => err instanceof DomainRegistryError && err.code === 'site_mutation_locked' && err.status === 409,
    );

    releaseDomainHold();
    await domainHoldTask;

    // After release, direct registry updateDomain succeeds
    const directResult = await domainRegistry.updateDomain({
      domainId: domain.id,
      changes: { aliases: ['www.example.com'] },
      previewDigest: nextPreview.previewDigest,
    });
    assert.deepEqual(directResult.domain.aliases, ['www.example.com']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('domain reparent acquires resource lock and serializes correctly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-reparent-lock-test-'));
  try {
    const lockA = createSiteMutationLock({ root, pid: 1001, signalProcess: () => true });
    const lockB = createSiteMutationLock({ root, pid: 1002, signalProcess: () => true });

    const domainRegistry = createDomainRegistry({ siteMutationLock: lockA });
    const parentA = await domainRegistry.createDomain({
      serverId: 'local',
      primaryDomain: 'example.com',
      targetType: 'static',
      target: { root: '/var/www/a' },
    });
    const parentB = await domainRegistry.createDomain({
      serverId: 'local',
      primaryDomain: 'sub.example.com',
      parentDomainId: parentA.id,
      targetType: 'static',
      target: { root: '/var/www/b' },
    });
    const child = await domainRegistry.createDomain({
      serverId: 'local',
      primaryDomain: 'api.sub.example.com',
      parentDomainId: parentB.id,
      targetType: 'static',
      target: { root: '/var/www/c' },
    });

    const preview = await domainRegistry.previewDomainReparent({
      domainId: child.id,
      parentDomainId: parentA.id,
    });

    // Hold domain lock on child
    let releaseHold;
    const holdPromise = new Promise((resolve) => { releaseHold = resolve; });
    const holdTask = lockB.withDomainLock(child.id, async () => {
      await holdPromise;
      return 'held';
    });
    await new Promise((resolve) => setTimeout(resolve, 15));

    const reparentHandler = createDomainReparentHandler(domainRegistry, {
      siteMutationLock: lockA,
      localServerId: 'local',
    });

    let handledError = null;
    await reparentHandler(
      {
        params: { domainId: child.id },
        body: {
          parentDomainId: parentA.id,
          previewDigest: preview.previewDigest,
          confirmation: preview.confirmation,
        },
      },
      responseRecorder(),
      (err) => { handledError = err; },
    );

    assert.ok(handledError);
    assert.equal(handledError.code, 'site_mutation_locked');
    assert.equal(handledError.status, 409);

    releaseHold();
    await holdTask;

    // After release, reparent succeeds
    const resp = responseRecorder();
    await reparentHandler(
      {
        params: { domainId: child.id },
        body: {
          parentDomainId: parentA.id,
          previewDigest: preview.previewDigest,
          confirmation: preview.confirmation,
        },
      },
      resp,
      (err) => { throw err; },
    );
    assert.equal(resp.payload.data.domain.parentDomainId, parentA.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DNS requirements synchronize correctly with domain alias lifecycle without creating unauthorized zones', async () => {
  const serverRegistry = createServerRegistry();
  const server = await serverRegistry.createLocalServer({ hostname: 'dns-sync-test' });
  await serverRegistry.updateLocalSnapshot({
    serverId: server.id,
    hostname: 'dns-sync-test',
    inventory: {
      network: [
        { interface: 'eth0', family: 'IPv4', address: '198.51.100.1' },
        { interface: 'eth0', family: 'IPv6', address: '2001:db8::1' },
      ],
    },
  });

  const domainRegistry = createDomainRegistry({
    serverExists: async (id) => id === server.id,
  });
  const dnsHostingRegistry = createDnsHostingRegistry({
    getWebDomain: async (id) => domainRegistry.getDomain(id),
  });

  const domain = await domainRegistry.createDomain({
    serverId: server.id,
    primaryDomain: 'example.org',
    aliases: ['www.example.org'],
    targetType: 'proxy',
    target: { upstreamPort: 8080 },
  });

  const zone = await dnsHostingRegistry.createZone({
    zoneName: 'example.org',
    webDomainId: domain.id,
    managementMode: 'external',
  });

  const dnsProviderCredentialRegistry = createDnsProviderCredentialRegistry({
    masterKey: randomBytes(32),
    getDnsZone: async (id) => dnsHostingRegistry.getZone(id),
  });

  const jobRegistry = createJobRegistry();

  const dnsService = createDnsRequirementsService({
    domainRegistry,
    dnsHostingRegistry,
    serverRegistry,
    dnsProviderCredentialRegistry,
    dnsRecordManager: { async inspectRecord() { return { records: [] }; } },
    jobRegistry,
    localServerId: server.id,
  });

  // Step 1: Initial state with www.example.org alias generates in-zone CNAME
  const initialReqs = await dnsService.inspectZoneRequirements(zone.id);
  const wwwCname = initialReqs.requirements.find((r) => r.record.name === 'www.example.org');
  assert.ok(wwwCname, 'Expected CNAME requirement for in-zone alias');
  assert.equal(wwwCname.record.type, 'CNAME');
  assert.equal(wwwCname.record.content, 'example.org');

  // Verify no unauthorized zones were created
  const zonesBefore = await dnsHostingRegistry.listZones();
  assert.equal(zonesBefore.length, 1);
  assert.equal(zonesBefore[0].zoneName, 'example.org');

  // Step 2: Update domain aliases to add an external alias and remove www
  const preview = await domainRegistry.previewDomainUpdate({
    domainId: domain.id,
    changes: { aliases: ['alt-site.net'] },
  });
  await domainRegistry.updateDomain({
    domainId: domain.id,
    changes: { aliases: ['alt-site.net'] },
    previewDigest: preview.previewDigest,
  });

  // Step 3: DNS requirements reflect alias change: www is gone, cross-zone alias has A / AAAA
  const updatedReqs = await dnsService.inspectZoneRequirements(zone.id);
  const oldWww = updatedReqs.requirements.find((r) => r.record.name === 'www.example.org');
  assert.equal(oldWww, undefined, 'Old alias www.example.org must be removed from requirements');

  const altA = updatedReqs.requirements.find((r) => r.record.name === 'alt-site.net' && r.record.type === 'A');
  assert.ok(altA, 'Cross-zone alias requires A record');
  assert.equal(altA.record.content, '198.51.100.1');

  const altAaaa = updatedReqs.requirements.find((r) => r.record.name === 'alt-site.net' && r.record.type === 'AAAA');
  assert.ok(altAaaa, 'Cross-zone alias requires AAAA record');
  assert.equal(altAaaa.record.content, '2001:db8::1');

  // Ensure adding external alias did NOT create a new DNS zone
  const zonesAfter = await dnsHostingRegistry.listZones();
  assert.equal(zonesAfter.length, 1, 'No unauthorized DNS zone must be auto-created for aliases');
});

test('mail aliases and mailbox references synchronize correctly without auto-creating mailboxes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-alias-sync-'));
  try {
    const storePath = path.join(root, 'mail-aliases.json');
    const mailDomainId = randomUUID();
    const mailAliasRegistry = createMailAliasRegistry({
      filePath: storePath,
      getMailDomain: async (id) => (id === mailDomainId ? { id, domainName: 'example.org', managementMode: 'local' } : null),
    });
    await mailAliasRegistry.init();

    // 1. Creating a mail alias does not create mailboxes or mail domains
    const alias = await mailAliasRegistry.createAlias({
      mailDomainId,
      source: 'contact@example.org',
      destinations: ['real-user@example.org', 'external@gmail.com'],
    });

    assert.equal(alias.source, 'contact@example.org');
    assert.deepEqual(alias.destinations, ['external@gmail.com', 'real-user@example.org']);

    // 2. Mailbox deletion reference guard protects mailbox targeted by alias
    const targetMailbox = {
      id: randomUUID(),
      mailDomainId,
      address: 'real-user@example.org',
    };

    const refs = await mailboxAliasReferences(mailAliasRegistry, targetMailbox);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].id, alias.id);

    // Unrelated mailbox has no references
    const unrelatedMailbox = {
      id: randomUUID(),
      mailDomainId,
      address: 'other@example.org',
    };
    const unrelatedRefs = await mailboxAliasReferences(mailAliasRegistry, unrelatedMailbox);
    assert.deepEqual(unrelatedRefs, []);

    // 3. Foreign inbound alias redaction prevents identity leakage
    const foreignRefs = await mailboxAliasReferences({
      listAliases: async (filter) => (filter ? [] : [{ id: 'secret-foreign-id', destinations: ['real-user@example.org'] }]),
    }, targetMailbox);
    assert.equal(foreignRefs.length, 1);
    assert.equal(foreignRefs[0].id, null, 'Foreign alias identity must be redacted to null');

    // 4. Updating alias removes references to old target
    await mailAliasRegistry.updateAlias(alias.id, {
      expectedRevision: alias.revision,
      destinations: ['external@gmail.com'],
      enabled: true,
    });

    const refsAfterUpdate = await mailboxAliasReferences(mailAliasRegistry, targetMailbox);
    assert.deepEqual(refsAfterUpdate, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('hosting redirect settings update acquires backend resource lock and enforces fail-closed and auth boundaries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-hosting-redirect-lock-test-'));
  try {
    const lockA = createSiteMutationLock({ root, pid: 2001, signalProcess: () => true });
    const lockB = createSiteMutationLock({ root, pid: 2002, signalProcess: () => true });

    const serverId = randomUUID();
    const websiteId = randomUUID();

    const domainRegistry = createDomainRegistry({
      getWebsite: async (id) => (id === websiteId ? { id: websiteId, serverId, runtimeType: 'proxy' } : null),
      serverExists: async (id) => id === serverId,
      siteMutationLock: lockA,
    });

    const domain = await domainRegistry.createDomain({
      serverId,
      websiteId,
      primaryDomain: 'redirect.example.com',
      aliases: ['www.redirect.example.com'],
      targetType: 'proxy',
      target: { upstreamPort: 8080 },
      httpsMode: 'managed',
      httpsRedirect: false,
      canonicalRedirect: false,
    });

    // 1. Holding website lock blocks hosting redirect update with 409 site_mutation_locked
    let releaseHold;
    const holdPromise = new Promise((resolve) => { releaseHold = resolve; });
    const holdTask = lockB.withWebsiteLock(websiteId, async () => {
      await holdPromise;
      return 'held';
    });
    await new Promise((resolve) => setTimeout(resolve, 15));

    const changes = { httpsRedirect: true, canonicalRedirect: true };
    const preview = await domainRegistry.previewDomainUpdate({
      domainId: domain.id,
      changes,
    });
    assert.equal(preview.next.httpsRedirect, true);
    assert.equal(preview.next.canonicalRedirect, true);

    const updateHandler = createDomainUpdateHandler(domainRegistry, {
      siteMutationLock: lockA,
      localServerId: serverId,
    });

    const response = responseRecorder();
    let handledError = null;
    await updateHandler(
      {
        params: { domainId: domain.id },
        body: {
          changes,
          previewDigest: preview.previewDigest,
          confirmation: preview.confirmation,
        },
      },
      response,
      (err) => { handledError = err; },
    );

    assert.ok(handledError, 'Expected error when website lock is held');
    assert.equal(handledError.code, 'site_mutation_locked');
    assert.equal(handledError.status, 409);

    releaseHold();
    await holdTask;

    // 2. Reject mismatched confirmation fail-closed
    let confirmError = null;
    await updateHandler(
      {
        params: { domainId: domain.id },
        body: {
          changes,
          previewDigest: preview.previewDigest,
          confirmation: 'wrong-confirmation',
        },
      },
      responseRecorder(),
      (err) => { confirmError = err; },
    );
    assert.equal(confirmError?.code, 'domain_update_confirmation_required');

    // 3. Reject stale preview digest fail-closed
    let staleError = null;
    await updateHandler(
      {
        params: { domainId: domain.id },
        body: {
          changes,
          previewDigest: '0'.repeat(64),
          confirmation: preview.confirmation,
        },
      },
      responseRecorder(),
      (err) => { staleError = err; },
    );
    assert.equal(staleError?.code, 'domain_update_preview_stale');

    // 4. Successful update under lock updates only redirect settings
    const successResponse = responseRecorder();
    let successError = null;
    await updateHandler(
      {
        params: { domainId: domain.id },
        body: {
          changes,
          previewDigest: preview.previewDigest,
          confirmation: preview.confirmation,
        },
      },
      successResponse,
      (err) => { successError = err; },
    );

    assert.equal(successError, null);
    assert.equal(successResponse.payload.data.domain.httpsRedirect, true);
    assert.equal(successResponse.payload.data.domain.canonicalRedirect, true);

    // Verify persisted state in registry
    const updatedDomain = await domainRegistry.getDomain(domain.id);
    assert.equal(updatedDomain.httpsRedirect, true);
    assert.equal(updatedDomain.canonicalRedirect, true);
    assert.equal(updatedDomain.primaryDomain, 'redirect.example.com');
    assert.deepEqual(updatedDomain.aliases, ['www.redirect.example.com']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('mail discovery and endpoint resolver integrate with domain alias lifecycle and enforce fail-closed routing', async () => {
  const serverId = randomUUID();
  const websiteId = randomUUID();
  const webDomainId = randomUUID();
  const mailDomainId = randomUUID();
  const certificateId = randomUUID();
  const operationId = randomUUID();
  const checksum = 'a'.repeat(64);

  const mailDomain = {
    id: mailDomainId,
    webDomainId,
    domainName: 'example.com',
    managementMode: 'local',
    status: 'enabled',
    revision: 1,
  };

  const domain = {
    id: webDomainId,
    serverId,
    websiteId,
    primaryDomain: 'example.com',
    aliases: ['alias.example.com'],
    state: 'active',
    httpsMode: 'managed',
    httpsRedirect: true,
    canonicalRedirect: false,
    certificateId,
    desiredRevision: 2,
    stagedChecksum: checksum,
  };

  const mailDomainRegistry = {
    listMailDomains: async () => [mailDomain],
  };

  const domainRegistry = {
    getDomain: async (id) => (id === webDomainId ? domain : null),
  };

  const mailServiceIdentityRegistry = {
    getForServer: async (id) => (id === serverId ? {
      serverId,
      hostname: 'mail.example.com',
      ready: true,
      revision: 1,
    } : null),
  };

  const mailDiscoveryService = createMailDiscoveryService({
    mailDomainRegistry,
    domainRegistry,
    mailServiceIdentityRegistry,
  });

  // 1. Mail discovery service resolves state for canonical primary domain
  const state = await mailDiscoveryService.resolveState('example.com');
  assert.equal(state.domainName, 'example.com');
  assert.equal(state.serviceHostname, 'mail.example.com');

  // 2. Autoconfig and autodiscover return XML protocols with STARTTLS ports
  const autoconfig = await mailDiscoveryService.autoconfig({
    domainName: 'example.com',
    emailAddress: 'user@example.com',
  });
  assert.ok(autoconfig.body.includes('<hostname>mail.example.com</hostname>'));
  assert.ok(autoconfig.body.includes('<port>143</port>'));
  assert.ok(autoconfig.body.includes('<port>587</port>'));

  const autodiscover = await mailDiscoveryService.autodiscover({
    domainName: 'example.com',
    emailAddress: 'user@example.com',
  });
  assert.ok(autodiscover.body.includes('<Server>mail.example.com</Server>'));

  // 3. Address belonging to alias is rejected by discovery service fail-closed
  await assert.rejects(
    () => mailDiscoveryService.autoconfig({
      domainName: 'example.com',
      emailAddress: 'user@alias.example.com',
    }),
    (err) => err.code === 'mail_discovery_address_domain_mismatch' && err.status === 404,
  );

  // 4. Mail discovery endpoint resolver verifies runtime and matching Website provisioning operation
  let runtimeSocketReady = true;
  const mailDiscoveryRuntime = {
    inspect: async () => ({
      version: 1,
      ready: runtimeSocketReady,
      socketPath: '/run/yunpanel-mail-discovery/discovery.sock',
      sideEffects: false,
    }),
  };

  let provisioningRevision = 2;
  const websiteProvisioningRegistry = {
    listForWebsite: async (wsId) => (wsId === websiteId ? [
      {
        operationId,
        websiteId,
        steps: [
          {
            id: 'nginx',
            kind: 'nginx',
            state: 'succeeded',
            intent: {
              websiteId,
              primaryDomain: 'example.com',
              aliases: ['alias.example.com'],
              mailDiscoverySocketPath: '/run/yunpanel-mail-discovery/discovery.sock',
              targetType: 'static',
              target: { root: '/var/www/site' },
            },
          },
          {
            id: 'tls_activation',
            kind: 'tls_activation',
            state: 'succeeded',
            evidence: {
              satisfied: true,
              adapter: 'managed-certificate-nginx',
              domainId: webDomainId,
              certificateId,
              domainRevision: provisioningRevision,
              nginxChecksum: checksum,
              nginxConfigName: 'yunpanel-example.com.conf',
              httpsRedirect: true,
              canonicalRedirect: false,
            },
          },
        ],
      },
    ] : []),
  };

  const resolver = createMailDiscoveryEndpointResolver({
    mailDiscoveryService,
    mailDiscoveryRuntime,
    websiteProvisioningRegistry,
  });

  // Succeeded provisioning matches current domain desiredRevision (2)
  const resolved = await resolver.resolve({ mailDomain, domain });
  assert.ok(resolved);
  assert.equal(resolved.autodiscover.hostname, 'example.com');
  assert.equal(resolved.autoconfig.hostname, 'example.com');

  // 5. When domain alias configuration updates, desiredRevision increments (e.g. to 3)
  domain.desiredRevision = 3;
  // Resolver immediately fails closed (returns null) because TLS route has not been staged/activated for revision 3
  const staleResolved = await resolver.resolve({ mailDomain, domain });
  assert.equal(staleResolved, null, 'Stale TLS route must not advertise discovery endpoints');

  // 6. When socket runtime is unavailable, resolver returns null
  provisioningRevision = 3;
  runtimeSocketReady = false;
  const runtimeDownResolved = await resolver.resolve({ mailDomain, domain });
  assert.equal(runtimeDownResolved, null, 'Unavailable runtime socket must fail closed');
});

test('hosting settings beyond basic redirects and T-DEV-HOSTING enforce tenant boundaries, locks and validation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-hosting-ext-test-'));
  try {
    const lock = createSiteMutationLock({ root, pid: 3001, signalProcess: () => true });
    const serverId = randomUUID();
    const websiteA = randomUUID();
    const websiteB = randomUUID();

    const websiteStore = new Map([
      [websiteA, { id: websiteA, serverId, runtimeType: 'static', documentRoot: '/var/www/siteA', customerId: 'cust-1' }],
      [websiteB, { id: websiteB, serverId, runtimeType: 'php', applicationId: randomUUID(), customerId: 'cust-2' }],
    ]);

    const domainRegistry = createDomainRegistry({
      getWebsite: async (id) => websiteStore.get(id) ?? null,
      serverExists: async (id) => id === serverId,
      siteMutationLock: lock,
    });

    // 1. Create domain bound to static websiteA
    const domainA = await domainRegistry.createDomain({
      serverId,
      websiteId: websiteA,
      primaryDomain: 'site-a.example.com',
      aliases: ['www.site-a.example.com'],
      targetType: 'static',
      target: { root: '/var/www/siteA' },
      httpsMode: 'managed',
      httpsRedirect: false,
      canonicalRedirect: false,
      nginxSettings: { spaFallback: true, headers: [] },
    });

    // 2. Validate websiteTargetMatches prevents targetType / runtime mismatch
    await assert.rejects(
      () => domainRegistry.createDomain({
        serverId,
        websiteId: websiteA,
        primaryDomain: 'mismatch.example.com',
        targetType: 'php',
        target: { applicationId: randomUUID() },
      }),
      (err) => err instanceof DomainRegistryError && err.code === 'domain_website_target_mismatch',
    );

    // 3. Setting httpsRedirect: true when httpsMode is 'off' fails closed
    await assert.rejects(
      () => domainRegistry.createDomain({
        serverId,
        websiteId: websiteA,
        primaryDomain: 'no-ssl.example.com',
        targetType: 'static',
        target: { root: '/var/www/siteA' },
        httpsMode: 'off',
        httpsRedirect: true,
      }),
      (err) => err instanceof DomainRegistryError && err.code === 'invalid_redirect_policy',
    );

    // 4. Updating nginxSettings beyond basic redirects (custom headers and spaFallback)
    const nginxPreview = await domainRegistry.previewDomainUpdate({
      domainId: domainA.id,
      changes: {
        nginxSettings: {
          spaFallback: true,
          headers: [{ name: 'X-Content-Type-Options', value: 'nosniff', always: false }],
        },
      },
    });
    assert.equal(nginxPreview.next.nginxSettings.headers.length, 1);
    assert.equal(nginxPreview.next.nginxSettings.headers[0].name, 'X-Content-Type-Options');

    const updateHandler = createDomainUpdateHandler(domainRegistry, {
      siteMutationLock: lock,
      localServerId: serverId,
    });

    const updateResp = responseRecorder();
    await updateHandler(
      {
        params: { domainId: domainA.id },
        body: {
          changes: {
            nginxSettings: {
              spaFallback: true,
              headers: [{ name: 'X-Content-Type-Options', value: 'nosniff', always: false }],
            },
          },
          previewDigest: nginxPreview.previewDigest,
          confirmation: nginxPreview.confirmation,
        },
      },
      updateResp,
      (err) => { throw err; },
    );
    assert.equal(updateResp.payload.data.domain.nginxSettings.headers[0].name, 'X-Content-Type-Options');

    // 5. Active jobs in jobRegistry block domain update with 409 domain_update_operation_conflict
    const jobRegistry = {
      listJobs: async (filter) => {
        if (!filter || (filter.resourceType === 'domain' && filter.resourceId === domainA.id)) {
          return [{ id: 'job-1', status: 'queued', resourceType: 'domain', resourceId: domainA.id }];
        }
        return [];
      },
    };

    const blockedHandler = createDomainUpdateHandler(domainRegistry, {
      siteMutationLock: lock,
      localServerId: serverId,
      jobRegistry,
    });

    let conflictError = null;
    await blockedHandler(
      {
        params: { domainId: domainA.id },
        body: {
          changes: { httpsRedirect: true },
          previewDigest: '0'.repeat(64),
          confirmation: 'dummy',
        },
      },
      responseRecorder(),
      (err) => { conflictError = err; },
    );
    assert.equal(conflictError?.code, 'domain_update_operation_conflict');
    assert.equal(conflictError?.status, 409);

    // 6. Tenant boundary isolation (createSiteResourceBoundary):
    const siteResourceBoundary = createSiteResourceBoundary({
      websiteRegistry: {
        getWebsite: async (id) => websiteStore.get(id) ?? null,
        listWebsites: async () => Array.from(websiteStore.values()),
      },
      domainRegistry,
      localServerId: serverId,
    });

    async function checkBoundary(req) {
      let statusCode = 200;
      let responseBody = null;
      let nextCalled = false;
      const res = {
        status(s) { statusCode = s; return this; },
        json(b) { responseBody = b; return this; },
        setHeader() {},
      };
      await siteResourceBoundary(req, res, () => { nextCalled = true; });
      return { statusCode, responseBody, nextCalled };
    }

    // Customer 1 accessing own domain A -> allowed
    const customerAllowed = await checkBoundary({
      method: 'GET',
      url: `/api/domains/${domainA.id}`,
      auth: {
        user: { role: 'customer', id: 'cust-1', active: true, websiteIds: [websiteA] },
        access: { mode: 'site_management' },
        security: { managementAllowed: true },
      },
    });
    assert.equal(customerAllowed.nextCalled, true);

    // Customer 1 attempting to access/update domain B of Customer 2 -> 403 site_scope_forbidden
    const domainB = await domainRegistry.createDomain({
      serverId,
      websiteId: websiteB,
      primaryDomain: 'site-b.example.com',
      aliases: [],
      targetType: 'php',
      target: { applicationId: websiteStore.get(websiteB).applicationId },
      httpsMode: 'managed',
    });

    const crossCustomerDenied = await checkBoundary({
      method: 'PATCH',
      url: `/api/domains/${domainB.id}`,
      auth: {
        user: { role: 'customer', id: 'cust-1', active: true, websiteIds: [websiteA] },
        access: { mode: 'site_management' },
        security: { managementAllowed: true },
      },
    });
    assert.equal(crossCustomerDenied.statusCode, 403);
    assert.equal(crossCustomerDenied.responseBody?.error?.code, 'site_scope_forbidden');
    assert.equal(crossCustomerDenied.nextCalled, false);

    // Inactive customer account -> 403 site_scope_forbidden
    const inactiveDenied = await checkBoundary({
      method: 'GET',
      url: `/api/domains/${domainA.id}`,
      auth: {
        user: { role: 'customer', id: 'cust-1', active: false, websiteIds: [websiteA] },
        access: { mode: 'site_management' },
        security: { managementAllowed: true },
      },
    });
    assert.equal(inactiveDenied.statusCode, 403);
    assert.equal(inactiveDenied.responseBody?.error?.code, 'site_scope_forbidden');

    // Unattached domain (no websiteId) -> 403 site_scope_forbidden for site-scoped accounts
    const unattachedDomain = await domainRegistry.createDomain({
      serverId,
      primaryDomain: 'unattached.example.com',
      targetType: 'static',
      target: { root: '/var/www/unattached' },
    });
    const unattachedDenied = await checkBoundary({
      method: 'GET',
      url: `/api/domains/${unattachedDomain.id}`,
      auth: {
        user: { role: 'customer', id: 'cust-1', active: true, websiteIds: [websiteA] },
        access: { mode: 'site_management' },
        security: { managementAllowed: true },
      },
    });
    assert.equal(unattachedDenied.statusCode, 403);
    assert.equal(unattachedDenied.responseBody?.error?.code, 'site_scope_forbidden');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
