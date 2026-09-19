import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createDockerWorkloadRegistry } from '../src/docker-workload-registry.js';
import { createMailDomainRegistry } from '../src/mail-domain-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createSite, previewSiteCreate } from '../src/site-create-base.js';
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
      },
    },
    ...overrides,
  };
}

test('site-create preview correctly models new_python runtime, sftp, and domain targets', async () => {
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
  assert.deepEqual(preview.blockers, ['python_runtime_unavailable']);
});

test('createSite refuses Python metadata without a working local provisioning runtime', async () => {
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

  await assert.rejects(createSite({
    input,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
    registry: state.registry,
    applicationRegistry: state.applicationRegistry,
    dockerWorkloadRegistry: state.dockerWorkloadRegistry,
    websiteRegistry: state.websiteRegistry,
    domainRegistry: state.domainRegistry,
    mailDomainRegistry: state.mailDomainRegistry,
  }), (error) => error.code === 'site_create_blocked_by_dependency'
    && error.message.includes('python_runtime_unavailable'));
  assert.deepEqual(await state.applicationRegistry.listApplications(), []);
  assert.deepEqual(await state.websiteRegistry.listWebsites(), []);
  assert.deepEqual(await state.domainRegistry.listDomains(), []);
});
