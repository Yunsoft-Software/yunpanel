import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createDnsHostingRegistry } from '../src/dns-hosting-registry.js';
import { createDnsProviderCredentialRegistry } from '../src/dns-provider-credential-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createMailDomainRegistry } from '../src/mail-domain-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createWebsiteRegistry } from '../src/website-registry.js';
import { ownerManagementContext, readOnlyManagementContext, withPanelContext } from './helpers/panel-auth-fixture.js';

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function fixture() {
  const registry = createServerRegistry();
  const enrollment = await registry.issueEnrollmentToken({ label: 'external-lifecycle-http' });
  const enrolled = await registry.enrollServer({ token: enrollment.token, hostname: 'external-lifecycle-http' });
  const websiteRegistry = createWebsiteRegistry({ serverExists: async (id) => Boolean(await registry.getServer(id)) });
  const domainRegistry = createDomainRegistry({
    serverExists: async (id) => Boolean(await registry.getServer(id)),
    getWebsite: async (id) => websiteRegistry.getWebsite(id),
  });
  const website = await websiteRegistry.createWebsite({ serverId: enrolled.server.id, name: 'Web', runtimeType: 'proxy' });
  const domain = await domainRegistry.createDomain({
    serverId: enrolled.server.id,
    websiteId: website.id,
    primaryDomain: 'separate.example.test',
    targetType: 'proxy',
    target: { upstreamPort: 8400 },
  });
  const getWebDomain = async (id) => domainRegistry.getDomain(id);
  const dnsHostingRegistry = createDnsHostingRegistry({ getWebDomain });
  const dnsProviderCredentialRegistry = createDnsProviderCredentialRegistry({
    masterKey: randomBytes(32),
    getDnsZone: async (id) => dnsHostingRegistry.getZone(id),
  });
  const mailDomainRegistry = createMailDomainRegistry({ getWebDomain });
  const jobRegistry = createJobRegistry();
  return {
    registry, websiteRegistry, domainRegistry, dnsHostingRegistry, dnsProviderCredentialRegistry, mailDomainRegistry,
    jobRegistry, domain,
  };
}

function request(baseUrl, pathname, { method = 'GET', body } = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('Owner explicitly tracks separate DNS and mail lifecycles without publishing or provisioning', async () => {
  const state = await fixture();
  const inspectedZoneIds = [];
  let routingReady = true;
  const dnsReadinessService = {
    async inspectZone(dnsZoneId) {
      inspectedZoneIds.push(dnsZoneId);
      return {
        dnsZoneId,
        observedAt: '2026-09-11T08:30:00.000Z',
        routing: routingReady
          ? { ready: true, reasonCodes: [], action: null }
          : { ready: false, reasonCodes: ['dns_target_mismatch'], action: 'correct_public_dns_records' },
        acme: {
          http01: { ready: false, reasonCodes: ['dns_http_domain_not_active'], action: 'activate_domain_for_http01' },
          dns01: { ready: true, provider: 'cloudflare', reasonCodes: [], action: null },
        },
      };
    },
  };
  assert.equal((await state.dnsHostingRegistry.listZones()).length, 0);
  assert.equal((await state.mailDomainRegistry.listMailDomains()).length, 0);
  const app = withPanelContext(createApp({ ...state, dnsReadinessService, environment: 'production' }), ownerManagementContext);
  await withServer(app, async (baseUrl) => {
    const input = { name: 'SEPARATE.example.test.', webDomainId: state.domain.id, managementMode: 'external' };
    const dnsResponse = await request(baseUrl, '/api/dns-zones', { method: 'POST', body: input });
    assert.equal(dnsResponse.status, 201);
    const dnsPayload = await dnsResponse.json();
    assert.equal(dnsPayload.data.zoneName, 'separate.example.test');
    assert.equal(dnsPayload.data.status, 'unverified');
    assert.deepEqual(dnsPayload.sideEffects, { dnsPublished: false });

    const providerToken = 'cloudflare_token_private_http_123456';
    const credentialResponse = await request(baseUrl, `/api/dns-zones/${dnsPayload.data.id}/provider-credential`, {
      method: 'PUT',
      body: {
        provider: 'cloudflare',
        token: providerToken,
        confirmation: `configure-dns-provider:${dnsPayload.data.id}:cloudflare`,
      },
    });
    assert.equal(credentialResponse.status, 200);
    const credential = (await credentialResponse.json()).data;
    assert.equal(credential.provider, 'cloudflare');
    assert.equal('token' in credential, false);
    assert.doesNotMatch(JSON.stringify(credential), new RegExp(providerToken));
    assert.equal((await state.dnsProviderCredentialRegistry.materialize(credential.id)).token, providerToken);
    const credentialRead = await request(baseUrl, `/api/dns-zones/${dnsPayload.data.id}/provider-credential`);
    assert.equal(credentialRead.status, 200);
    assert.equal((await credentialRead.json()).data.id, credential.id);

    const readinessResponse = await request(baseUrl, `/api/dns-zones/${dnsPayload.data.id}/readiness/refresh`, {
      method: 'POST', body: { expectedRevision: 1 },
    });
    assert.equal(readinessResponse.status, 200);
    const readinessPayload = (await readinessResponse.json()).data;
    assert.equal(readinessPayload.zone.status, 'ready');
    assert.equal(readinessPayload.zone.revision, 2);
    assert.equal(readinessPayload.zone.lastErrorCode, null);
    assert.equal(readinessPayload.readiness.acme.http01.ready, false);
    assert.deepEqual(inspectedZoneIds, [dnsPayload.data.id]);

    routingReady = false;
    const degradedResponse = await request(baseUrl, `/api/dns-zones/${dnsPayload.data.id}/readiness/refresh`, {
      method: 'POST', body: { expectedRevision: 2 },
    });
    assert.equal(degradedResponse.status, 200);
    const degradedZone = (await degradedResponse.json()).data.zone;
    assert.equal(degradedZone.status, 'degraded');
    assert.equal(degradedZone.revision, 3);
    assert.equal(degradedZone.lastErrorCode, 'dns_target_mismatch');
    assert.deepEqual(inspectedZoneIds, [dnsPayload.data.id, dnsPayload.data.id]);

    const staleReadiness = await request(baseUrl, `/api/dns-zones/${dnsPayload.data.id}/readiness/refresh`, {
      method: 'POST', body: { expectedRevision: 2 },
    });
    assert.equal(staleReadiness.status, 409);
    assert.equal((await staleReadiness.json()).error.code, 'dns_zone_revision_conflict');
    const invalidReadiness = await request(baseUrl, `/api/dns-zones/${dnsPayload.data.id}/readiness/refresh`, {
      method: 'POST', body: { expectedRevision: 3, status: 'ready' },
    });
    assert.equal(invalidReadiness.status, 400);
    assert.equal((await invalidReadiness.json()).error.code, 'dns_readiness_input_invalid');

    const mailResponse = await request(baseUrl, '/api/mail-domains', { method: 'POST', body: input });
    assert.equal(mailResponse.status, 201);
    const mailPayload = await mailResponse.json();
    assert.equal(mailPayload.data.domainName, dnsPayload.data.zoneName);
    assert.notEqual(mailPayload.data.id, dnsPayload.data.id);
    assert.deepEqual(mailPayload.sideEffects, { mailConfigured: false, mailboxesCreated: false });

    const mailPreviewResponse = await request(baseUrl, `/api/mail-domains/${mailPayload.data.id}/config-preview`);
    assert.equal(mailPreviewResponse.status, 200);
    const mailPreview = (await mailPreviewResponse.json()).data;
    assert.equal(mailPreview.operation, 'mail_configuration_preview');
    assert.equal(mailPreview.mailDomainId, mailPayload.data.id);
    assert.equal(mailPreview.domainName, 'separate.example.test');
    assert.equal(mailPreview.expectedRevision, 1);
    assert.equal(mailPreview.scope, 'candidate_domain_only');
    assert.equal(mailPreview.readyToApply, false);
    assert.equal(mailPreview.sideEffects, false);
    assert.match(mailPreview.previewDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(mailPreview.blockers.map((entry) => entry.code), ['mail_domain_management_mode_external']);
    assert.deepEqual(mailPreview.candidateArtifacts, [{
      version: 1,
      path: '/etc/yunpanel/mail/postfix/virtual-domains',
      lookup: 'hash:/etc/yunpanel/mail/postfix/virtual-domains',
      sha256: 'a9f8da608e67a32b6f2762510b6fbe7f791028bab231c9f4127eebeea4035286',
      bytes: 25,
      entries: 1,
      content: 'separate.example.test OK\n',
      compile: { file: '/usr/sbin/postmap', args: ['hash:/etc/yunpanel/mail/postfix/virtual-domains'] },
      validate: { file: '/usr/sbin/postfix', args: ['check'] },
      sideEffects: false,
    }]);

    assert.equal((await request(baseUrl, `/api/dns-zones/${dnsPayload.data.id}`)).status, 200);
    assert.equal((await request(baseUrl, `/api/mail-domains/${mailPayload.data.id}`)).status, 200);
    const hiddenStatus = await request(baseUrl, '/api/dns-zones', {
      method: 'POST', body: { ...input, status: 'ready' },
    });
    assert.equal(hiddenStatus.status, 400);
    assert.equal((await hiddenStatus.json()).error.code, 'external_lifecycle_input_invalid');
  });
});

test('Owner previews and queues an exact Cloudflare record mutation without exposing its token', async () => {
  const state = await fixture();
  const zone = await state.dnsHostingRegistry.createZone({
    zoneName: state.domain.primaryDomain, webDomainId: state.domain.id, managementMode: 'external',
  });
  const token = 'cloudflare_private_record_http_token';
  const credential = await state.dnsProviderCredentialRegistry.setCredential({
    dnsZoneId: zone.id, provider: 'cloudflare', token,
  });
  const inspections = [];
  const record = { type: 'A', name: 'app.separate.example.test', content: '203.0.113.10', ttl: 300, proxied: false };
  const dnsRecordManager = {
    async inspectRecord(input, execution) {
      inspections.push({ input, execution });
      return {
        provider: 'cloudflare', zoneName: zone.zoneName, desired: { ...record }, records: [],
        snapshotDigest: 'a'.repeat(64),
      };
    },
  };
  const app = withPanelContext(createApp({
    ...state,
    dnsRecordManager,
    localServerId: state.domain.serverId,
    environment: 'production',
  }), ownerManagementContext);

  await withServer(app, async (baseUrl) => {
    const previewResponse = await request(baseUrl, `/api/dns-zones/${zone.id}/records/preview`, {
      method: 'POST', body: { action: 'upsert', record, expectedRevision: zone.revision },
    });
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()).data;
    assert.equal(preview.effect, 'create');
    assert.equal(preview.credentialId, credential.id);
    assert.deepEqual(preview.currentRecords, []);
    assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(preview).includes(token), false);

    const wrongConfirmation = await request(baseUrl, `/api/dns-zones/${zone.id}/records/apply`, {
      method: 'POST',
      body: {
        action: 'upsert', record, expectedRevision: zone.revision,
        previewDigest: preview.previewDigest, confirmation: 'wrong',
      },
    });
    assert.equal(wrongConfirmation.status, 400);
    assert.equal((await wrongConfirmation.json()).error.code, 'dns_record_confirmation_required');
    assert.equal((await state.jobRegistry.listJobs()).length, 0);

    const applyResponse = await request(baseUrl, `/api/dns-zones/${zone.id}/records/apply`, {
      method: 'POST',
      body: {
        action: 'upsert', record, expectedRevision: zone.revision,
        previewDigest: preview.previewDigest, confirmation: preview.confirmation,
      },
    });
    assert.equal(applyResponse.status, 202);
    const queued = (await applyResponse.json()).data;
    assert.equal(queued.previewDigest, preview.previewDigest);
    assert.equal(queued.job.resourceType, 'dns_zone');
    assert.equal(queued.job.resourceId, zone.id);
    assert.equal(JSON.stringify(queued).includes(token), false);

    const claimed = await state.jobRegistry.claimNext(state.domain.serverId);
    assert.equal(claimed.envelope.operation, 'dns.record.apply');
    assert.deepEqual(claimed.envelope.payload.record, record);
    assert.equal(claimed.envelope.payload.credentialId, credential.id);
    assert.equal(JSON.stringify(claimed).includes(token), false);

    const readinessWhileRunning = await request(baseUrl, `/api/dns-zones/${zone.id}/readiness/refresh`, {
      method: 'POST', body: { expectedRevision: zone.revision },
    });
    assert.equal(readinessWhileRunning.status, 409);
    assert.equal((await readinessWhileRunning.json()).error.code, 'dns_zone_job_conflict');
    const deleteCredential = await request(baseUrl, `/api/dns-zones/${zone.id}/provider-credential`, {
      method: 'DELETE', body: { confirmation: `delete-dns-provider:${zone.id}` },
    });
    assert.equal(deleteCredential.status, 409);
    assert.equal((await deleteCredential.json()).error.code, 'dns_zone_job_conflict');
  });

  assert.equal(inspections.length, 3);
  assert.ok(inspections.every(({ execution }) => execution.dnsCredential.token === token));
  assert.ok(inspections.every(({ input }) => input.dnsZoneId === zone.id && input.credentialId === credential.id));
});

test('DNS record apply detects provider snapshot drift before queueing', async () => {
  const state = await fixture();
  const zone = await state.dnsHostingRegistry.createZone({
    zoneName: state.domain.primaryDomain, webDomainId: state.domain.id, managementMode: 'external',
  });
  await state.dnsProviderCredentialRegistry.setCredential({
    dnsZoneId: zone.id, provider: 'cloudflare', token: 'cloudflare_private_snapshot_token',
  });
  let inspections = 0;
  const record = { type: 'CNAME', name: 'app.separate.example.test', content: zone.zoneName, ttl: 300, proxied: false };
  const dnsRecordManager = {
    async inspectRecord() {
      inspections += 1;
      return {
        provider: 'cloudflare', zoneName: zone.zoneName, desired: record, records: [],
        snapshotDigest: (inspections === 1 ? 'a' : 'b').repeat(64),
      };
    },
  };
  const app = withPanelContext(createApp({
    ...state, dnsRecordManager, localServerId: state.domain.serverId, environment: 'production',
  }), ownerManagementContext);
  await withServer(app, async (baseUrl) => {
    const preview = (await (await request(baseUrl, `/api/dns-zones/${zone.id}/records/preview`, {
      method: 'POST', body: { action: 'upsert', record, expectedRevision: zone.revision },
    })).json()).data;
    const applied = await request(baseUrl, `/api/dns-zones/${zone.id}/records/apply`, {
      method: 'POST',
      body: {
        action: 'upsert', record, expectedRevision: zone.revision,
        previewDigest: preview.previewDigest, confirmation: preview.confirmation,
      },
    });
    assert.equal(applied.status, 409);
    assert.equal((await applied.json()).error.code, 'dns_record_preview_stale');
    assert.equal((await state.jobRegistry.listJobs()).length, 0);
  });
});

test('Read Only may inspect lifecycle inventory but cannot create it', async () => {
  const state = await fixture();
  const zone = await state.dnsHostingRegistry.createZone({
    zoneName: state.domain.primaryDomain, webDomainId: state.domain.id, managementMode: 'external',
  });
  const app = withPanelContext(createApp({ ...state, environment: 'production' }), readOnlyManagementContext);
  await withServer(app, async (baseUrl) => {
    const list = await request(baseUrl, '/api/dns-zones');
    assert.equal(list.status, 200);
    assert.equal((await list.json()).data[0].id, zone.id);
    assert.equal((await request(baseUrl, `/api/dns-zones/${zone.id}`)).status, 200);
    assert.equal((await request(baseUrl, `/api/dns-zones/${zone.id}/provider-credential`)).status, 403);
    assert.equal((await request(baseUrl, '/api/mail-domains')).status, 200);
    assert.equal((await request(baseUrl, '/api/mail-domains', {
      method: 'POST',
      body: { name: state.domain.primaryDomain, webDomainId: state.domain.id, managementMode: 'external' },
    })).status, 403);
    assert.equal((await request(baseUrl, `/api/dns-zones/${zone.id}/provider-credential`, {
      method: 'PUT',
      body: {
        provider: 'cloudflare', token: 'cloudflare_token_private_http_123456',
        confirmation: `configure-dns-provider:${zone.id}:cloudflare`,
      },
    })).status, 403);
    assert.equal((await request(baseUrl, `/api/dns-zones/${zone.id}/readiness/refresh`, {
      method: 'POST', body: { expectedRevision: zone.revision },
    })).status, 403);
    assert.equal((await request(baseUrl, `/api/dns-zones/${zone.id}/records/preview`, {
      method: 'POST',
      body: {
        action: 'upsert', expectedRevision: zone.revision,
        record: { type: 'A', name: zone.zoneName, content: '203.0.113.10', ttl: 300, proxied: false },
      },
    })).status, 403);
  });
});
