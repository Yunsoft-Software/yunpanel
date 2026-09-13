import assert from 'node:assert/strict';
import test from 'node:test';
import { previewResourceImpact } from '../src/resource-impact.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const websiteId = '5b504f8f-4341-4a55-a6fb-86c6eb282e61';
const projectId = '70b6a777-5fdf-4e64-89e8-14bf2e34953e';

function fixture(bindingOverrides = {}) {
  const binding = Object.freeze({
    projectId,
    serviceName: 'web',
    targetPort: 3000,
    protocol: 'tcp',
    ...bindingOverrides,
  });
  const website = Object.freeze({
    id: websiteId,
    serverId,
    name: 'Compose Website',
    applicationId: null,
    dockerWorkloadId: null,
    managedComposeBinding: binding,
    runtimeType: 'docker',
    revision: 4,
  });
  const domain = Object.freeze({
    id: 'compose-domain',
    serverId,
    websiteId,
    primaryDomain: 'compose.example.test',
    aliases: [],
    parentDomainId: null,
    targetType: 'proxy',
    state: 'active',
    httpsMode: 'off',
    certificateId: null,
    desiredRevision: 2,
    appliedRevision: 2,
  });
  const job = Object.freeze({
    id: 'compose-job-1',
    serverId,
    type: 'docker.compose.restart',
    operation: 'docker.compose.restart',
    resourceType: 'docker_project',
    resourceId: projectId,
    status: 'running',
  });
  let providerContext = null;
  return {
    binding,
    website,
    domain,
    job,
    context: () => providerContext,
    dependencies: {
      registry: { async getServer(id) { return id === serverId ? { id } : null; } },
      applicationRegistry: { async getApplication() { return null; } },
      websiteRegistry: { async getWebsite(id) { return id === websiteId ? website : null; } },
      domainRegistry: {
        async getDomain(id) { return id === domain.id ? domain : null; },
        async listDomains() { return [domain]; },
      },
      certificateRegistry: { async listCertificates() { return []; } },
      jobRegistry: { async listJobs() { return [job]; } },
      dnsHostingRegistry: { async listZones() { return []; } },
      mailDomainRegistry: { async listMailDomains() { return []; } },
      additionalProviders: {
        mailboxes: async () => [],
        backups: async (context) => { providerContext = context; return []; },
        crons: async () => [],
        dockerWorkloads: async () => [],
      },
    },
  };
}

test('managed Compose Website impact exposes only binding identity and active project jobs', async () => {
  const state = fixture();
  const preview = await previewResourceImpact({
    resourceType: 'website',
    resourceId: websiteId,
    operation: 'delete',
    ...state.dependencies,
  });

  assert.deepEqual(preview.resource.managedComposeBinding, state.binding);
  assert.deepEqual(preview.dependencies.managedComposeBinding, state.binding);
  assert.deepEqual(preview.dependencies.activeJobs.map((item) => item.id), [state.job.id]);
  assert.equal(preview.dependencies.application, null);
  assert.equal(preview.resource.dockerWorkloadId, null);
  assert.equal(state.context().dockerProjectId, projectId);
  assert.equal(state.context().dockerWorkloadId, null);
  assert.ok(preview.blockers.some((item) => item.code === 'managed_compose_binding_present'
    && item.resourceType === 'docker_project' && item.count === 1));
  assert.ok(preview.blockers.some((item) => item.code === 'active_jobs_present' && item.count === 1));
  assert.equal(preview.safeToApply, false);
  assert.doesNotMatch(JSON.stringify(preview), /compose\.ya?ml|environment|credential|secret|publishedPort/);
});

test('managed Compose impact rejects malformed binding metadata instead of guessing', async () => {
  const state = fixture({ targetPort: 0 });
  await assert.rejects(
    previewResourceImpact({
      resourceType: 'website',
      resourceId: websiteId,
      operation: 'delete',
      ...state.dependencies,
    }),
    (error) => error?.code === 'managed_compose_impact_invalid' && error?.status === 409,
  );
});
