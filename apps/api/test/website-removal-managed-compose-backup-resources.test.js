import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWebsiteRemovalPreview } from '../src/websites/website-removal-plan.js';
import { createWebsiteRemovalOperationRegistry } from '../src/websites/website-removal-operation-registry.js';
import { createWebsiteRemovalRuntime } from '../src/websites/website-removal-runtime.js';
import { createWebsiteRemovalCleanupAdapters } from '../src/websites/website-removal-cleanup-adapters.js';

// T972: a Website bound to a managed Compose project must also remove its own
// backup/restore staging folder (<resources>/website/<websiteId>) with the T971
// rules, while the retained Compose project and everything else stay.

const websiteId = '11111111-1111-4111-8111-111111111111';
const otherWebsiteId = '44444444-4444-4444-8444-444444444444';
const serverId = '33333333-3333-4333-8333-333333333333';
const binding = Object.freeze({ projectId: '70b6a777-5fdf-4e64-89e8-14bf2e34953e', serviceName: 'web', targetPort: 80, protocol: 'tcp' });

async function exists(target) {
  try { await lstat(target); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function tempRoot(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'yp-t972-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function stageLeftover(resourceRoot, id = websiteId) {
  const staged = path.join(resourceRoot, 'website', id);
  await mkdir(path.join(staged, 'databases', 'website-55555555-5555-4555-8555-555555555555'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(staged, 'databases', 'website-55555555-5555-4555-8555-555555555555', 'dump.sql'), '-- dump\n', { mode: 0o600 });
  await mkdir(path.join(staged, '.database-transactions', 'tx-1'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(staged, 'env-metadata.json'), '{}\n', { mode: 0o600 });
  return staged;
}

function composePreview() {
  // Same persisted shape site-create-base.js writes for existing_managed_compose.
  const website = { id: websiteId, serverId, name: 'agent1-t972.example.test', applicationId: null, dockerWorkloadId: null,
    unixUser: null, documentRoot: null, proxyTarget: null, managedComposeBinding: { ...binding }, runtimeType: 'docker', revision: 4 };
  const dependencies = { domains: [], managedComposeBinding: { ...binding }, activeJobs: [] };
  for (const name of ['databases', 'sftpKeys', 'runtimeBindings', 'unixIdentities', 'logScopes', 'crons', 'backups']) dependencies[name] = { status: 'available', items: [] };
  const impact = { version: 1, resourceType: 'website', resource: { id: websiteId, serverId }, operation: 'delete', targetServerId: null,
    dependencies, blockers: [{ code: 'managed_compose_binding_present' }], previewDigest: 'a'.repeat(64),
    confirmation: `delete:website:${websiteId}:${'a'.repeat(64)}` };
  return { website, preview: createWebsiteRemovalPreview({ website, impact }) };
}

async function removalFixture(t, { resourceRoot, scratch, otherWebsites = [] }) {
  const { website, preview } = composePreview();
  let current = website;
  const removed = [];
  const websiteRegistry = {
    getWebsite: async (id) => (current && id === current.id ? current : null),
    listWebsites: async () => [...(current ? [current] : []), ...otherWebsites],
    finalizeWebsiteRemoval: async () => { current = null; },
  };
  const adapters = createWebsiteRemovalCleanupAdapters({
    websiteRegistry,
    applicationRegistry: { getApplication: async () => null },
    websiteProvisioningRuntime: { registry: { listForWebsite: async () => [] },
      handlers: { unix_identity: { compensate: async () => ({}), inspectCompensation: async () => ({}) } } },
    backupResourceRoot: resourceRoot,
    lstatFn: lstat,
    // Never let the test delete anything outside its own temporary directory.
    rmFn: async (target, options) => {
      if (!target.startsWith(scratch + path.sep)) throw new Error(`test refused to delete ${target}`);
      removed.push(target);
      return rm(target, options);
    },
  });
  const registry = createWebsiteRemovalOperationRegistry(); await registry.init();
  const runtime = createWebsiteRemovalRuntime({ registry,
    domainRemovalRuntime: { preview: async () => {}, start: async () => {}, continueStep: async () => {}, listForDomain: async () => [] },
    previewProvider: async () => preview,
    domainRegistry: { listDomains: async () => [] },
    websiteRegistry,
    fileCleanupHandler: adapters.fileCleanupHandler,
    fileCleanupInspector: adapters.inspectFileCleanup,
  });
  return { runtime, removed, website: () => current };
}

async function runToEnd(runtime) {
  const preview = await runtime.preview({ websiteId });
  assert.equal(preview.readyToStart, true, JSON.stringify(preview.hardBlockers));
  let operation = await runtime.start({ websiteId, previewDigest: preview.previewDigest, confirmation: preview.confirmation });
  for (let index = 0; index < 10 && !['removed', 'failed'].includes(operation.status); index += 1) {
    const step = operation.steps.find((value) => value.status !== 'succeeded');
    operation = await runtime.continueStep({ websiteId, operationId: operation.id, stepId: step.id,
      expectedUpdatedAt: operation.updatedAt, confirmation: operation.actions.stepContinuationConfirmation });
  }
  return operation;
}

test('managed Compose Website removal deletes exactly its backup resource folder and keeps the Compose project', async (t) => {
  const scratch = await tempRoot(t);
  const resourceRoot = path.join(scratch, 'backups', 'resources');
  const staged = await stageLeftover(resourceRoot);
  const sibling = await stageLeftover(resourceRoot, otherWebsiteId);
  const receipts = path.join(resourceRoot, 'website', '.database-restore-receipts');
  await mkdir(receipts, { recursive: true });
  await writeFile(path.join(receipts, 'receipt.json'), '{}\n');
  const restic = path.join(scratch, 'backups', 'restic', 'repos', 'repo-1');
  await mkdir(restic, { recursive: true });
  await writeFile(path.join(restic, 'config'), 'restic\n');
  // Stand-in for the retained Compose project directory: never part of Website removal.
  const project = path.join(scratch, 'docker', 'projects', binding.projectId);
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'docker-compose.yml'), 'services: {}\n');
  const outside = path.join(scratch, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'keep.txt'), 'keep\n');
  await symlink(outside, path.join(staged, 'escape'));

  const { runtime, removed, website } = await removalFixture(t, { resourceRoot, scratch });
  const operation = await runToEnd(runtime);
  assert.equal(operation.status, 'removed');
  assert.equal(website(), null);
  assert.equal(await exists(staged), false, 'the removed Compose Website backup resource folder must not remain');
  assert.ok(operation.steps.some((step) => step.kind === 'file_cleanup'), 'Compose removal must plan backup resource cleanup');
  assert.deepEqual(removed, [staged]);
  const finalized = operation.steps.find((step) => step.kind === 'metadata_finalization');
  assert.equal(finalized.result.retainedDockerProjectId, binding.projectId);
  assert.equal(await readFile(path.join(project, 'docker-compose.yml'), 'utf8'), 'services: {}\n');
  assert.equal(await exists(path.join(sibling, 'env-metadata.json')), true);
  assert.equal(await readFile(path.join(receipts, 'receipt.json'), 'utf8'), '{}\n');
  assert.equal(await readFile(path.join(restic, 'config'), 'utf8'), 'restic\n');
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep\n');
});

test('managed Compose Website removal without a backup resource folder still completes', async (t) => {
  const scratch = await tempRoot(t);
  const { runtime, removed } = await removalFixture(t, { resourceRoot: path.join(scratch, 'missing', 'resources'), scratch });
  const operation = await runToEnd(runtime);
  assert.equal(operation.status, 'removed');
  assert.deepEqual(removed, []);
});

test('managed Compose Website removal fails closed before deleting anything when its backup folder is a symlink', async (t) => {
  const scratch = await tempRoot(t);
  const resourceRoot = path.join(scratch, 'backups', 'resources');
  const outside = path.join(scratch, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'keep.txt'), 'keep\n');
  await mkdir(path.join(resourceRoot, 'website'), { recursive: true });
  await symlink(outside, path.join(resourceRoot, 'website', websiteId));
  const { runtime, removed, website } = await removalFixture(t, { resourceRoot, scratch });
  const preview = await runtime.preview({ websiteId });
  assert.equal(preview.readyToStart, false);
  assert.ok(preview.hardBlockers.includes('file_cleanup_preflight_failed'));
  assert.deepEqual(removed, []);
  assert.notEqual(website(), null);
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep\n');
});

test('backup resource cleanup accepts a Compose Website only with its exact Application-free identity', async (t) => {
  const scratch = await tempRoot(t);
  const resourceRoot = path.join(scratch, 'backups', 'resources');
  const staged = await stageLeftover(resourceRoot);
  const { website } = composePreview();
  for (const drift of [{ unixUser: 'yunapp-123456789abc' }, { documentRoot: '/srv/www' }, { runtimeType: 'proxy' },
    { dockerWorkloadId: '99999999-9999-4999-8999-999999999999' }]) {
    const adapters = createWebsiteRemovalCleanupAdapters({
      websiteRegistry: { getWebsite: async () => ({ ...website, ...drift }), listWebsites: async () => [] },
      applicationRegistry: { getApplication: async () => null },
      websiteProvisioningRuntime: { registry: { listForWebsite: async () => [] },
        handlers: { unix_identity: { compensate: async () => ({}), inspectCompensation: async () => ({}) } } },
      backupResourceRoot: resourceRoot,
      rmFn: async () => { throw new Error('nothing may be deleted'); },
    });
    await assert.rejects(adapters.fileCleanupHandler({ websiteId, applicationId: null }),
      { code: 'website_cleanup_application_drift' }, JSON.stringify(drift));
  }
  assert.equal(await exists(staged), true);
});
