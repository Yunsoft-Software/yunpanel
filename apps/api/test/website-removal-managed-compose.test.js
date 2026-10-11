import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteRemovalPreview } from '../src/website-removal-plan.js';
import { createWebsiteRemovalOperationRegistry } from '../src/website-removal-operation-registry.js';
import { createWebsiteRemovalRuntime } from '../src/website-removal-runtime.js';

function fixture() {
  const binding = { projectId: '70b6a777-5fdf-4e64-89e8-14bf2e34953e', serviceName: 'web', targetPort: 80, protocol: 'tcp' };
  const website = { id: 'ws-1', serverId: 'srv-1', name: 'docker.example.test', applicationId: null,
    unixUser: null, managedComposeBinding: binding, runtimeType: 'docker', revision: 4 };
  const dependencies = { domains: [], managedComposeBinding: binding, activeJobs: [] };
  for (const name of ['databases', 'sftpKeys', 'runtimeBindings', 'unixIdentities', 'logScopes', 'crons', 'backups']) dependencies[name] = { status: 'available', items: [] };
  const impact = { version: 1, resourceType: 'website', resource: { id: website.id, serverId: website.serverId }, operation: 'delete', targetServerId: null,
    dependencies, blockers: [{ code: 'managed_compose_binding_present' }], previewDigest: 'a'.repeat(64), confirmation: 'delete:website:ws-1:' + 'a'.repeat(64) };
  return { website, impact };
}

test('Compose Website removal pins the exact retained project and rejects mismatched binding evidence or active jobs', () => {
  const state = fixture(); const preview = createWebsiteRemovalPreview(state);
  assert.equal(preview.readyToStart, true);
  assert.equal(preview.plan.retainedDockerProjectId, state.website.managedComposeBinding.projectId);
  state.impact.dependencies.activeJobs = ['compose-start'];
  assert.deepEqual(createWebsiteRemovalPreview(state).hardBlockers, ['active_jobs_present']);
  state.impact.dependencies.managedComposeBinding = { ...state.website.managedComposeBinding, targetPort: 8080 };
  assert.throws(() => createWebsiteRemovalPreview(state), { code: 'website_removal_compose_identity_invalid' });
});

for (const drift of [false, true]) test(`Compose site metadata retirement preserves workloads and fails closed on binding drift: ${drift}`, async () => {
  const state = fixture(); const preview = createWebsiteRemovalPreview(state);
  const registry = createWebsiteRemovalOperationRegistry(); await registry.init();
  let current = state.website; let finalized = false;
  const runtime = createWebsiteRemovalRuntime({ registry, domainRemovalRuntime: { preview: async () => {}, start: async () => {}, continueStep: async () => {}, listForDomain: async () => [] }, previewProvider: async () => preview,
    domainRegistry: { listDomains: async () => [] },
    websiteRegistry: { getWebsite: async () => current, finalizeWebsiteRemoval: async () => { finalized = true; current = null; } },
    // Compose-bound sites have no application files or Unix identity to delete.
    fileCleanupHandler: async () => { throw new Error('must not remove project or host files'); },
  });
  const created = await registry.create(preview);
  const operation = await runtime.get(created.id);
  assert.deepEqual(operation.steps.map(s => s.kind), ['metadata_finalization']);
  if (drift) current = { ...current, managedComposeBinding: { ...current.managedComposeBinding, targetPort: 8080 } };
  const result = await runtime.continueStep({ websiteId: operation.websiteId, operationId: operation.id,
    stepId: operation.steps[0].id, expectedUpdatedAt: operation.updatedAt, confirmation: operation.actions.stepContinuationConfirmation });
  assert.equal(finalized, !drift);
  assert.equal(result.status, drift ? 'failed' : 'removed');
  if (drift) assert.equal(result.steps[0].error.code, 'website_removal_state_mismatch');
  else assert.equal(result.steps[0].result.retainedDockerProjectId, state.website.managedComposeBinding.projectId);
});
