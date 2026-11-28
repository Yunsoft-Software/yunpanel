import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteRemovalPreview } from '../src/websites/website-removal-plan.js';
import { createWebsiteRemovalOperationRegistry } from '../src/websites/website-removal-operation-registry.js';
import { createWebsiteRemovalRuntime } from '../src/websites/website-removal-runtime.js';

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
  let current = state.website; let finalized = false; const cleanupCalls = [];
  const runtime = createWebsiteRemovalRuntime({ registry, domainRemovalRuntime: { preview: async () => {}, start: async () => {}, continueStep: async () => {}, listForDomain: async () => [] }, previewProvider: async () => preview,
    domainRegistry: { listDomains: async () => [] },
    websiteRegistry: { getWebsite: async () => current, finalizeWebsiteRemoval: async () => { finalized = true; current = null; } },
    // Compose-bound sites have no application files or Unix identity to delete. T972: file
    // cleanup only removes the Website backup resource folder (adapter covered in
    // website-removal-managed-compose-backup-resources.test.js); the project is retained.
    fileCleanupInspector: async () => ({ ready: true }),
    fileCleanupHandler: async (input) => {
      cleanupCalls.push(input);
      return { websiteId: input.websiteId, applicationId: null, retainedBackups: [], retainedLogScopes: [], filesCleaned: true, cleanedFilesCount: 1 };
    },
  });
  const ready = await runtime.preview({ websiteId: state.website.id });
  assert.equal(ready.readyToStart, true);
  if (drift) current = { ...current, managedComposeBinding: { ...current.managedComposeBinding, targetPort: 8080 } };
  let result = await runtime.start({ websiteId: state.website.id, previewDigest: ready.previewDigest, confirmation: ready.confirmation });
  assert.deepEqual(result.steps.map(s => s.kind), ['file_cleanup', 'metadata_finalization']);
  if (!drift) {
    assert.deepEqual(cleanupCalls, [{ websiteId: state.website.id, applicationId: null, retainedBackups: [], retainedLogScopes: [] }]);
    result = await runtime.continueStep({ websiteId: result.websiteId, operationId: result.id,
      stepId: result.steps[1].id, expectedUpdatedAt: result.updatedAt, confirmation: result.actions.stepContinuationConfirmation });
  }
  assert.equal(finalized, !drift);
  assert.equal(result.status, drift ? 'failed' : 'removed');
  if (drift) {
    assert.equal(result.steps[0].error.code, 'website_removal_state_mismatch');
    assert.deepEqual(cleanupCalls, [], 'binding drift must stop before any cleanup');
  } else assert.equal(result.steps[1].result.retainedDockerProjectId, state.website.managedComposeBinding.projectId);
});
