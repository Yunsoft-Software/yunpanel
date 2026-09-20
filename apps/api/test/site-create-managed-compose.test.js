import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createDockerComposeProjectRegistry } from '../src/docker-compose-project-registry.js';
import { createDockerWorkloadRegistry } from '../src/docker-workload-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createMailDomainRegistry } from '../src/mail-domain-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createSite, previewSiteCreate, SiteCreateError } from '../src/site-create.js';
import { siteCreateProvisioningPlan } from '../src/site-create-provisioning.js';
import { createWebsiteRegistry } from '../src/website-registry.js';

const COMPOSE_OPERATION = '5c8625aa-e129-4ce4-82ee-c6b7596adba2';
const SECOND_OPERATION = '9ef06dc3-ec2d-4513-8cfb-6659caecbe47';

function composeValidation(document, { serviceName = 'web', targetPort = 8080, publishedPort = 18080, hostIp = null } = {}) {
  return {
    version: 1,
    projectName: 'portal_stack',
    composeSha256: createHash('sha256').update(document).digest('hex'),
    composeBytes: Buffer.byteLength(document),
    serviceCount: 1,
    services: [{
      name: serviceName,
      imageConfigured: true,
      buildConfigured: false,
      publishedPorts: [{
        hostIp,
        publishedPort,
        targetPort,
        protocol: 'tcp',
      }],
      storageMounts: [],
    }],
    networks: ['default'],
    volumes: [],
    secretCount: 0,
    configCount: 0,
    validated: true,
    sideEffects: false,
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-site-create-compose-'));
  const composePath = path.join(root, 'projects.json');
  t.after(() => rm(root, { recursive: true, force: true }));

  const registry = createServerRegistry();
  const enrollment = await registry.issueEnrollmentToken({ label: 'site-create-compose' });
  const enrolled = await registry.enrollServer({ token: enrollment.token, hostname: 'compose-host' });
  const serverId = enrolled.server.id;

  const dockerComposeProjectRegistry = createDockerComposeProjectRegistry({
    filePath: composePath,
    masterKey: randomBytes(32),
    serverExists: async (id) => id === serverId,
  });

  const applicationRegistry = createApplicationRegistry({
    serverExists: async (id) => Boolean(await registry.getServer(id)),
  });
  const dockerWorkloadRegistry = createDockerWorkloadRegistry({
    serverExists: async (id) => Boolean(await registry.getServer(id)),
  });
  const websiteRegistry = createWebsiteRegistry({
    serverExists: async (id) => Boolean(await registry.getServer(id)),
    getApplication: async (appId) => applicationRegistry.getApplication(appId),
    getDockerWorkload: async (workloadId) => dockerWorkloadRegistry.getWorkload(workloadId),
    getDockerComposeProject: async (projectId) => dockerComposeProjectRegistry.getProject(projectId),
  });
  const domainRegistry = createDomainRegistry({
    serverExists: async (id) => Boolean(await registry.getServer(id)),
    getWebsite: async (websiteId) => websiteRegistry.getWebsite(websiteId),
    websiteBindingRequired: () => true,
  });
  const mailDomainRegistry = createMailDomainRegistry({
    getWebDomain: async (domainId) => domainRegistry.getDomain(domainId),
  });

  await Promise.all([
    dockerComposeProjectRegistry.init(),
    applicationRegistry.init(),
    dockerWorkloadRegistry.init(),
    websiteRegistry.init(),
    domainRegistry.init(),
    mailDomainRegistry.init(),
  ]);

  return {
    registry,
    dockerComposeProjectRegistry,
    applicationRegistry,
    dockerWorkloadRegistry,
    websiteRegistry,
    domainRegistry,
    mailDomainRegistry,
    serverId,
  };
}

function dependencies(state, overrides = {}) {
  return {
    registry: state.registry,
    dockerComposeProjectRegistry: state.dockerComposeProjectRegistry,
    applicationRegistry: state.applicationRegistry,
    dockerWorkloadRegistry: state.dockerWorkloadRegistry,
    websiteRegistry: state.websiteRegistry,
    domainRegistry: state.domainRegistry,
    mailDomainRegistry: state.mailDomainRegistry,
    ...overrides,
  };
}

function inputFor(serverId, projectId, overrides = {}) {
  return {
    operationId: COMPOSE_OPERATION,
    serverId,
    name: 'Managed Portal',
    primaryDomain: 'portal.example.com',
    parentDomainId: null,
    wwwMode: 'none',
    httpsMode: 'off',
    source: {
      kind: 'existing_managed_compose',
      projectId,
      serviceName: 'web',
      targetPort: 8080,
      protocol: 'tcp',
    },
    database: { mode: 'none' },
    mail: { mode: 'none' },
    dns: { mode: 'external' },
    ...overrides,
  };
}

test('preview and create site with existing_managed_compose succeeds and wires loopback proxy target', async (t) => {
  const state = await fixture(t);
  const doc = 'services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "18080:8080"\n';
  const project = await state.dockerComposeProjectRegistry.createProject({
    serverId: state.serverId,
    projectName: 'portal_stack',
    document: doc,
    validation: composeValidation(doc, { serviceName: 'web', targetPort: 8080, publishedPort: 18080 }),
  });

  const input = inputFor(state.serverId, project.id);
  const preview = await previewSiteCreate({ input, ...dependencies(state) });

  assert.equal(preview.complete, false);
  assert.equal(preview.steps.managedComposeReady, true);
  assert.deepEqual(preview.plan.managedComposeBinding, {
    projectId: project.id,
    serviceName: 'web',
    targetPort: 8080,
    protocol: 'tcp',
  });
  assert.equal(preview.plan.website.runtimeType, 'docker');
  assert.equal(preview.plan.website.managedComposeBinding.projectId, project.id);
  assert.equal(preview.plan.primaryDomain.targetType, 'proxy');
  assert.deepEqual(preview.plan.primaryDomain.target, {
    upstreamHost: '127.0.0.1',
    upstreamPort: 18080,
    websocket: true,
  });
  assert.equal(preview.plan.runtime.adapter, 'managed_compose');
  assert.equal(preview.plan.runtime.serviceName, 'web');
  assert.equal(preview.plan.runtime.targetPort, 8080);
  assert.equal(preview.plan.runtime.publishedPort, 18080);

  const plan = siteCreateProvisioningPlan(preview);
  const composeStep = plan.steps.find((step) => step.id === 'managed_compose_binding');
  assert.ok(composeStep, 'managed_compose_binding step must be in provisioning plan');
  assert.equal(composeStep.kind, 'managed_compose_binding');
  assert.equal(composeStep.state, 'succeeded');
  assert.deepEqual(composeStep.intent, {
    projectId: project.id,
    serviceName: 'web',
    targetPort: 8080,
    protocol: 'tcp',
  });

  const nginxStep = plan.steps.find((step) => step.id === 'nginx');
  assert.ok(nginxStep);
  assert.equal(nginxStep.intent.targetType, 'proxy');
  assert.deepEqual(nginxStep.intent.target, {
    upstreamHost: '127.0.0.1',
    upstreamPort: 18080,
    websocket: true,
  });

  const result = await createSite({
    input,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
    ...dependencies(state),
  });

  assert.equal(result.website.runtimeType, 'docker');
  assert.deepEqual(result.website.managedComposeBinding, {
    projectId: project.id,
    serviceName: 'web',
    targetPort: 8080,
    protocol: 'tcp',
  });
  assert.equal(result.primaryDomain.targetType, 'proxy');
  assert.deepEqual(result.primaryDomain.target, {
    upstreamHost: '127.0.0.1',
    upstreamPort: 18080,
    websocket: true,
  });

  const idempotent = await createSite({
    input,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
    ...dependencies(state),
  });
  assert.equal(idempotent.website.id, result.website.id);
});

test('existing_managed_compose fails when project is not found', async (t) => {
  const state = await fixture(t);
  const nonExistentProjectId = '00000000-0000-4000-8000-000000000000';
  const input = inputFor(state.serverId, nonExistentProjectId);

  await assert.rejects(
    previewSiteCreate({ input, ...dependencies(state) }),
    (error) => error instanceof SiteCreateError && error.code === 'managed_compose_project_not_found' && error.status === 404,
  );
});

test('existing_managed_compose fails when serverId does not match project serverId', async (t) => {
  const state = await fixture(t);
  const doc = 'services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "18080:8080"\n';
  const project = await state.dockerComposeProjectRegistry.createProject({
    serverId: state.serverId,
    projectName: 'portal_stack',
    document: doc,
    validation: composeValidation(doc, { serviceName: 'web', targetPort: 8080, publishedPort: 18080 }),
  });

  const enrollment = await state.registry.issueEnrollmentToken({ label: 'other-server' });
  const otherEnrolled = await state.registry.enrollServer({ token: enrollment.token, hostname: 'other-host' });

  const input = inputFor(otherEnrolled.server.id, project.id);

  await assert.rejects(
    previewSiteCreate({ input, ...dependencies(state) }),
    (error) => error instanceof SiteCreateError && error.code === 'site_create_managed_compose_server_mismatch' && error.status === 409,
  );
});

test('existing_managed_compose fails when service is not in project', async (t) => {
  const state = await fixture(t);
  const doc = 'services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "18080:8080"\n';
  const project = await state.dockerComposeProjectRegistry.createProject({
    serverId: state.serverId,
    projectName: 'portal_stack',
    document: doc,
    validation: composeValidation(doc, { serviceName: 'web', targetPort: 8080, publishedPort: 18080 }),
  });

  const input = inputFor(state.serverId, project.id, {
    source: {
      kind: 'existing_managed_compose',
      projectId: project.id,
      serviceName: 'non_existent_service',
      targetPort: 8080,
      protocol: 'tcp',
    },
  });

  await assert.rejects(
    previewSiteCreate({ input, ...dependencies(state) }),
    (error) => error instanceof SiteCreateError && error.code === 'site_create_managed_compose_service_not_found' && error.status === 404,
  );
});

test('existing_managed_compose fails when target port is not published', async (t) => {
  const state = await fixture(t);
  const doc = 'services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "18080:8080"\n';
  const project = await state.dockerComposeProjectRegistry.createProject({
    serverId: state.serverId,
    projectName: 'portal_stack',
    document: doc,
    validation: composeValidation(doc, { serviceName: 'web', targetPort: 8080, publishedPort: 18080 }),
  });

  const input = inputFor(state.serverId, project.id, {
    source: {
      kind: 'existing_managed_compose',
      projectId: project.id,
      serviceName: 'web',
      targetPort: 9090,
      protocol: 'tcp',
    },
  });

  await assert.rejects(
    previewSiteCreate({ input, ...dependencies(state) }),
    (error) => error instanceof SiteCreateError && error.code === 'site_create_managed_compose_port_not_published' && error.status === 409,
  );
});

test('existing_managed_compose fails when binding is already bound to another website', async (t) => {
  const state = await fixture(t);
  const doc = 'services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "18080:8080"\n';
  const project = await state.dockerComposeProjectRegistry.createProject({
    serverId: state.serverId,
    projectName: 'portal_stack',
    document: doc,
    validation: composeValidation(doc, { serviceName: 'web', targetPort: 8080, publishedPort: 18080 }),
  });

  const input1 = inputFor(state.serverId, project.id);
  const preview1 = await previewSiteCreate({ input: input1, ...dependencies(state) });
  await createSite({
    input: input1,
    previewDigest: preview1.previewDigest,
    confirmation: preview1.confirmation,
    ...dependencies(state),
  });

  const input2 = inputFor(state.serverId, project.id, {
    operationId: SECOND_OPERATION,
    name: 'Second Site',
    primaryDomain: 'portal2.example.com',
  });

  await assert.rejects(
    previewSiteCreate({ input: input2, ...dependencies(state) }),
    (error) => error instanceof SiteCreateError && error.code === 'managed_compose_binding_already_bound' && error.status === 409,
  );
});
