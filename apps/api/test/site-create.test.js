import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createDockerWorkloadRegistry } from '../src/docker-workload-registry.js';
import { createMailDomainRegistry } from '../src/mail-domain-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createSite, previewSiteCreate, SiteCreateError, siteCreateInternals } from '../src/site-create.js';
import { createWebsiteRegistry } from '../src/website-registry.js';

const STATIC_OPERATION = 'ab9b4c03-e744-40d4-ad1d-e9bab966a3e7';
const NODE_OPERATION = '47bc6cf1-75bc-4cba-a610-aa0cd0522c80';
const PROXY_OPERATION = '86e826ad-2dc6-45e4-ac3f-0c03bcff18fc';
const DOCKER_OPERATION = 'a17be329-acdf-48fd-ac1f-b3e35ec75565';

async function fixture() {
  const registry = createServerRegistry();
  const enrollment = await registry.issueEnrollmentToken({ label: 'site-create' });
  const enrolled = await registry.enrollServer({ token: enrollment.token, hostname: 'site-create-host' });
  const applicationRegistry = createApplicationRegistry({
    serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
  });
  const dockerWorkloadRegistry = createDockerWorkloadRegistry({
    serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
  });
  const websiteRegistry = createWebsiteRegistry({
    serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
    getApplication: async (applicationId) => applicationRegistry.getApplication(applicationId),
    getDockerWorkload: async (workloadId) => dockerWorkloadRegistry.getWorkload(workloadId),
  });
  const domainRegistry = createDomainRegistry({
    serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
    getWebsite: async (websiteId) => websiteRegistry.getWebsite(websiteId),
    websiteBindingRequired: () => true,
  });
  const mailDomainRegistry = createMailDomainRegistry({
    getWebDomain: async (domainId) => domainRegistry.getDomain(domainId),
  });
  await Promise.all([
    applicationRegistry.init(),
    dockerWorkloadRegistry.init(),
    websiteRegistry.init(),
    domainRegistry.init(),
    mailDomainRegistry.init(),
  ]);
  return {
    registry,
    applicationRegistry,
    dockerWorkloadRegistry,
    websiteRegistry,
    domainRegistry,
    mailDomainRegistry,
    serverId: enrolled.server.id,
  };
}

function dependencies(state, overrides = {}) {
  return {
    registry: state.registry,
    applicationRegistry: state.applicationRegistry,
    dockerWorkloadRegistry: state.dockerWorkloadRegistry,
    websiteRegistry: state.websiteRegistry,
    domainRegistry: state.domainRegistry,
    mailDomainRegistry: state.mailDomainRegistry,
    ...overrides,
  };
}

function inputFor(serverId, overrides = {}) {
  return {
    operationId: STATIC_OPERATION,
    serverId,
    name: 'Marketing Site',
    primaryDomain: 'Example.COM.',
    parentDomainId: null,
    wwwMode: 'alias',
    httpsMode: 'managed',
    source: {
      kind: 'new_static',
      repositoryUrl: 'https://github.com/example/marketing',
      branch: 'main',
      build: { mode: 'none', outputDir: '.' },
      retention: 5,
    },
    ...overrides,
  };
}

async function apply(input, state, preview = null, overrides = {}) {
  const current = preview ?? await previewSiteCreate({ input, ...dependencies(state, overrides) });
  return createSite({
    input,
    previewDigest: current.previewDigest,
    confirmation: current.confirmation,
    ...dependencies(state, overrides),
  });
}

test('new static site creates deterministic Application, Website and explicit www alias idempotently', async () => {
  const state = await fixture();
  const input = inputFor(state.serverId);
  const preview = await previewSiteCreate({ input, ...dependencies(state) });
  assert.equal(preview.complete, false);
  assert.equal(preview.resumeRequired, false);
  assert.equal(preview.assignedPort, null);
  assert.deepEqual(preview.hostname.aliases, ['www.example.com']);
  assert.deepEqual(preview.lifecycle, { dnsPublished: false, certificateIssued: false, mailDomainCreated: false });
  assert.equal(preview.plan.application.webRoot, `/var/www/yunpanel/apps/${preview.ids.applicationId}/current`);

  const created = await apply(input, state, preview);
  assert.equal(created.created, true);
  assert.equal(created.resumed, false);
  assert.equal(created.application.id, preview.ids.applicationId);
  assert.equal(created.website.id, preview.ids.websiteId);
  assert.equal(created.website.applicationId, created.application.id);
  assert.equal(created.primaryDomain.websiteId, created.website.id);
  assert.deepEqual(created.primaryDomain.aliases, ['www.example.com']);
  assert.equal(created.primaryDomain.certificateId, null);
  assert.equal(created.wwwDomain, null);

  const completedPreview = await previewSiteCreate({ input, ...dependencies(state) });
  assert.equal(completedPreview.previewDigest, preview.previewDigest);
  assert.equal(completedPreview.complete, true);
  const retried = await apply(input, state, preview);
  assert.equal(retried.created, false);
  assert.equal((await state.applicationRegistry.listApplications()).length, 1);
  assert.equal((await state.websiteRegistry.listWebsites()).length, 1);
  assert.equal((await state.domainRegistry.listDomains()).length, 1);
});

test('optional mail defaults to none without changing legacy site-create lifecycle', async () => {
  const state = await fixture();
  const preview = await previewSiteCreate({
    input: inputFor(state.serverId),
    ...dependencies(state),
  });

  assert.equal(preview.ids.mailDomainId, null);
  assert.equal(preview.plan.mailDomain, null);
  assert.equal(preview.plan.webmail, null);
  assert.equal(preview.steps.mailDomainReady, null);
  assert.deepEqual(preview.lifecycle, {
    dnsPublished: false,
    certificateIssued: false,
    mailDomainCreated: false,
  });
});

test('local mail preflight is deterministic, requires managed HTTPS and creates only disabled Mail Domain metadata', async () => {
  const state = await fixture();
  const localInput = inputFor(state.serverId, {
    operationId: '9e704947-c2e9-4949-95c7-2cb1c8cb4d2a',
    primaryDomain: 'Mail-Site.Example.COM.',
    wwwMode: 'none',
    httpsMode: 'managed',
    mail: { mode: 'local' },
  });

  const preview = await previewSiteCreate({
    input: localInput,
    ...dependencies(state),
  });
  assert.match(preview.ids.mailDomainId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(preview.plan.mailDomain, {
    id: preview.ids.mailDomainId,
    domainName: 'mail-site.example.com',
    webDomainId: preview.ids.primaryDomainId,
    managementMode: 'local',
    initialStatus: 'disabled',
    desiredStatus: 'enabled',
  });
  assert.deepEqual(preview.plan.webmail, {
    hostname: 'webmail.mail-site.example.com',
    sharedRoundcube: true,
    certificateCoverageRequired: true,
  });
  assert.equal(preview.steps.mailDomainReady, false);
  assert.equal(preview.lifecycle.mailDomainCreated, false);
  assert.equal(preview.lifecycle.webmailMappingActive, false);

  const created = await apply(localInput, state, preview);
  assert.equal(created.mailDomain.id, preview.ids.mailDomainId);
  assert.equal(created.mailDomain.webDomainId, preview.ids.primaryDomainId);
  assert.equal(created.mailDomain.managementMode, 'local');
  assert.equal(created.mailDomain.status, 'disabled');
  assert.equal((await state.mailDomainRegistry.listMailDomains()).length, 1);

  const retry = await previewSiteCreate({
    input: localInput,
    ...dependencies(state),
  });
  assert.equal(retry.previewDigest, preview.previewDigest);
  assert.equal(retry.complete, true);
  assert.equal(retry.steps.mailDomainReady, true);
  assert.equal(retry.lifecycle.mailDomainCreated, true);
  assert.equal(retry.lifecycle.webmailMappingActive, false);

  await assert.rejects(
    previewSiteCreate({
      input: { ...localInput, httpsMode: 'off' },
      ...dependencies(state),
    }),
    (error) => error instanceof SiteCreateError
      && error.code === 'site_create_local_mail_https_required'
      && error.status === 409,
  );
});

test('external mail preflight creates an explicit unverified relationship without shared webmail intent', async () => {
  const state = await fixture();
  const externalInput = inputFor(state.serverId, {
    operationId: '86bc823b-b68e-4efc-a017-5561ed38613d',
    primaryDomain: 'external-mail.example.com',
    wwwMode: 'none',
    httpsMode: 'off',
    mail: { mode: 'external' },
  });

  const preview = await previewSiteCreate({
    input: externalInput,
    ...dependencies(state),
  });
  assert.equal(preview.plan.mailDomain.managementMode, 'external');
  assert.equal(preview.plan.mailDomain.initialStatus, 'unverified');
  assert.equal(preview.plan.mailDomain.desiredStatus, null);
  assert.equal(preview.plan.webmail, null);

  const created = await apply(externalInput, state, preview);
  assert.equal(created.mailDomain.managementMode, 'external');
  assert.equal(created.mailDomain.status, 'unverified');
  assert.equal(created.mailDomain.webDomainId, preview.ids.primaryDomainId);
});

test('optional initial database is deterministic and scoped to the planned Website identity', async () => {
  const state = await fixture();
  const input = inputFor(state.serverId, { database: { mode: 'create' } });
  const preview = await previewSiteCreate({ input, ...dependencies(state) });

  assert.match(preview.plan.database.databaseName, /^yp_[a-f0-9]{32}$/);
  assert.deepEqual(preview.plan.database, {
    serverId: state.serverId,
    databaseName: preview.plan.database.databaseName,
    websiteId: preview.ids.websiteId,
    applicationId: preview.ids.applicationId,
    unixUser: preview.plan.website.unixUser,
  });
  const retry = await previewSiteCreate({ input, ...dependencies(state) });
  assert.deepEqual(retry.plan.database, preview.plan.database);
  assert.equal(retry.previewDigest, preview.previewDigest);
});

test('initial database rejects unmanaged proxy and Docker sources', async () => {
  const state = await fixture();
  await assert.rejects(
    previewSiteCreate({
      input: inputFor(state.serverId, {
        source: { kind: 'external_proxy', target: { host: '127.0.0.1', port: 4301, websocket: true } },
        database: { mode: 'create' },
      }),
      ...dependencies(state),
    }),
    (error) => error instanceof SiteCreateError && error.code === 'site_create_database_source_unsupported',
  );
});

test('new Node site is Passenger-first and never allocates a localhost backend port', async () => {
  const state = await fixture();
  await state.applicationRegistry.createNodeApplication({
    serverId: state.serverId,
    name: 'Existing Legacy Node',
    repositoryUrl: 'https://github.com/example/existing-node',
    runtime: { port: 3100 },
  });
  const proxyWebsite = await state.websiteRegistry.createWebsite({
    serverId: state.serverId,
    name: 'Reserved Proxy',
    runtimeType: 'proxy',
    proxyTarget: { host: '127.0.0.1', port: 3101 },
  });
  await state.domainRegistry.createDomain({
    serverId: state.serverId,
    websiteId: proxyWebsite.id,
    primaryDomain: 'reserved.example.test',
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 3101 },
  });
  const input = inputFor(state.serverId, {
    operationId: NODE_OPERATION,
    name: 'Node API',
    primaryDomain: 'api.example.test',
    wwwMode: 'none',
    httpsMode: 'off',
    source: { kind: 'new_node', repositoryUrl: 'https://github.com/example/node-api', runtime: {} },
  });
  const preview = await previewSiteCreate({ input, ...dependencies(state) });
  assert.equal(preview.assignedPort, null);
  assert.equal(preview.plan.application.runtimeAdapter, 'passenger');
  assert.equal(preview.plan.application.runtime.port, null);
  assert.equal(preview.plan.primaryDomain.targetType, 'passenger');
  assert.deepEqual(preview.plan.primaryDomain.target, { applicationId: preview.ids.applicationId });

  const created = await apply(input, state, preview);
  assert.equal(created.application.runtimeAdapter, 'passenger');
  assert.equal(created.application.runtime.port, null);
  assert.equal(created.application.serviceName, null);
  assert.equal(created.application.servicePort, null);
  assert.equal(created.application.proxyTarget, null);
  assert.equal(created.primaryDomain.targetType, 'passenger');
  assert.deepEqual(created.primaryDomain.target, { applicationId: created.application.id });
  assert.equal(created.wwwDomain, null);
});

test('existing Application binding stays explicit and cannot be shared by multiple Websites', async () => {
  const state = await fixture();
  const application = await state.applicationRegistry.createApplication({
    serverId: state.serverId,
    name: 'Existing Static',
    repositoryUrl: 'https://github.com/example/existing-static',
  });
  const input = inputFor(state.serverId, {
    operationId: 'cb934804-a7c7-4ffd-bcc4-93289219823b',
    source: { kind: 'existing_application', applicationId: application.id },
  });
  const created = await apply(input, state);
  assert.equal(created.application.id, application.id);
  assert.equal((await state.applicationRegistry.listApplications()).length, 1);

  const secondInput = inputFor(state.serverId, {
    operationId: '37861cf3-8462-4d4d-aab0-303fb53022a1',
    primaryDomain: 'other.example.com',
    source: { kind: 'existing_application', applicationId: application.id },
  });
  await assert.rejects(
    previewSiteCreate({ input: secondInput, ...dependencies(state) }),
    (error) => error instanceof SiteCreateError && error.code === 'application_already_bound' && error.status === 409,
  );
});

test('external proxy site canonicalizes its origin without creating an Application', async () => {
  const state = await fixture();
  const input = inputFor(state.serverId, {
    operationId: PROXY_OPERATION,
    name: 'External Origin',
    primaryDomain: 'edge.example.test',
    wwwMode: 'none',
    source: { kind: 'external_proxy', target: { host: 'ORIGIN.Example.NET.', port: 8443, websocket: false } },
  });
  const preview = await previewSiteCreate({ input, ...dependencies(state) });
  assert.equal(preview.ids.applicationId, null);
  assert.deepEqual(preview.source.target, { host: 'origin.example.net', port: 8443, websocket: false });
  const created = await apply(input, state, preview);
  assert.equal(created.application, null);
  assert.equal(created.website.runtimeType, 'proxy');
  assert.deepEqual(created.website.proxyTarget, { host: 'origin.example.net', port: 8443, websocket: false });
  assert.deepEqual(created.primaryDomain.target, { upstreamHost: 'origin.example.net', upstreamPort: 8443, websocket: false });
});

test('existing Docker workload becomes an explicit Website runtime without claiming container lifecycle', async () => {
  const state = await fixture();
  const workload = await state.dockerWorkloadRegistry.createWorkload({
    serverId: state.serverId,
    name: 'Compose API',
    managementMode: 'external',
    proxyTarget: { host: '127.0.0.1', port: 8080, websocket: true },
  });
  const input = inputFor(state.serverId, {
    operationId: DOCKER_OPERATION,
    name: 'Docker API',
    primaryDomain: 'docker.example.test',
    wwwMode: 'none',
    source: { kind: 'existing_docker', dockerWorkloadId: workload.id },
  });
  const preview = await previewSiteCreate({ input, ...dependencies(state) });
  assert.equal(preview.plan.application, null);
  assert.equal(preview.plan.dockerWorkload.id, workload.id);
  assert.equal(preview.plan.website.runtimeType, 'docker');
  assert.equal(preview.plan.website.dockerWorkloadId, workload.id);
  assert.deepEqual(preview.plan.primaryDomain.target, {
    upstreamHost: '127.0.0.1', upstreamPort: 8080, websocket: true,
  });
  assert.equal(preview.steps.dockerWorkloadReady, true);
  assert.equal(preview.lifecycle.containersChanged, false);

  const created = await apply(input, state, preview);
  assert.equal(created.application, null);
  assert.equal(created.dockerWorkload.id, workload.id);
  assert.equal(created.website.dockerWorkloadId, workload.id);
  assert.equal(created.website.runtimeType, 'docker');
  assert.deepEqual(created.primaryDomain.target, preview.plan.primaryDomain.target);

  await assert.rejects(
    previewSiteCreate({
      input: inputFor(state.serverId, {
        operationId: '4ea277a7-76ea-4a66-a001-f1df6005327a',
        primaryDomain: 'other-docker.example.test',
        source: { kind: 'existing_docker', dockerWorkloadId: workload.id },
      }),
      ...dependencies(state),
    }),
    (error) => error instanceof SiteCreateError && error.code === 'docker_workload_already_bound',
  );
});

test('site creation resumes after an interruption without duplicating earlier resources', async () => {
  const state = await fixture();
  const input = inputFor(state.serverId, {
    operationId: 'fa97e720-cd0c-490a-ae56-cfb05c6e3686',
    primaryDomain: 'resume.example.test',
  });
  const preview = await previewSiteCreate({ input, ...dependencies(state) });
  let interrupted = true;
  const flakyDomainRegistry = {
    listDomains: (...args) => state.domainRegistry.listDomains(...args),
    getDomain: (...args) => state.domainRegistry.getDomain(...args),
    createDomain: (...args) => {
      if (interrupted) {
        interrupted = false;
        throw new Error('simulated interruption');
      }
      return state.domainRegistry.createDomain(...args);
    },
  };
  await assert.rejects(apply(input, state, preview, { domainRegistry: flakyDomainRegistry }), /simulated interruption/);
  assert.equal((await state.applicationRegistry.listApplications()).length, 1);
  assert.equal((await state.websiteRegistry.listWebsites()).length, 1);
  assert.equal((await state.domainRegistry.listDomains()).length, 0);

  const resume = await previewSiteCreate({ input, ...dependencies(state) });
  assert.equal(resume.previewDigest, preview.previewDigest);
  assert.equal(resume.resumeRequired, true);
  assert.deepEqual(resume.steps, {
    applicationReady: true,
    websiteReady: true,
    primaryDomainReady: false,
    wwwDomainReady: null,
    mailDomainReady: null,
  });
  const created = await apply(input, state, preview);
  assert.equal(created.resumed, true);
  assert.equal((await state.applicationRegistry.listApplications()).length, 1);
  assert.equal((await state.websiteRegistry.listWebsites()).length, 1);
  assert.equal((await state.domainRegistry.listDomains()).length, 1);
});

test('same-server state drift invalidates preview before operation-owned resources are created', async () => {
  const state = await fixture();
  const input = inputFor(state.serverId, {
    operationId: '36bd97f1-0189-4bac-bc1b-5abff87256d5',
    primaryDomain: 'stale.example.test',
  });
  const preview = await previewSiteCreate({ input, ...dependencies(state) });
  await state.websiteRegistry.createWebsite({ serverId: state.serverId, name: 'Concurrent', runtimeType: 'proxy' });
  await assert.rejects(
    apply(input, state, preview),
    (error) => error instanceof SiteCreateError && error.code === 'site_create_preview_stale' && error.status === 409,
  );
  assert.equal(await state.applicationRegistry.getApplication(preview.ids.applicationId), null);
  assert.equal(await state.websiteRegistry.getWebsite(preview.ids.websiteId), null);
  assert.equal(await state.domainRegistry.getDomain(preview.ids.primaryDomainId), null);
});

test('site creation requires exact confirmation and rejects reused identities or unsupported input', async () => {
  const state = await fixture();
  const input = inputFor(state.serverId);
  const preview = await previewSiteCreate({ input, ...dependencies(state) });
  await assert.rejects(
    createSite({ input, previewDigest: preview.previewDigest, confirmation: 'wrong', ...dependencies(state) }),
    (error) => error instanceof SiteCreateError && error.code === 'site_create_confirmation_required',
  );
  await apply(input, state, preview);
  await assert.rejects(
    previewSiteCreate({ input: { ...input, name: 'Reused operation' }, ...dependencies(state) }),
    (error) => error instanceof SiteCreateError && error.code === 'site_create_application_identity_conflict' && error.status === 409,
  );
  await assert.rejects(
    previewSiteCreate({ input: { ...input, operationId: NODE_OPERATION, source: { kind: 'docker' } }, ...dependencies(state) }),
    (error) => error instanceof SiteCreateError && error.code === 'site_create_target_not_supported' && error.status === 409,
  );
  await assert.rejects(
    previewSiteCreate({
      input: { ...input, operationId: NODE_OPERATION, source: { kind: 'new_node', repositoryUrl: 'https://github.com/example/node', runtime: { port: 3200 } } },
      ...dependencies(state),
    }),
    (error) => error instanceof SiteCreateError && error.code === 'site_create_node_runtime_invalid',
  );
});

test('selected legacy Node Application proxy drift fails closed before a Website is planned', () => {
  assert.throws(
    () => siteCreateInternals.domainTarget({
      id: 'bf6a7374-b440-4380-8ad0-905f63d9ca9e',
      type: 'node',
      runtimeAdapter: 'direct-systemd',
      runtime: { port: 3100 },
      proxyTarget: { host: 'origin.example.test', port: 3100 },
    }, { kind: 'existing_application' }),
    (error) => error instanceof SiteCreateError && error.code === 'site_create_application_proxy_drift' && error.status === 409,
  );
});

test('Passenger Node Application target stays logical and rejects persisted backend ports', () => {
  const applicationId = 'bf6a7374-b440-4380-8ad0-905f63d9ca9e';
  assert.deepEqual(
    siteCreateInternals.domainTarget({
      id: applicationId,
      type: 'node',
      runtimeAdapter: 'passenger',
      runtime: { port: null },
      proxyTarget: null,
    }, { kind: 'existing_application' }),
    { targetType: 'passenger', target: { applicationId } },
  );
  assert.throws(
    () => siteCreateInternals.domainTarget({
      id: applicationId,
      type: 'node',
      runtimeAdapter: 'passenger',
      runtime: { port: 3100 },
      proxyTarget: null,
    }, { kind: 'existing_application' }),
    (error) => error instanceof SiteCreateError && error.code === 'site_create_application_runtime_drift' && error.status === 409,
  );
});

test('DNS mode preflight validates root vs subdomain and yields exact resource preview', async () => {
  const state = await fixture();
  const serverDnsIdentityRegistry = {
    getForServer: async () => ({
      settings: {
        publicIpv4: '203.0.113.10',
        publicIpv6: '2001:db8::10',
        ns1: { hostname: 'ns1.example.test' },
        ns2: { hostname: 'ns2.example.test' },
      },
    }),
  };

  const localInput = inputFor(state.serverId, {
    dns: { mode: 'local' },
  });
  const localPreview = await previewSiteCreate({
    input: localInput,
    ...dependencies(state, { serverDnsIdentityRegistry }),
  });

  assert.equal(localPreview.plan.dns.mode, 'local');
  assert.equal(localPreview.plan.dns.authoritative, true);
  assert.equal(localPreview.plan.dns.publicIpv4, '203.0.113.10');
  assert.equal(localPreview.plan.dns.publicIpv6, '2001:db8::10');
  assert.deepEqual(localPreview.plan.dns.nameservers, ['ns1.example.test', 'ns2.example.test']);
  assert.equal(localPreview.plan.ip.publicIpv4, '203.0.113.10');
  assert.equal(localPreview.plan.ip.publicIpv6, '2001:db8::10');
  assert.equal(localPreview.plan.runtime.type, 'static');
  assert.equal(localPreview.plan.runtime.adapter, 'static');
  assert.equal(localPreview.plan.certificate.mode, 'managed');
  assert.equal(localPreview.plan.certificate.purpose, 'web');
  assert.deepEqual(localPreview.plan.certificate.coverage, ['example.com', 'www.example.com']);
  assert.equal(localPreview.plan.sftp.adapter, 'openssh-internal-sftp');
  assert.ok(localPreview.plan.sftp.unixUser.startsWith('yunapp-'));
  assert.equal(localPreview.blockers.length, 0);

  const externalInput = inputFor(state.serverId, {
    operationId: '6d1bb952-663d-495c-9c76-9d5fcfc8ca22',
    primaryDomain: 'external.example.com',
    dns: { mode: 'external' },
  });
  const externalPreview = await previewSiteCreate({
    input: externalInput,
    ...dependencies(state),
  });
  assert.equal(externalPreview.plan.dns.mode, 'external');
  assert.equal(externalPreview.plan.dns.authoritative, false);

  await assert.rejects(
    previewSiteCreate({
      input: inputFor(state.serverId, {
        operationId: '1b8979fc-9e32-4217-a065-27a3a939f727',
        parentDomainId: '980dd209-c2fc-4621-bb2f-889e05400ab4',
        dns: { mode: 'local' },
      }),
      ...dependencies(state),
    }),
    (error) => error instanceof SiteCreateError && error.code === 'site_create_subdomain_dns_unsupported' && error.status === 409,
  );
});

test('preflight detects package/service blockers and prevents site mutation', async () => {
  const state = await fixture();
  const emptyDnsRegistry = {
    getForServer: async () => null,
  };

  const blockedInput = inputFor(state.serverId, {
    dns: { mode: 'local' },
  });
  const blockedPreview = await previewSiteCreate({
    input: blockedInput,
    ...dependencies(state, { serverDnsIdentityRegistry: emptyDnsRegistry }),
  });

  assert.equal(blockedPreview.complete, false);
  assert.deepEqual(blockedPreview.blockers, ['dns_identity_required']);

  await assert.rejects(
    createSite({
      input: blockedInput,
      previewDigest: blockedPreview.previewDigest,
      confirmation: blockedPreview.confirmation,
      ...dependencies(state, { serverDnsIdentityRegistry: emptyDnsRegistry }),
    }),
    (error) => error instanceof SiteCreateError && error.code === 'site_create_blocked_by_dependency' && error.status === 409,
  );
});

