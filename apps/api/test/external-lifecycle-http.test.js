import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createDnsHostingRegistry } from '../src/dns-hosting-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
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
  const mailDomainRegistry = createMailDomainRegistry({ getWebDomain });
  return { registry, websiteRegistry, domainRegistry, dnsHostingRegistry, mailDomainRegistry, domain };
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
  assert.equal((await state.dnsHostingRegistry.listZones()).length, 0);
  assert.equal((await state.mailDomainRegistry.listMailDomains()).length, 0);
  const app = withPanelContext(createApp({ ...state, environment: 'production' }), ownerManagementContext);
  await withServer(app, async (baseUrl) => {
    const input = { name: 'SEPARATE.example.test.', webDomainId: state.domain.id, managementMode: 'external' };
    const dnsResponse = await request(baseUrl, '/api/dns-zones', { method: 'POST', body: input });
    assert.equal(dnsResponse.status, 201);
    const dnsPayload = await dnsResponse.json();
    assert.equal(dnsPayload.data.zoneName, 'separate.example.test');
    assert.equal(dnsPayload.data.status, 'unverified');
    assert.deepEqual(dnsPayload.sideEffects, { dnsPublished: false });

    const mailResponse = await request(baseUrl, '/api/mail-domains', { method: 'POST', body: input });
    assert.equal(mailResponse.status, 201);
    const mailPayload = await mailResponse.json();
    assert.equal(mailPayload.data.domainName, dnsPayload.data.zoneName);
    assert.notEqual(mailPayload.data.id, dnsPayload.data.id);
    assert.deepEqual(mailPayload.sideEffects, { mailConfigured: false, mailboxesCreated: false });

    assert.equal((await request(baseUrl, `/api/dns-zones/${dnsPayload.data.id}`)).status, 200);
    assert.equal((await request(baseUrl, `/api/mail-domains/${mailPayload.data.id}`)).status, 200);
    const hiddenStatus = await request(baseUrl, '/api/dns-zones', {
      method: 'POST', body: { ...input, status: 'ready' },
    });
    assert.equal(hiddenStatus.status, 400);
    assert.equal((await hiddenStatus.json()).error.code, 'external_lifecycle_input_invalid');
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
    assert.equal((await request(baseUrl, '/api/mail-domains')).status, 200);
    assert.equal((await request(baseUrl, '/api/mail-domains', {
      method: 'POST',
      body: { name: state.domain.primaryDomain, webDomainId: state.domain.id, managementMode: 'external' },
    })).status, 403);
  });
});
