import { createWebsiteRemovalOperationRegistry } from '../src/website-removal-operation-registry.js';
import { createWebsiteRemovalPreview } from '../src/website-removal-plan.js';
import { createWebsiteRemovalRuntime } from '../src/website-removal-runtime.js';

// Real plan, operation registry and runtime. Only host adapters are controlled here.
export function removalPreview(id = 'site-a', buckets = {}, websiteChanges = {}) {
  const website = { id, serverId: 'server-a', applicationId: 'app-a', revision: 1, ...websiteChanges };
  const dependencies = Object.fromEntries(['databases', 'sftpKeys', 'runtimeBindings', 'unixIdentities', 'logScopes', 'crons', 'backups']
    .map((key) => [key, { status: 'available', items: buckets[key] ?? [] }]));
  return createWebsiteRemovalPreview({ website, impact: {
    version: 1, resourceType: 'website', operation: 'delete', resource: { id, serverId: website.serverId },
    application: website.applicationId ? { id: website.applicationId, serverId: website.serverId, desiredRevision: 1 } : null,
    targetServerId: null, dependencies: { ...dependencies, domains: buckets.domains ?? [], activeJobs: [] },
    blockers: [], previewDigest: 'a'.repeat(64), confirmation: `delete:website:${id}:${'a'.repeat(64)}`,
  } });
}
export const removalStart = (preview) => ({ websiteId: preview.website.id, previewDigest: preview.previewDigest, confirmation: preview.confirmation });
export const removalContinue = (operation) => ({ websiteId: operation.websiteId, operationId: operation.id,
  stepId: operation.steps.find((step) => step.status !== 'succeeded')?.id,
  expectedUpdatedAt: operation.updatedAt, confirmation: operation.actions?.stepContinuationConfirmation });
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function removalFixture(overrides = {}, preview = removalPreview()) {
  let clock = 0;
  const registry = createWebsiteRemovalOperationRegistry({ now: () => new Date(++clock).toISOString() });
  await registry.init();
  const calls = [];
  const dependencies = {
    registry, previewProvider: async () => preview, domainRemovalRuntime: { start: async () => {} },
    fileCleanupHandler: async (input) => { calls.push(input); return { ...input, filesCleaned: true }; },
    fileCleanupInspector: async ({ websiteId, applicationId }) => ({ ready: true, websiteId, applicationId, targets: [] }),
    unixIdentityCleanupHandler: async (input) => ({ ...input, unixIdentityCleaned: true }),
    unixIdentityCleanupInspector: async ({ websiteId, systemUser }) => ({ ready: true, websiteId, applicationId: preview.website.applicationId, systemUser }),
    websiteRegistry: { getWebsite: async () => null, deleteMigrationWebsite: async () => {} },
    applicationRegistry: (() => { let current = preview.website.applicationId ? {
      id: preview.website.applicationId, serverId: preview.website.serverId,
      desiredRevision: preview.plan.applicationRevision, activeDeploymentId: null,
    } : null; return {
      getApplication: async () => current,
      deleteApplication: async () => { const before=current; current=null; return before ? { applicationId: before.id, deleted: true } : null; },
    }; })(),
    applicationEnvironmentRegistry: {
      inspectApplicationState: async (applicationId) => ({ applicationId, variableCount: 0, environmentPresent: false }),
      purgeApplication: async (applicationId) => ({ applicationId, variablesDeleted: 0, environmentDeleted: false, purged: true }),
    },
    ...overrides,
  };
  return { registry, preview, calls, dependencies, runtime: createWebsiteRemovalRuntime(dependencies) };
}
