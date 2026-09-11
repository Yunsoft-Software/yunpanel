import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createCertificateRegistry } from '../src/certificate-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createDnsHostingRegistry } from '../src/dns-hosting-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createMailDomainRegistry } from '../src/mail-domain-registry.js';
import { previewResourceImpact, ResourceImpactError, resourceImpactInternals } from '../src/resource-impact.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createWebsiteRegistry } from '../src/website-registry.js';

async function fixture() {
  const registry = createServerRegistry();
  const firstToken = await registry.issueEnrollmentToken({ label: 'impact-source' });
  const first = await registry.enrollServer({ token: firstToken.token, hostname: 'impact-source' });
  const secondToken = await registry.issueEnrollmentToken({ label: 'impact-target' });
  const second = await registry.enrollServer({ token: secondToken.token, hostname: 'impact-target' });
  const applicationRegistry = createApplicationRegistry({ serverExists: async (id) => Boolean(await registry.getServer(id)) });
  const websiteRegistry = createWebsiteRegistry({
    serverExists: async (id) => Boolean(await registry.getServer(id)),
    getApplication: async (id) => applicationRegistry.getApplication(id),
  });
  const domainRegistry = createDomainRegistry({
    serverExists: async (id) => Boolean(await registry.getServer(id)),
    getWebsite: async (id) => websiteRegistry.getWebsite(id),
    websiteBindingRequired: () => true,
  });
  const certificateRegistry = createCertificateRegistry();
  const jobRegistry = createJobRegistry();
  await Promise.all([
    applicationRegistry.init(), websiteRegistry.init(), domainRegistry.init(), certificateRegistry.init(), jobRegistry.init(),
  ]);
  const application = await applicationRegistry.createApplication({
    serverId: first.server.id,
    name: 'Impact Application',
    repositoryUrl: 'https://github.com/example/impact-application',
  });
  const website = await websiteRegistry.createWebsite({
    serverId: first.server.id,
    name: 'Impact Website',
    applicationId: application.id,
  });
  const childWebsite = await websiteRegistry.createWebsite({
    serverId: first.server.id,
    name: 'Child Website',
    runtimeType: 'proxy',
    proxyTarget: { host: '127.0.0.1', port: 8400 },
  });
  const domain = await domainRegistry.createDomain({
    serverId: first.server.id,
    websiteId: website.id,
    primaryDomain: 'impact.example.test',
    aliases: ['www.impact.example.test'],
    targetType: 'static',
    target: { root: application.webRoot },
    httpsMode: 'managed',
  });
  const child = await domainRegistry.createDomain({
    serverId: first.server.id,
    websiteId: childWebsite.id,
    primaryDomain: 'api.impact.example.test',
    parentDomainId: domain.id,
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 8400 },
  });
  const certificate = await certificateRegistry.createForDomain({
    domainId: domain.id,
    serverId: first.server.id,
    domains: [domain.primaryDomain, ...domain.aliases],
    email: 'admin@example.test',
  });
  const job = await jobRegistry.enqueue({
    serverId: first.server.id,
    type: 'domain.stage',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: {
      primaryDomain: domain.primaryDomain,
      aliases: domain.aliases,
      targetType: domain.targetType,
      target: domain.target,
    },
    resourceType: 'domain',
    resourceId: domain.id,
  });
  const getWebDomain = async (id) => domainRegistry.getDomain(id);
  const dnsHostingRegistry = createDnsHostingRegistry({ getWebDomain });
  const mailDomainRegistry = createMailDomainRegistry({ getWebDomain });
  const dnsZone = await dnsHostingRegistry.createZone({
    zoneName: domain.primaryDomain,
    webDomainId: domain.id,
    managementMode: 'external',
  });
  const mailDomain = await mailDomainRegistry.createMailDomain({
    domainName: domain.primaryDomain,
    webDomainId: domain.id,
    managementMode: 'external',
  });
  return {
    registry,
    applicationRegistry,
    websiteRegistry,
    domainRegistry,
    certificateRegistry,
    jobRegistry,
    dnsHostingRegistry,
    mailDomainRegistry,
    sourceServerId: first.server.id,
    targetServerId: second.server.id,
    application,
    website,
    childWebsite,
    domain,
    child,
    certificate,
    job,
    dnsZone,
    mailDomain,
  };
}

function dependencies(state, additions = {}) {
  return {
    registry: state.registry,
    applicationRegistry: state.applicationRegistry,
    websiteRegistry: state.websiteRegistry,
    domainRegistry: state.domainRegistry,
    certificateRegistry: state.certificateRegistry,
    jobRegistry: state.jobRegistry,
    dnsHostingRegistry: state.dnsHostingRegistry,
    mailDomainRegistry: state.mailDomainRegistry,
    ...additions,
  };
}

test('Website impact preview lists real dependency graph and marks missing inventories as blockers', async () => {
  const state = await fixture();
  const preview = await previewResourceImpact({
    resourceType: 'website',
    resourceId: state.website.id,
    operation: 'delete',
    ...dependencies(state, {
      additionalProviders: {
        mailboxes: async (context) => {
          assert.equal(context.websiteId, state.website.id);
          assert.deepEqual(context.domainIds, [state.child.id, state.domain.id].sort());
          return [{ id: 'mailbox-1', state: 'active' }];
        },
      },
    }),
  });

  assert.equal(preview.resource.id, state.website.id);
  assert.deepEqual(preview.dependencies.linkedDomains.map((item) => item.id), [state.domain.id]);
  assert.deepEqual(preview.dependencies.childDomains.map((item) => item.id), [state.child.id]);
  assert.equal(preview.dependencies.application.id, state.application.id);
  assert.deepEqual(preview.dependencies.certificates.map((item) => item.id), [state.certificate.id]);
  assert.deepEqual(preview.dependencies.activeJobs.map((item) => item.id), [state.job.id]);
  assert.deepEqual(preview.dependencies.dnsZones.map((item) => item.id), [state.dnsZone.id]);
  assert.deepEqual(preview.dependencies.mailDomains.map((item) => item.id), [state.mailDomain.id]);
  assert.deepEqual(preview.dependencies.mailboxes, { status: 'available', items: [{ id: 'mailbox-1', state: 'active' }] });
  for (const type of ['backups', 'crons', 'dockerWorkloads']) {
    assert.deepEqual(preview.dependencies[type], { status: 'unavailable', items: [] });
  }
  const blockerCodes = preview.blockers.map((item) => item.code);
  for (const code of [
    'linked_domains_present', 'child_domains_present', 'application_binding_present', 'certificates_present',
    'active_jobs_present', 'dns_zones_present', 'mail_domains_present', 'mailbox_dependencies_present',
    'dependency_inventory_unavailable', 'impact_apply_not_implemented',
  ]) assert.ok(blockerCodes.includes(code), code);
  assert.equal(preview.safeToApply, false);
  assert.equal(preview.applySupported, false);
  assert.equal(preview.autoApply, false);
  assert.equal(preview.destructive, true);
  assert.equal(preview.confirmation, `delete:website:${state.website.id}:${preview.previewDigest}`);
  assert.doesNotMatch(JSON.stringify(preview), /admin@example\.test|github\.com|privateKeyPath/);
});

test('Domain move preview includes child Website/Application/certificate state and validates target server', async () => {
  const state = await fixture();
  const preview = await previewResourceImpact({
    resourceType: 'domain',
    resourceId: state.domain.id,
    operation: 'move',
    targetServerId: state.targetServerId,
    ...dependencies(state),
  });
  assert.equal(preview.targetServerId, state.targetServerId);
  assert.equal(preview.dependencies.website.id, state.website.id);
  assert.equal(preview.dependencies.application.id, state.application.id);
  assert.deepEqual(preview.dependencies.childDomains.map((item) => item.id), [state.child.id]);
  assert.equal(preview.dependencies.certificates[0].id, state.certificate.id);
  assert.equal(preview.confirmation, `move:domain:${state.domain.id}:${state.targetServerId}:${preview.previewDigest}`);

  await assert.rejects(
    previewResourceImpact({
      resourceType: 'domain', resourceId: state.domain.id, operation: 'move', targetServerId: state.sourceServerId, ...dependencies(state),
    }),
    (error) => error instanceof ResourceImpactError && error.code === 'impact_move_no_changes' && error.status === 409,
  );
  await assert.rejects(
    previewResourceImpact({
      resourceType: 'domain', resourceId: state.domain.id, operation: 'move', targetServerId: '2fc9a376-764a-4a31-b230-639e165951a4', ...dependencies(state),
    }),
    (error) => error instanceof ResourceImpactError && error.code === 'target_server_not_found' && error.status === 404,
  );
});

test('impact digest changes with relevant descendants and ignores no dependency as safe', async () => {
  const state = await fixture();
  const input = { resourceType: 'domain', resourceId: state.domain.id, operation: 'delete' };
  const first = await previewResourceImpact({ ...input, ...dependencies(state) });
  await state.domainRegistry.createDomain({
    serverId: state.sourceServerId,
    websiteId: state.childWebsite.id,
    primaryDomain: 'nested.api.impact.example.test',
    parentDomainId: state.child.id,
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 8400 },
  });
  const second = await previewResourceImpact({ ...input, ...dependencies(state) });
  assert.notEqual(second.previewDigest, first.previewDigest);
  assert.equal(second.dependencies.childDomains.length, 2);
  assert.ok(second.blockers.some((item) => item.code === 'impact_apply_not_implemented'));
  assert.equal(second.safeToApply, false);
});

test('additional dependency providers expose only bounded references and fail closed on bad metadata', async () => {
  const state = await fixture();
  await assert.rejects(
    previewResourceImpact({
      resourceType: 'website',
      resourceId: state.website.id,
      operation: 'delete',
      ...dependencies(state, {
        additionalProviders: { backups: async () => [{ id: '/secret/path', state: 'ready', token: 'secret' }] },
      }),
    }),
    (error) => error instanceof ResourceImpactError && error.code === 'backup_impact_invalid' && error.status === 503,
  );
  await assert.rejects(
    previewResourceImpact({
      resourceType: 'website',
      resourceId: state.website.id,
      operation: 'delete',
      ...dependencies(state, { additionalProviders: { unknown: async () => [] } }),
    }),
    (error) => error instanceof ResourceImpactError && error.code === 'impact_dependencies_invalid' && error.status === 503,
  );
});

test('legacy-safe Domain identifiers remain previewable while Website and target server IDs stay UUIDs', () => {
  assert.equal(resourceImpactInternals.resourceIdentity('legacy-domain.1', 'domain'), 'legacy-domain.1');
  assert.throws(
    () => resourceImpactInternals.resourceIdentity('../escape', 'domain'),
    (error) => error instanceof ResourceImpactError && error.code === 'invalid_domain_id',
  );
  assert.throws(
    () => resourceImpactInternals.resourceIdentity('legacy-website', 'website'),
    (error) => error instanceof ResourceImpactError && error.code === 'invalid_website_id',
  );
});
