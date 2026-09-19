import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createDnsHostingRegistry } from '../src/dns-hosting-registry.js';
import { createDnsProviderCredentialRegistry } from '../src/dns-provider-credential-registry.js';
import { createDnsRequirementsService } from '../src/dns-requirements-service.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createMailDomainRegistry } from '../src/mail-domain-registry.js';
import { createMailDkimRegistry } from '../src/mail-dkim-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createWebsiteRegistry } from '../src/website-registry.js';

async function fixture({ ipv6 = true } = {}) {
  const serverRegistry = createServerRegistry();
  const server = await serverRegistry.createLocalServer({ hostname: 'dns-requirements-test' });
  const serverId = server.id;

  // Add network inventory to server
  const network = [
    { interface: 'eth0', family: 'IPv4', address: '203.0.113.10' },
  ];
  if (ipv6) {
    network.push({ interface: 'eth0', family: 'IPv6', address: '2001:0db8:0:0:0:0:0:10' });
  }
  await serverRegistry.updateLocalSnapshot({
    serverId,
    hostname: 'dns-requirements-test',
    inventory: { network },
  });

  const websiteRegistry = createWebsiteRegistry({ serverExists: async (id) => Boolean(await serverRegistry.getServer(id)) });
  const domainRegistry = createDomainRegistry({
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
    getWebsite: async (id) => websiteRegistry.getWebsite(id),
  });

  const website = await websiteRegistry.createWebsite({ serverId, name: 'WebSite', runtimeType: 'proxy' });
  const domain = await domainRegistry.createDomain({
    serverId,
    websiteId: website.id,
    primaryDomain: 'example.com',
    aliases: ['www.example.com'],
    targetType: 'proxy',
    target: { upstreamPort: 8400 },
  });

  const dnsHostingRegistry = createDnsHostingRegistry({
    getWebDomain: async (id) => domainRegistry.getDomain(id),
  });
  const zone = await dnsHostingRegistry.createZone({
    zoneName: domain.primaryDomain,
    webDomainId: domain.id,
    managementMode: 'external',
  });

  const dnsProviderCredentialRegistry = createDnsProviderCredentialRegistry({
    masterKey: randomBytes(32),
    getDnsZone: async (id) => dnsHostingRegistry.getZone(id),
  });

  const mailDomainRegistry = createMailDomainRegistry({
    getWebDomain: async (id) => domainRegistry.getDomain(id),
  });

  const mailDkimRegistry = createMailDkimRegistry({
    getMailDomain: async (id) => mailDomainRegistry.getMailDomain(id),
  });

  const jobRegistry = createJobRegistry();

  return {
    serverRegistry,
    domainRegistry,
    websiteRegistry,
    dnsHostingRegistry,
    dnsProviderCredentialRegistry,
    mailDomainRegistry,
    mailDkimRegistry,
    jobRegistry,
    serverId,
    website,
    domain,
    zone,
  };
}

test('inspectZoneRequirements generates web routing requirements and evaluates via public DNS when no provider configured', async () => {
  const f = await fixture();

  const mockResolve4 = async (name) => {
    if (name === 'example.com') return ['203.0.113.10'];
    return [];
  };
  const mockResolve6 = async (name) => {
    if (name === 'example.com') return ['2001:db8::10'];
    return [];
  };
  const mockResolveCname = async (name) => {
    if (name === 'www.example.com') return ['example.com'];
    return [];
  };

  const service = createDnsRequirementsService({
    dnsHostingRegistry: f.dnsHostingRegistry,
    domainRegistry: f.domainRegistry,
    serverRegistry: f.serverRegistry,
    dnsProviderCredentialRegistry: f.dnsProviderCredentialRegistry,
    dnsRecordManager: { async inspectRecord() { return { records: [] }; } },
    jobRegistry: f.jobRegistry,
    localServerId: f.serverId,
    resolve4: mockResolve4,
    resolve6: mockResolve6,
    resolveCname: mockResolveCname,
  });

  const result = await service.inspectZoneRequirements(f.zone.id);

  assert.equal(result.dnsZoneId, f.zone.id);
  assert.equal(result.zoneName, 'example.com');
  assert.equal(result.providerConfigured, false);
  assert.equal(result.provider, null);
  assert.equal(result.ready, true);
  assert.equal(result.summary.total, 3);
  assert.equal(result.summary.fulfilled, 3);
  assert.equal(result.summary.pending, 0);

  const keys = result.requirements.map((r) => r.key);
  assert.deepEqual(keys, ['web-apex-a', 'web-apex-aaaa', 'web-alias-www-example-com-cname']);
  assert.equal(result.requirements[0].status, 'fulfilled');
  assert.equal(result.requirements[1].status, 'fulfilled');
  assert.equal(result.requirements[2].status, 'fulfilled');
});

test('inspectZoneRequirements surfaces pending status when public DNS records are unresolved', async () => {
  const f = await fixture();

  const service = createDnsRequirementsService({
    dnsHostingRegistry: f.dnsHostingRegistry,
    domainRegistry: f.domainRegistry,
    serverRegistry: f.serverRegistry,
    dnsProviderCredentialRegistry: f.dnsProviderCredentialRegistry,
    dnsRecordManager: { async inspectRecord() { return { records: [] }; } },
    jobRegistry: f.jobRegistry,
    localServerId: f.serverId,
    resolve4: async () => [],
    resolve6: async () => [],
    resolveCname: async () => [],
  });

  const result = await service.inspectZoneRequirements(f.zone.id);

  assert.equal(result.ready, false);
  assert.equal(result.summary.total, 3);
  assert.equal(result.summary.fulfilled, 0);
  assert.equal(result.summary.pending, 3);

  for (const req of result.requirements) {
    assert.equal(req.status, 'pending');
    assert.equal(req.reason, 'unresolved');
    assert.equal(req.effect, 'manual');
  }
});

test('inspectZoneRequirements includes local mail requirements when local mail domain is configured', async () => {
  const f = await fixture();

  const mailDomain = await f.mailDomainRegistry.createMailDomain({
    domainName: 'example.com',
    webDomainId: f.domain.id,
    managementMode: 'local',
  });

  // Store DKIM key
  await f.mailDkimRegistry.createKey(mailDomain.id, {
    expectedRevision: 0,
    selector: 'default',
  });

  const service = createDnsRequirementsService({
    dnsHostingRegistry: f.dnsHostingRegistry,
    domainRegistry: f.domainRegistry,
    serverRegistry: f.serverRegistry,
    dnsProviderCredentialRegistry: f.dnsProviderCredentialRegistry,
    dnsRecordManager: { async inspectRecord() { return { records: [] }; } },
    jobRegistry: f.jobRegistry,
    mailDomainRegistry: f.mailDomainRegistry,
    mailDkimRegistry: f.mailDkimRegistry,
    localServerId: f.serverId,
    resolve4: async () => [],
    resolve6: async () => [],
    resolveCname: async () => [],
    resolveTxt: async () => [],
    resolveMx: async () => [],
  });

  const result = await service.inspectZoneRequirements(f.zone.id);

  const keys = result.requirements.map((r) => r.key);
  assert.ok(keys.includes('web-apex-a'));
  assert.ok(keys.includes('web-apex-aaaa'));
  assert.ok(keys.includes('web-alias-www-example-com-cname'));
  assert.ok(keys.includes('mail-mx'));
  assert.ok(keys.includes('mail-spf'));
  assert.ok(keys.includes('mail-dmarc'));
  assert.ok(keys.includes('mail-host-a'));
  assert.ok(keys.includes('mail-host-aaaa'));
  assert.ok(keys.includes('webmail-a'));
  assert.ok(keys.includes('webmail-aaaa'));
  assert.ok(keys.includes('mail-dkim-default'));

  assert.equal(result.mailDomain.managementMode, 'local');
  assert.equal(result.mailDomain.status, 'disabled');
});

test('inspectZoneRequirements handles external mail domain without creating local mail server records', async () => {
  const f = await fixture();

  await f.mailDomainRegistry.createMailDomain({
    domainName: 'example.com',
    webDomainId: f.domain.id,
    managementMode: 'external',
  });

  const service = createDnsRequirementsService({
    dnsHostingRegistry: f.dnsHostingRegistry,
    domainRegistry: f.domainRegistry,
    serverRegistry: f.serverRegistry,
    dnsProviderCredentialRegistry: f.dnsProviderCredentialRegistry,
    dnsRecordManager: { async inspectRecord() { return { records: [] }; } },
    jobRegistry: f.jobRegistry,
    mailDomainRegistry: f.mailDomainRegistry,
    localServerId: f.serverId,
    resolve4: async () => ['203.0.113.10'],
    resolve6: async () => ['2001:db8::10'],
    resolveCname: async () => ['example.com'],
  });

  const result = await service.inspectZoneRequirements(f.zone.id);

  // Only web routing records exist
  assert.equal(result.requirements.length, 3);
  assert.deepEqual(result.requirements.map((r) => r.key), [
    'web-apex-a', 'web-apex-aaaa', 'web-alias-www-example-com-cname',
  ]);
  assert.equal(result.mailDomain.managementMode, 'external');
  assert.equal(result.mailDomain.status, 'unverified');
});

test('Cloudflare provider inspection evaluates missing, matching, mismatched, and conflict records', async () => {
  const f = await fixture();

  await f.dnsProviderCredentialRegistry.setCredential({
    dnsZoneId: f.zone.id,
    provider: 'cloudflare',
    token: 'cloudflare_test_token_1234567890',
  });

  const dnsRecordManager = {
    async inspectRecord({ record }) {
      if (record.name === 'example.com' && record.type === 'A') {
        // Matching record
        return {
          records: [{ type: 'A', name: 'example.com', content: '203.0.113.10', ttl: 300, proxied: false }],
          snapshotDigest: '1'.repeat(64),
        };
      }
      if (record.name === 'example.com' && record.type === 'AAAA') {
        // Mismatched record (wrong IP)
        return {
          records: [{ type: 'AAAA', name: 'example.com', content: '2001:db8::99', ttl: 300, proxied: false }],
          snapshotDigest: '2'.repeat(64),
        };
      }
      if (record.name === 'www.example.com' && record.type === 'CNAME') {
        // Missing record
        return {
          records: [],
          snapshotDigest: '3'.repeat(64),
        };
      }
      return { records: [], snapshotDigest: '4'.repeat(64) };
    },
  };

  const service = createDnsRequirementsService({
    dnsHostingRegistry: f.dnsHostingRegistry,
    domainRegistry: f.domainRegistry,
    serverRegistry: f.serverRegistry,
    dnsProviderCredentialRegistry: f.dnsProviderCredentialRegistry,
    dnsRecordManager,
    jobRegistry: f.jobRegistry,
    localServerId: f.serverId,
  });

  const result = await service.inspectZoneRequirements(f.zone.id);

  assert.equal(result.providerConfigured, true);
  assert.equal(result.provider, 'cloudflare');
  assert.equal(result.summary.total, 3);
  assert.equal(result.summary.fulfilled, 1);
  assert.equal(result.summary.pending, 2);
  assert.equal(result.summary.providerSupportedPending, 2);

  const apexA = result.requirements.find((r) => r.key === 'web-apex-a');
  assert.equal(apexA.status, 'fulfilled');
  assert.equal(apexA.effect, 'no_change');

  const apexAAAA = result.requirements.find((r) => r.key === 'web-apex-aaaa');
  assert.equal(apexAAAA.status, 'pending');
  assert.equal(apexAAAA.effect, 'update');
  assert.equal(apexAAAA.reason, 'mismatch');

  const wwwCname = result.requirements.find((r) => r.key === 'web-alias-www-example-com-cname');
  assert.equal(wwwCname.status, 'pending');
  assert.equal(wwwCname.effect, 'create');
  assert.equal(wwwCname.reason, 'missing');
});

test('previewRequirementsApply builds deterministic preview and respects keys filter', async () => {
  const f = await fixture();

  await f.dnsProviderCredentialRegistry.setCredential({
    dnsZoneId: f.zone.id,
    provider: 'cloudflare',
    token: 'cloudflare_test_token_1234567890',
  });

  const dnsRecordManager = {
    async inspectRecord({ record }) {
      return {
        records: [],
        snapshotDigest: '5'.repeat(64),
      };
    },
  };

  const service = createDnsRequirementsService({
    dnsHostingRegistry: f.dnsHostingRegistry,
    domainRegistry: f.domainRegistry,
    serverRegistry: f.serverRegistry,
    dnsProviderCredentialRegistry: f.dnsProviderCredentialRegistry,
    dnsRecordManager,
    jobRegistry: f.jobRegistry,
    localServerId: f.serverId,
  });

  // Preview all pending
  const previewAll = await service.previewRequirementsApply({
    dnsZoneId: f.zone.id,
    expectedRevision: f.zone.revision,
  });

  assert.equal(previewAll.operation, 'dns_requirements_apply');
  assert.equal(previewAll.readyToApply, true);
  assert.equal(previewAll.items.length, 3);
  assert.match(previewAll.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(previewAll.confirmation, `apply-dns-requirements:${f.zone.id}:${previewAll.previewDigest}`);

  // Preview with selected keys
  const previewSelected = await service.previewRequirementsApply({
    dnsZoneId: f.zone.id,
    expectedRevision: f.zone.revision,
    keys: ['web-apex-a'],
  });

  assert.equal(previewSelected.items.length, 1);
  assert.equal(previewSelected.items[0].key, 'web-apex-a');
  assert.notEqual(previewSelected.previewDigest, previewAll.previewDigest);

  // Unknown key rejected
  await assert.rejects(
    () => service.previewRequirementsApply({
      dnsZoneId: f.zone.id,
      expectedRevision: f.zone.revision,
      keys: ['nonexistent-key'],
    }),
    { code: 'dns_requirement_key_unknown' },
  );

  // Stale revision rejected
  await assert.rejects(
    () => service.previewRequirementsApply({
      dnsZoneId: f.zone.id,
      expectedRevision: 999,
    }),
    { code: 'dns_zone_revision_conflict' },
  );
});

test('applyRequirements enqueues dns.record.apply jobs and rejects stale previews', async () => {
  const f = await fixture();

  await f.dnsProviderCredentialRegistry.setCredential({
    dnsZoneId: f.zone.id,
    provider: 'cloudflare',
    token: 'cloudflare_test_token_1234567890',
  });

  const dnsRecordManager = {
    async inspectRecord({ record }) {
      return {
        records: [],
        snapshotDigest: '6'.repeat(64),
      };
    },
  };

  const service = createDnsRequirementsService({
    dnsHostingRegistry: f.dnsHostingRegistry,
    domainRegistry: f.domainRegistry,
    serverRegistry: f.serverRegistry,
    dnsProviderCredentialRegistry: f.dnsProviderCredentialRegistry,
    dnsRecordManager,
    jobRegistry: f.jobRegistry,
    localServerId: f.serverId,
  });

  const preview = await service.previewRequirementsApply({
    dnsZoneId: f.zone.id,
    expectedRevision: f.zone.revision,
  });

  // Rejects wrong confirmation
  await assert.rejects(
    () => service.applyRequirements({
      dnsZoneId: f.zone.id,
      expectedRevision: f.zone.revision,
      previewDigest: preview.previewDigest,
      confirmation: 'wrong-confirmation',
    }),
    { code: 'dns_requirements_confirmation_required' },
  );

  // Rejects wrong previewDigest
  await assert.rejects(
    () => service.applyRequirements({
      dnsZoneId: f.zone.id,
      expectedRevision: f.zone.revision,
      previewDigest: '0'.repeat(64),
      confirmation: preview.confirmation,
    }),
    { code: 'dns_requirements_preview_stale' },
  );

  // Rejects when multiple pending requirements exist without selecting a key
  await assert.rejects(
    () => service.applyRequirements({
      dnsZoneId: f.zone.id,
      expectedRevision: f.zone.revision,
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    }),
    { code: 'dns_requirements_key_required' },
  );

  // Preview single key
  const singlePreview = await service.previewRequirementsApply({
    dnsZoneId: f.zone.id,
    expectedRevision: f.zone.revision,
    key: 'web-apex-a',
  });

  // Successful apply with selected key
  const applied = await service.applyRequirements({
    dnsZoneId: f.zone.id,
    expectedRevision: f.zone.revision,
    previewDigest: singlePreview.previewDigest,
    confirmation: singlePreview.confirmation,
    key: 'web-apex-a',
  });

  assert.equal(applied.count, 1);
  assert.equal(applied.jobs.length, 1);
  assert.equal(applied.itemKey, 'web-apex-a');
  assert.equal(applied.previewDigest, singlePreview.previewDigest);

  const queued = await f.jobRegistry.listJobs({ resourceType: 'dns_zone', resourceId: f.zone.id });
  assert.equal(queued[0].operation, 'dns.record.apply');
  assert.equal(queued[0].type, 'dns.record.apply');
  assert.equal(queued[0].resourceType, 'dns_zone');
  assert.equal(queued[0].resourceId, f.zone.id);
  assert.equal(queued[0].status, 'queued');

  // Conflict while active job is present
  await assert.rejects(
    () => service.previewRequirementsApply({
      dnsZoneId: f.zone.id,
      expectedRevision: f.zone.revision,
    }),
    { code: 'dns_zone_job_conflict' },
  );
});

test('inspectDomainRequirements resolves linked zone or computes domain-level requirements', async () => {
  const f = await fixture();

  const service = createDnsRequirementsService({
    dnsHostingRegistry: f.dnsHostingRegistry,
    domainRegistry: f.domainRegistry,
    serverRegistry: f.serverRegistry,
    dnsProviderCredentialRegistry: f.dnsProviderCredentialRegistry,
    dnsRecordManager: { async inspectRecord() { return { records: [] }; } },
    jobRegistry: f.jobRegistry,
    localServerId: f.serverId,
    resolve4: async () => ['203.0.113.10'],
    resolve6: async () => ['2001:db8::10'],
    resolveCname: async () => ['example.com'],
  });

  // By domain ID with existing zone
  const withZone = await service.inspectDomainRequirements(f.domain.id);
  assert.equal(withZone.dnsZoneId, f.zone.id);
  assert.equal(withZone.zoneName, 'example.com');
  assert.equal(withZone.ready, true);

  // Unknown domain
  await assert.rejects(
    () => service.inspectDomainRequirements('00000000-0000-0000-0000-000000000000'),
    { code: 'domain_not_found' },
  );
});
