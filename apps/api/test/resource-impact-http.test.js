import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createCertificateRegistry } from '../src/certificate-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
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
  const enrollment = await registry.issueEnrollmentToken({ label: 'impact-http' });
  const enrolled = await registry.enrollServer({ token: enrollment.token, hostname: 'impact-http-host' });
  const applicationRegistry = createApplicationRegistry({ serverExists: async (id) => Boolean(await registry.getServer(id)) });
  const websiteRegistry = createWebsiteRegistry({
    serverExists: async (id) => Boolean(await registry.getServer(id)),
    getApplication: async (id) => applicationRegistry.getApplication(id),
  });
  const domainRegistry = createDomainRegistry({
    serverExists: async (id) => Boolean(await registry.getServer(id)),
    getWebsite: async (id) => websiteRegistry.getWebsite(id),
  });
  const certificateRegistry = createCertificateRegistry();
  const jobRegistry = createJobRegistry();
  const website = await websiteRegistry.createWebsite({
    serverId: enrolled.server.id,
    name: 'Impact HTTP',
    runtimeType: 'proxy',
    proxyTarget: { host: 'origin.example.test', port: 8443 },
  });
  const domain = await domainRegistry.createDomain({
    serverId: enrolled.server.id,
    websiteId: website.id,
    primaryDomain: 'impact-http.example.test',
    targetType: 'proxy',
    target: { upstreamHost: 'origin.example.test', upstreamPort: 8443 },
  });
  return { registry, applicationRegistry, websiteRegistry, domainRegistry, certificateRegistry, jobRegistry, website, domain };
}

function request(baseUrl, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('Owner receives fail-closed Website and Domain impact previews without a mutation endpoint', async () => {
  const state = await fixture();
  const app = withPanelContext(createApp({ ...state, environment: 'production' }), ownerManagementContext);
  await withServer(app, async (baseUrl) => {
    const websiteResponse = await request(baseUrl, `/api/websites/${state.website.id}/impact-preview`, { operation: 'delete' });
    assert.equal(websiteResponse.status, 200);
    const websitePreview = (await websiteResponse.json()).data;
    assert.equal(websitePreview.dependencies.linkedDomains[0].id, state.domain.id);
    assert.deepEqual(websitePreview.dependencies.dockerWorkloads, { status: 'available', items: [] });
    assert.deepEqual(websitePreview.dependencies.mailboxes, { status: 'available', items: [] });
    assert.equal(websitePreview.applySupported, false);
    assert.equal(websitePreview.safeToApply, false);

    const domainResponse = await request(baseUrl, `/api/domains/${state.domain.id}/impact-preview`, { operation: 'delete' });
    assert.equal(domainResponse.status, 200);
    assert.equal((await domainResponse.json()).data.dependencies.website.id, state.website.id);

    const hiddenField = await request(baseUrl, `/api/domains/${state.domain.id}/impact-preview`, { operation: 'delete', cascade: true });
    assert.equal(hiddenField.status, 400);
    assert.equal((await hiddenField.json()).error.code, 'impact_input_invalid');
    assert.equal(await state.domainRegistry.getDomain(state.domain.id).then((value) => value.id), state.domain.id);
  });
});

test('production Domain delete impact includes injected authoritative DNS retirement evidence', async () => {
  const state = await fixture();
  let calls = 0;
  const dnsZoneRetirementImpactService = {
    preview: async ({ domainId }) => {
      calls += 1;
      return {
        version: 1,
        operation: 'dns_zone_retirement_impact',
        domain: { id: domainId, serverId: state.domain.serverId, primaryDomain: state.domain.primaryDomain },
        hierarchy: { descendantCount: 0, descendants: [] },
        routing: {
          active: false,
          stagedRevision: 0,
          appliedRevision: 0,
          appliedPrimaryDomain: null,
        },
        zone: {
          exists: true,
          snapshotDigest: 'a'.repeat(64),
          kind: 'Primary',
          dnssec: false,
          rrsetCount: 4,
          managedRrsetCount: 4,
          manualRrsetCount: 0,
          ownership: 'provisioning_created',
          ownershipOrigin: {
            status: 'provisioning_created',
            operationId: '52345678-1234-4234-8234-123456789012',
            updatedAt: '2026-09-18T16:00:00.000Z',
            evidenceDigest: 'b'.repeat(64),
          },
        },
        blockers: ['dns_zone_delete_retention_policy_required'],
        retirementPlanReady: false,
        previewDigest: 'c'.repeat(64),
        confirmation: null,
        sideEffects: false,
      };
    },
  };
  const app = withPanelContext(createApp({
    ...state,
    environment: 'production',
    dnsZoneRetirementImpactService,
  }), ownerManagementContext);

  await withServer(app, async (baseUrl) => {
    const response = await request(
      baseUrl,
      `/api/domains/${state.domain.id}/impact-preview`,
      { operation: 'delete' },
    );
    assert.equal(response.status, 200);
    const preview = (await response.json()).data;
    assert.equal(calls, 1);
    assert.deepEqual(preview.dependencies.authoritativeDns, {
      status: 'available',
      items: [{
        domainId: state.domain.id,
        state: 'blocked',
        previewDigest: 'c'.repeat(64),
        zoneSnapshotDigest: 'a'.repeat(64),
        blockers: ['dns_zone_delete_retention_policy_required'],
      }],
    });
    assert.ok(preview.blockers.some((item) => (
      item.code === 'authoritative_dns_retirement_blocked'
      && item.resourceType === 'authoritative_dns'
      && item.count === 1
    )));
  });
});

test('anonymous and Read Only requests cannot enter impact preview POST routes', async () => {
  const state = await fixture();
  await withServer(createApp({ ...state, environment: 'production' }), async (baseUrl) => {
    assert.equal((await request(baseUrl, `/api/websites/${state.website.id}/impact-preview`, { operation: 'delete' })).status, 401);
  });
  const app = withPanelContext(createApp({ ...state, environment: 'production' }), readOnlyManagementContext);
  await withServer(app, async (baseUrl) => {
    assert.equal((await request(baseUrl, `/api/websites/${state.website.id}/impact-preview`, { operation: 'delete' })).status, 403);
    assert.equal((await request(baseUrl, `/api/domains/${state.domain.id}/impact-preview`, { operation: 'delete' })).status, 403);
  });
});
