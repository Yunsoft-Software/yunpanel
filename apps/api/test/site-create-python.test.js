import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createDockerWorkloadRegistry } from '../src/docker-workload-registry.js';
import { createMailDomainRegistry } from '../src/mail-domain-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createSite, previewSiteCreate } from '../src/site-create-base.js';
import { siteCreateProvisioningPlan } from '../src/site-create-provisioning.js';
import { createWebsiteRegistry } from '../src/website-registry.js';

async function fixture() {
  const registry = createServerRegistry();
  const enrollment = await registry.issueEnrollmentToken({ label: 'python-test' });
  const enrolled = await registry.enrollServer({ token: enrollment.token, hostname: 'python-host' });
  const serverId = enrolled.server.id;

  const applicationRegistry = createApplicationRegistry({
    serverExists: async (id) => Boolean(await registry.getServer(id)),
  });
  const dockerWorkloadRegistry = createDockerWorkloadRegistry({
    serverExists: async (id) => Boolean(await registry.getServer(id)),
  });
  const websiteRegistry = createWebsiteRegistry({
    serverExists: async (id) => Boolean(await registry.getServer(id)),
    getApplication: async (applicationId) => applicationRegistry.getApplication(applicationId),
    getDockerWorkload: async (workloadId) => dockerWorkloadRegistry.getWorkload(workloadId),
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
    applicationRegistry.init(),
    dockerWorkloadRegistry.init(),
    websiteRegistry.init(),
    domainRegistry.init(),
    mailDomainRegistry.init(),
  ]);

  return {
    registry,
    serverId,
    applicationRegistry,
    dockerWorkloadRegistry,
    websiteRegistry,
    domainRegistry,
    mailDomainRegistry,
  };
}

function pythonInput(serverId, overrides = {}) {
  return {
    operationId: randomUUID(),
    serverId,
    name: 'Python Web App',
    primaryDomain: 'pyapp.example.com',
    parentDomainId: null,
    wwwMode: 'none',
    httpsMode: 'off',
    dns: { mode: 'external' },
    mail: { mode: 'none' },
    source: {
      kind: 'new_python',
      repositoryUrl: 'https://github.com/example/pyapp',
      branch: 'main',
      runtime: {
        pythonVersion: '3.12',
        appServer: 'gunicorn',
        entryPoint: 'wsgi:application',
        workers: 2,
        healthPath: '/health',
        healthTimeoutSeconds: 15,
      },
    },
    ...overrides,
  };
}

test('site-create preview correctly models new_python runtime, sftp, and domain targets without blockers', async () => {
  const state = await fixture();
  const input = pythonInput(state.serverId);

  const preview = await previewSiteCreate({
    input,
    registry: state.registry,
    applicationRegistry: state.applicationRegistry,
    dockerWorkloadRegistry: state.dockerWorkloadRegistry,
    websiteRegistry: state.websiteRegistry,
    domainRegistry: state.domainRegistry,
    mailDomainRegistry: state.mailDomainRegistry,
  });

  assert.equal(preview.plan.runtime.type, 'python');
  assert.equal(preview.plan.runtime.adapter, 'gunicorn');
  assert.equal(preview.plan.sftp.adapter, 'openssh-internal-sftp');
  assert.equal(preview.plan.primaryDomain.targetType, 'python');
  assert.equal(preview.plan.primaryDomain.target.proxyMode, 'unix_socket');
  assert.match(preview.plan.primaryDomain.target.socketPath, /^\/run\/yunpanel\/python-[0-9a-f-]{36}\.sock$/);
  assert.equal(preview.complete, false);
  assert.deepEqual(preview.blockers, []);

  const plan = siteCreateProvisioningPlan(preview);
  const stepIds = plan.steps.map((step) => step.id);
  assert.deepEqual(stepIds, [
    'application_metadata',
    'website_metadata',
    'primary_domain_metadata',
    'unix_identity',
    'elfinder',
    'python_release',
    'python_runtime',
    'nginx',
    'domain_activation',
    'python_health',
    'application_release',
  ]);

  const releaseStep = plan.steps.find((step) => step.id === 'python_release');
  assert.equal(releaseStep.intent.adapter, 'python-release');
  assert.equal(releaseStep.intent.applicationId, preview.plan.application.id);
  assert.equal(releaseStep.intent.deploymentId, preview.operationId);

  const runtimeStep = plan.steps.find((step) => step.id === 'python_runtime');
  assert.equal(runtimeStep.intent.adapter, 'python-runtime');
  assert.equal(runtimeStep.intent.applicationId, preview.plan.application.id);

  const nginxStep = plan.steps.find((step) => step.id === 'nginx');
  assert.equal(nginxStep.intent.targetType, 'python');
  assert.equal(nginxStep.intent.target.adapter, 'python-runtime');

  const healthStep = plan.steps.find((step) => step.id === 'python_health');
  assert.equal(healthStep.intent.adapter, 'python-health');
  assert.equal(healthStep.intent.healthPath, '/health');
  assert.equal(healthStep.intent.timeoutSeconds, 15);

  const appReleaseStep = plan.steps.find((step) => step.id === 'application_release');
  assert.equal(appReleaseStep.intent.adapter, 'python-application-release');
  assert.equal(appReleaseStep.intent.releaseId, preview.operationId);
});

test('createSite successfully creates Python Application, Website, and Domain metadata', async () => {
  const state = await fixture();
  const input = pythonInput(state.serverId, {
    source: {
      kind: 'new_python',
      repositoryUrl: 'https://github.com/example/fastapi-prod',
      branch: 'main',
      runtime: {
        pythonVersion: '3.12',
        appServer: 'uvicorn',
        entryPoint: 'main:app',
        workers: 4,
      },
    },
  });

  const preview = await previewSiteCreate({
    input,
    registry: state.registry,
    applicationRegistry: state.applicationRegistry,
    dockerWorkloadRegistry: state.dockerWorkloadRegistry,
    websiteRegistry: state.websiteRegistry,
    domainRegistry: state.domainRegistry,
    mailDomainRegistry: state.mailDomainRegistry,
  });

  const result = await createSite({
    input,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
    registry: state.registry,
    applicationRegistry: state.applicationRegistry,
    dockerWorkloadRegistry: state.dockerWorkloadRegistry,
    websiteRegistry: state.websiteRegistry,
    domainRegistry: state.domainRegistry,
    mailDomainRegistry: state.mailDomainRegistry,
  });

  assert.equal(result.website.runtimeType, 'python');
  assert.equal(result.application.type, 'python');
  assert.equal(result.primaryDomain.targetType, 'python');
  assert.equal((await state.applicationRegistry.listApplications()).length, 1);
  assert.equal((await state.websiteRegistry.listWebsites()).length, 1);
  assert.equal((await state.domainRegistry.listDomains()).length, 1);

  const resumedPreview = await previewSiteCreate({
    input,
    registry: state.registry,
    applicationRegistry: state.applicationRegistry,
    dockerWorkloadRegistry: state.dockerWorkloadRegistry,
    websiteRegistry: state.websiteRegistry,
    domainRegistry: state.domainRegistry,
    mailDomainRegistry: state.mailDomainRegistry,
  });
  assert.equal(resumedPreview.complete, true);
  assert.equal(resumedPreview.steps.applicationReady, true);
  assert.equal(resumedPreview.steps.websiteReady, true);
  assert.equal(resumedPreview.steps.primaryDomainReady, true);
});
