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
import { createServerRegistry } from '../src/server-registry.js';
import { createSiteMutationLock } from '../src/site-mutation-lock.js';

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
