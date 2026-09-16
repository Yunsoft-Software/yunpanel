import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createDockerWorkloadRegistry } from '../src/docker-workload-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createSite, previewSiteCreate } from '../src/site-create.js';
import { siteCreateProvisioningPlan } from '../src/site-create-provisioning-isolation.js';
import { createWebsiteRegistry } from '../src/website-registry.js';

const CHILD_OPERATION = '531071bb-d40d-4444-94ba-c9545144febc';

async function fixture() {
  const registry = createServerRegistry();
  const enrollment = await registry.issueEnrollmentToken({ label: 'independent-subdomain' });
  const enrolled = await registry.enrollServer({ token: enrollment.token, hostname: 'independent-subdomain-host' });
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
  await Promise.all([
    applicationRegistry.init(),
    dockerWorkloadRegistry.init(),
    websiteRegistry.init(),
    domainRegistry.init(),
  ]);
  return {
    registry,
    applicationRegistry,
    dockerWorkloadRegistry,
    websiteRegistry,
    domainRegistry,
    serverId: enrolled.server.id,
  };
}

function dependencies(state) {
  return {
    registry: state.registry,
    applicationRegistry: state.applicationRegistry,
    dockerWorkloadRegistry: state.dockerWorkloadRegistry,
    websiteRegistry: state.websiteRegistry,
    domainRegistry: state.domainRegistry,
  };
}

async function createParent(state) {
  const application = await state.applicationRegistry.createApplication({
    serverId: state.serverId,
    name: 'Parent Website',
    repositoryUrl: 'https://github.com/example/parent-site',
  });
  const website = await state.websiteRegistry.createWebsite({
    serverId: state.serverId,
    name: 'Parent Website',
    applicationId: application.id,
  });
  const domain = await state.domainRegistry.createDomain({
    serverId: state.serverId,
    websiteId: website.id,
    primaryDomain: 'example.test',
    aliases: [],
    targetType: 'static',
    target: { root: application.webRoot, spaFallback: true },
    httpsMode: 'off',
  });
  return { application, website, domain };
}

function childInput(state, parentDomainId) {
  return {
    operationId: CHILD_OPERATION,
    serverId: state.serverId,
    name: 'Blog Website',
    primaryDomain: 'blog.example.test',
    parentDomainId,
    wwwMode: 'none',
    httpsMode: 'off',
    source: {
      kind: 'new_static',
      repositoryUrl: 'https://github.com/example/blog-site',
      branch: 'main',
      build: { mode: 'none', outputDir: '.' },
      retention: 5,
    },
  };
}

test('explicit subdomain Site create gets a dedicated Website Application Unix identity and SFTP scope', async () => {
  const state = await fixture();
  const parent = await createParent(state);
  const input = childInput(state, parent.domain.id);
  const preview = await previewSiteCreate({ input, ...dependencies(state) });

  assert.equal(preview.plan.primaryDomain.parentDomainId, parent.domain.id);
  assert.notEqual(preview.plan.application.id, parent.application.id);
  assert.notEqual(preview.plan.website.id, parent.website.id);
  assert.notEqual(preview.plan.website.unixUser, parent.website.unixUser);
  assert.equal(preview.plan.website.applicationId, preview.plan.application.id);
  assert.equal(preview.plan.primaryDomain.websiteId, preview.plan.website.id);

  const provisioning = siteCreateProvisioningPlan(preview);
  const identity = provisioning.steps.find((step) => step.id === 'unix_identity');
  const sftp = provisioning.steps.find((step) => step.id === 'sftp');
  assert.equal(identity.intent.websiteId, preview.plan.website.id);
  assert.equal(identity.intent.applicationId, preview.plan.application.id);
  assert.equal(identity.intent.unixUser, preview.plan.website.unixUser);
  assert.equal(sftp.intent.websiteId, preview.plan.website.id);
  assert.equal(sftp.intent.applicationId, preview.plan.application.id);
  assert.equal(sftp.intent.unixUser, preview.plan.website.unixUser);
  assert.notEqual(sftp.intent.websiteId, parent.website.id);
  assert.notEqual(sftp.intent.applicationId, parent.application.id);

  const created = await createSite({
    input,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
    ...dependencies(state),
  });

  assert.equal(created.primaryDomain.parentDomainId, parent.domain.id);
  assert.equal(created.primaryDomain.websiteId, created.website.id);
  assert.equal(created.website.applicationId, created.application.id);
  assert.notEqual(created.website.id, parent.website.id);
  assert.notEqual(created.application.id, parent.application.id);
  assert.notEqual(created.website.unixUser, parent.website.unixUser);
  assert.equal((await state.applicationRegistry.listApplications()).length, 2);
  assert.equal((await state.websiteRegistry.listWebsites()).length, 2);
  assert.equal((await state.domainRegistry.listDomains()).length, 2);
});
