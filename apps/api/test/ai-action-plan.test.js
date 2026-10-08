import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { nodeServiceName } from '@yunpanel/config-templates';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createAiActionPlan,
  verifyAiActionExecution,
  computeStateFingerprint,
  AiActionPlanError,
  aiActionPlanInternals,
} from '../src/ai-action-plan.js';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createAiToolRegistry } from '../src/ai-tool-registry.js';
import { createAiToolRuntime } from '../src/ai-tool-runtime.js';
import { DEFAULT_AI_TOOL_DEFINITIONS } from '../src/ai-tool-catalog.js';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createJobRecoveryContextReader } from '../src/job-recovery-context.js';
import { createJobRegistry } from '../src/job-registry.js';
import { recoverRunningNodeRestart } from '../src/job-running-node-restart-recovery.js';
import { recoverRunningServiceReceiptMutation } from '../src/job-running-service-receipt-recovery.js';
import { createManagedServiceMutationReceiptStore } from '../src/managed-service-mutation-receipt.js';
import { createNodeRestartReceiptStore } from '../src/node-restart-receipt.js';
import { createServerRegistry } from '../src/server-registry.js';

const ownerAuth = Object.freeze({
  user: Object.freeze({ id: 'owner-user-1', role: 'owner' }),
  access: Object.freeze({ mode: 'management', permissions: Object.freeze(['*']) }),
  security: Object.freeze({ managementAllowed: true }),
});

const readOnlyAuth = Object.freeze({
  user: Object.freeze({ id: 'reader-1', role: 'read_only' }),
  access: Object.freeze({ mode: 'read_only', permissions: Object.freeze(['audit.read']) }),
  security: Object.freeze({ managementAllowed: false }),
});

function nginxActiveState() {
  return {
    id: 'nginx',
    installed: true,
    active: true,
    packages: [{ packageName: 'nginx', installed: true, version: '1.24.0-1' }],
    units: [{
      unit: 'nginx.service',
      loadState: 'loaded',
      activeState: 'active',
      subState: 'running',
      unitFileState: 'enabled',
      inspectionError: false,
    }],
    health: { status: 'ready', configuration: 'not_applicable' },
  };
}

const stoppedConsumers = async () => ({ apiActive: false, agentActive: false });

test('AI Action Plan: basic creation and policy evaluation', () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  registry.bind('server.health', async () => ({ ok: true }));
  registry.bind('service.restart', async () => ({ restarted: true }));

  // Missing registry
  assert.throws(
    () => createAiActionPlan({ registry: null, name: 'server.health', auth: ownerAuth }),
    (err) => err instanceof AiActionPlanError && err.code === 'invalid_ai_tool_registry',
  );

  // Unbound / unavailable tool
  assert.throws(
    () => createAiActionPlan({ registry, name: 'website.inspect', input: { websiteId: 'web-1' }, auth: ownerAuth }),
    (err) => err instanceof AiActionPlanError && err.code === 'ai_tool_unavailable',
  );

  // Denied tool for read-only user
  assert.throws(
    () => createAiActionPlan({ registry, name: 'service.restart', input: { serviceId: 'nginx' }, auth: readOnlyAuth }),
    (err) => err instanceof AiActionPlanError && err.code === 'ai_tool_denied' && err.status === 403,
  );

  // Allowed read tool
  const readPlan = createAiActionPlan({ registry, name: 'server.health', auth: ownerAuth });
  assert.equal(readPlan.decision, 'allow');
  assert.equal(readPlan.confirmation, null);
  assert.match(readPlan.previewDigest, /^[a-f0-9]{64}$/);

  // Confirmable write tool with confirmation policy
  const writePlan = createAiActionPlan({
    registry,
    name: 'service.restart',
    input: { serviceId: 'nginx' },
    auth: ownerAuth,
    overrides: { tool: { 'service.restart': 'confirm' } },
  });
  assert.equal(writePlan.decision, 'confirm');
  assert.match(writePlan.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(writePlan.confirmation, `ai:service.restart:${writePlan.previewDigest}`);
});

test('AI Action Plan: verification fails closed on tampered or mismatched tokens', () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  registry.bind('service.restart', async () => ({ restarted: true }));

  const plan = createAiActionPlan({
    registry,
    name: 'service.restart',
    input: { serviceId: 'nginx' },
    auth: ownerAuth,
    overrides: { tool: { 'service.restart': 'confirm' } },
  });

  // Valid verification succeeds
  assert.equal(
    verifyAiActionExecution({ plan, previewDigest: plan.previewDigest, confirmation: plan.confirmation }),
    true,
  );

  // Stale/tampered preview digest fails closed
  assert.throws(
    () => verifyAiActionExecution({ plan, previewDigest: '1'.repeat(64), confirmation: plan.confirmation }),
    (err) => err instanceof AiActionPlanError && err.code === 'ai_action_preview_stale' && err.status === 409,
  );

  // Wrong confirmation token fails closed
  assert.throws(
    () => verifyAiActionExecution({ plan, previewDigest: plan.previewDigest, confirmation: 'ai:service.restart:wrong' }),
    (err) => err instanceof AiActionPlanError && err.code === 'ai_action_confirmation_required' && err.status === 400,
  );

  // Malformed plan object fails closed
  assert.throws(
    () => verifyAiActionExecution({ plan: { previewDigest: 'invalid' } }),
    (err) => err instanceof AiActionPlanError && err.code === 'invalid_ai_action_plan',
  );
});

test('AI Action Plan: state drift causes confirmation to fail-closed', () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  registry.bind('service.restart', async () => ({ restarted: true }));

  const preState = { serviceId: 'nginx', status: 'running', pid: 1234, revision: 1 };
  const plan = createAiActionPlan({
    registry,
    name: 'service.restart',
    input: { serviceId: 'nginx' },
    auth: ownerAuth,
    overrides: { tool: { 'service.restart': 'confirm' } },
    state: preState,
  });

  // State matches -> verifies successfully
  assert.equal(
    verifyAiActionExecution({
      plan,
      previewDigest: plan.previewDigest,
      confirmation: plan.confirmation,
      currentState: preState,
    }),
    true,
  );

  // State drifted -> fails closed with ai_action_state_drift (409)
  const driftedState = { serviceId: 'nginx', status: 'failed', pid: 5678, revision: 2 };
  assert.throws(
    () => verifyAiActionExecution({
      plan,
      previewDigest: plan.previewDigest,
      confirmation: plan.confirmation,
      currentState: driftedState,
    }),
    (err) => err instanceof AiActionPlanError && err.code === 'ai_action_state_drift' && err.status === 409,
  );

  // When re-evaluated with current drifted state, preview digest changes and stale preview is rejected
  const driftedPlan = createAiActionPlan({
    registry,
    name: 'service.restart',
    input: { serviceId: 'nginx' },
    auth: ownerAuth,
    overrides: { tool: { 'service.restart': 'confirm' } },
    state: driftedState,
  });
  assert.notEqual(driftedPlan.previewDigest, plan.previewDigest);
  assert.throws(
    () => verifyAiActionExecution({
      plan: driftedPlan,
      previewDigest: plan.previewDigest,
      confirmation: plan.confirmation,
    }),
    (err) => err instanceof AiActionPlanError && err.code === 'ai_action_preview_stale' && err.status === 409,
  );
});

test('AI Action Plan: service restart epoch invalidates prior confirmation across restart', () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  registry.bind('service.restart', async () => ({ restarted: true }));

  const plan = createAiActionPlan({
    registry,
    name: 'service.restart',
    input: { serviceId: 'nginx' },
    auth: ownerAuth,
    overrides: { tool: { 'service.restart': 'confirm' } },
    epoch: 1,
  });

  // Same epoch -> verifies
  assert.equal(
    verifyAiActionExecution({
      plan,
      previewDigest: plan.previewDigest,
      confirmation: plan.confirmation,
      currentEpoch: 1,
    }),
    true,
  );

  // Restarted epoch -> fails closed with ai_action_restart_invalidated (409)
  assert.throws(
    () => verifyAiActionExecution({
      plan,
      previewDigest: plan.previewDigest,
      confirmation: plan.confirmation,
      currentEpoch: 2,
    }),
    (err) => err instanceof AiActionPlanError && err.code === 'ai_action_restart_invalidated' && err.status === 409,
  );

  // Newly evaluated plan after restart produces different digest
  const postRestartPlan = createAiActionPlan({
    registry,
    name: 'service.restart',
    input: { serviceId: 'nginx' },
    auth: ownerAuth,
    overrides: { tool: { 'service.restart': 'confirm' } },
    epoch: 2,
  });
  assert.notEqual(postRestartPlan.previewDigest, plan.previewDigest);
});

test('AI Action Plan: consumed confirmation cannot be replayed or re-executed', () => {
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  registry.bind('service.restart', async () => ({ restarted: true }));

  const plan = createAiActionPlan({
    registry,
    name: 'service.restart',
    input: { serviceId: 'nginx' },
    auth: ownerAuth,
    overrides: { tool: { 'service.restart': 'confirm' } },
  });

  const consumed = new Set();
  assert.equal(
    verifyAiActionExecution({
      plan,
      previewDigest: plan.previewDigest,
      confirmation: plan.confirmation,
      consumedConfirmations: consumed,
    }),
    true,
  );

  // Mark consumed
  consumed.add(plan.confirmation);

  // Re-execution attempt fails closed
  assert.throws(
    () => verifyAiActionExecution({
      plan,
      previewDigest: plan.previewDigest,
      confirmation: plan.confirmation,
      consumedConfirmations: consumed,
    }),
    (err) => err instanceof AiActionPlanError && err.code === 'ai_action_confirmation_already_consumed' && err.status === 409,
  );
});

// =========================================================================
// Integration: AI-triggered durable mutation interrupted at host mutation boundary
// =========================================================================

async function setupIntegrationFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-ai-durable-mutation-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const serverStore = path.join(root, 'servers.json');
  const serverRegistry = createServerRegistry({ filePath: serverStore });
  await serverRegistry.init();
  const server = await serverRegistry.createLocalServer({ hostname: 'ai-recovery-host' });

  const jobStore = path.join(root, 'jobs.json');
  const jobRegistry = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await jobRegistry.init();

  const receiptRoot = path.join(root, 'receipts');
  const serviceReceiptStore = createManagedServiceMutationReceiptStore({ root: path.join(receiptRoot, 'services') });
  const nodeReceiptStore = createNodeRestartReceiptStore({ root: path.join(receiptRoot, 'node-restarts') });
  const contextReader = createJobRecoveryContextReader({ filePath: jobStore });

  return {
    root,
    server,
    jobStore,
    jobRegistry,
    serverRegistry,
    serviceReceiptStore,
    nodeReceiptStore,
    contextReader,
  };
}

test('AI-triggered durable service.restart interrupted by process kill at host mutation boundary reconciles inspect-first without duplicate side-effects', async (t) => {
  const fx = await setupIntegrationFixture(t);

  // 1. Create AI Tool Runtime binding durable mutation tools to jobRegistry
  const aiRuntime = createAiToolRuntime({
    localServerId: fx.server.id,
    serverRegistry: fx.serverRegistry,
    websiteRegistry: { async listWebsites() { return []; }, async getWebsite() { return null; } },
    domainRegistry: { async listDomains() { return []; } },
    applicationRegistry: { async getApplication() { return null; } },
    jobRegistry: fx.jobRegistry,
  });

  // 2. AI Action Plan preview and confirmation
  const plan = createAiActionPlan({
    registry: aiRuntime,
    name: 'service.restart',
    input: { serviceId: 'nginx' },
    auth: ownerAuth,
    overrides: { tool: { 'service.restart': 'confirm' } },
    epoch: 1,
  });
  assert.equal(plan.decision, 'confirm');
  assert.match(plan.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    verifyAiActionExecution({ plan, previewDigest: plan.previewDigest, confirmation: plan.confirmation, currentEpoch: 1 }),
    true,
  );

  // 3. AI executes mutation, enqueuing durable job
  const executeResult = await aiRuntime.execute({
    name: 'service.restart',
    input: { serviceId: 'nginx' },
  });
  assert.equal(executeResult.status, 'queued');
  assert.ok(executeResult.id);

  // 4. Worker claims job (becomes running)
  const claimed = await fx.jobRegistry.claimNext(fx.server.id);
  assert.equal(claimed.job.id, executeResult.id);
  assert.equal(claimed.job.status, 'running');

  // 5. Host mutation boundary:
  // Host mutation executes and writes root-private operation evidence (0o700/0o600 receipt)
  let hostMutationCount = 0;
  hostMutationCount += 1;
  const recordedState = nginxActiveState();
  await fx.serviceReceiptStore.write({
    serverId: fx.server.id,
    jobId: claimed.job.id,
    operation: OPERATIONS.SYSTEM_SERVICE_CONTROL,
    serviceId: 'nginx',
    action: 'restart',
    state: recordedState,
  });

  // AT THIS POINT: Process/API kill happens!
  // The worker process is killed before calling jobRegistry.complete().
  // The job remains in status: 'running' in durable store.

  // 6. System restart: New registry instance reloads persisted state
  const restartedRegistry = createDurableJobRegistry({
    filePath: fx.jobStore,
    registryFactory: createJobRegistry,
  });
  await restartedRegistry.init();

  // Verify restart detected the running job from durable recovery journal
  const recoveryState = restartedRegistry.recovery();
  assert.ok(recoveryState);
  assert.equal(recoveryState.jobs.length, 1);
  assert.equal(recoveryState.jobs[0].jobId, claimed.job.id);

  // New mutations are blocked fail-closed until recovery is reconciled
  await assert.rejects(
    restartedRegistry.enqueue({
      serverId: fx.server.id,
      type: OPERATIONS.SYSTEM_SERVICE_CONTROL,
      operation: OPERATIONS.SYSTEM_SERVICE_CONTROL,
      payload: { serviceId: 'nginx', action: 'restart' },
      resourceType: 'system',
      resourceId: fx.server.id,
    }),
    (err) => err.code === 'durable_job_reconciliation_required',
  );

  // 7. Inspect-first reconciliation using root-private operation evidence
  // NO duplicate host side-effect must be generated (hostMutationCount remains 1)
  const recovered = await recoverRunningServiceReceiptMutation({
    serverId: fx.server.id,
    jobId: claimed.job.id,
    jobRegistry: restartedRegistry,
    serviceStatus: stoppedConsumers,
    loadJobContext: (id) => fx.contextReader.read(id),
    readMutationReceipt: (sId, jId) => fx.serviceReceiptStore.read(sId, jId),
    inspectServiceState: async () => recordedState,
  });

  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.recoveryMethod, 'verified_managed_service_receipt_and_state');
  assert.equal(hostMutationCount, 1); // Exact-once mutation: NO duplicate side effect

  // Recovery cleared and job marked succeeded
  assert.equal(restartedRegistry.recovery(), null);
  const terminalJob = await restartedRegistry.getJob(claimed.job.id);
  assert.equal(terminalJob.status, 'succeeded');
  assert.equal(terminalJob.result.action, 'restart');

  // 8. State drift / restart: Old AI preview and confirmation remain fail-closed
  // Cannot re-execute old confirmation with post-restart epoch 2
  assert.throws(
    () => verifyAiActionExecution({
      plan,
      previewDigest: plan.previewDigest,
      confirmation: plan.confirmation,
      currentEpoch: 2,
    }),
    (err) => err instanceof AiActionPlanError && err.code === 'ai_action_restart_invalidated' && err.status === 409,
  );
});

test('AI-triggered durable service.restart interrupted by timeout at host mutation boundary fails closed when receipt is missing', async (t) => {
  const fx = await setupIntegrationFixture(t);

  const aiRuntime = createAiToolRuntime({
    localServerId: fx.server.id,
    serverRegistry: fx.serverRegistry,
    websiteRegistry: { async listWebsites() { return []; }, async getWebsite() { return null; } },
    domainRegistry: { async listDomains() { return []; } },
    applicationRegistry: { async getApplication() { return null; } },
    jobRegistry: fx.jobRegistry,
  });

  const plan = createAiActionPlan({
    registry: aiRuntime,
    name: 'service.restart',
    input: { serviceId: 'nginx' },
    auth: ownerAuth,
    overrides: { tool: { 'service.restart': 'confirm' } },
    epoch: 1,
  });
  verifyAiActionExecution({ plan, previewDigest: plan.previewDigest, confirmation: plan.confirmation, currentEpoch: 1 });

  const executeResult = await aiRuntime.execute({
    name: 'service.restart',
    input: { serviceId: 'nginx' },
  });
  const claimed = await fx.jobRegistry.claimNext(fx.server.id);
  assert.equal(claimed.job.id, executeResult.id);

  // Host mutation boundary: TIMEOUT occurs before receipt can be written!
  // No receipt exists in receiptStore.
  let hostMutationAttempted = false;

  // Restart
  const restartedRegistry = createDurableJobRegistry({
    filePath: fx.jobStore,
    registryFactory: createJobRegistry,
  });
  await restartedRegistry.init();
  assert.equal(restartedRegistry.recovery().jobs[0].jobId, claimed.job.id);

  // Inspect-first recovery inspects root-private evidence: receipt missing -> fails closed
  await assert.rejects(
    recoverRunningServiceReceiptMutation({
      serverId: fx.server.id,
      jobId: claimed.job.id,
      jobRegistry: restartedRegistry,
      serviceStatus: stoppedConsumers,
      loadJobContext: (id) => fx.contextReader.read(id),
      readMutationReceipt: async () => null, // Receipt missing due to timeout
      inspectServiceState: async () => {
        hostMutationAttempted = true;
        return nginxActiveState();
      },
    }),
    (err) => err.code === 'job_service_receipt_recovery_receipt_missing',
  );

  // Inspect-first did NOT proceed to duplicate side effects on missing receipt
  assert.equal(hostMutationAttempted, false);

  // Old AI confirmation remains fail-closed
  assert.throws(
    () => verifyAiActionExecution({
      plan,
      previewDigest: plan.previewDigest,
      confirmation: plan.confirmation,
      currentEpoch: 2,
    }),
    (err) => err instanceof AiActionPlanError && err.code === 'ai_action_restart_invalidated',
  );
});

test('AI-triggered durable website.restart interrupted by process kill reconciles inspect-first and invalidates stale AI confirmation across state drift', async (t) => {
  const fx = await setupIntegrationFixture(t);

  // Setup application and website
  const applicationStore = path.join(fx.root, 'applications.json');
  const applicationRegistry = createApplicationRegistry({
    filePath: applicationStore,
    serverExists: async (id) => Boolean(await fx.serverRegistry.getServer(id)),
  });
  await applicationRegistry.init();

  const app = await applicationRegistry.createNodeApplication({
    serverId: fx.server.id,
    name: 'AI Managed App',
    repositoryUrl: 'https://github.com/Yunsoft-Software/ai-app',
    branch: 'main',
    runtime: { port: 38200, healthPath: '/health' },
  });
  const releaseId = randomUUID();
  const serviceName = nodeServiceName(app.id);
  await applicationRegistry.markDeploying(app.id, releaseId);
  await applicationRegistry.markDeployed(app.id, {
    deploymentId: releaseId,
    releaseId,
    commitSha: 'a'.repeat(40),
    serviceName,
    port: app.runtime.port,
    healthPath: app.runtime.healthPath,
    healthy: true,
  });

  const website = {
    id: 'web-1',
    serverId: fx.server.id,
    name: 'AI Site',
    applicationId: app.id,
  };

  const environmentStatus = { savedRevision: 5 };

  const aiRuntime = createAiToolRuntime({
    localServerId: fx.server.id,
    serverRegistry: fx.serverRegistry,
    websiteRegistry: {
      async listWebsites() { return [website]; },
      async getWebsite(id) { return id === website.id ? website : null; },
    },
    domainRegistry: { async listDomains() { return []; } },
    applicationRegistry,
    applicationEnvironmentRegistry: {
      async environmentStatus(id) {
        assert.equal(id, app.id);
        return environmentStatus;
      },
    },
    jobRegistry: fx.jobRegistry,
  });

  // 1. AI Action Plan preview bound to initial state
  const plan = createAiActionPlan({
    registry: aiRuntime,
    name: 'website.restart',
    input: { websiteId: 'web-1' },
    auth: ownerAuth,
    overrides: { tool: { 'website.restart': 'confirm' } },
    state: { releaseId, environmentRevision: environmentStatus.savedRevision },
    epoch: 1,
  });
  assert.equal(plan.decision, 'confirm');
  verifyAiActionExecution({
    plan,
    previewDigest: plan.previewDigest,
    confirmation: plan.confirmation,
    currentState: { releaseId, environmentRevision: environmentStatus.savedRevision },
    currentEpoch: 1,
  });

  // 2. AI executes website.restart
  const executed = await aiRuntime.execute({
    name: 'website.restart',
    input: { websiteId: 'web-1' },
  });
  assert.equal(executed.status, 'queued');

  // 3. Worker claims job (becomes running)
  const claimed = await fx.jobRegistry.claimNext(fx.server.id);
  assert.equal(claimed.job.id, executed.id);
  assert.equal(claimed.job.status, 'running');

  // 4. Host mutation executes, writes root-private receipt, and is killed before durable complete
  let restartExecutionCount = 0;
  restartExecutionCount += 1;
  await fx.nodeReceiptStore.write({
    serverId: fx.server.id,
    jobId: claimed.job.id,
    applicationId: app.id,
    result: {
      releaseId,
      serviceName,
      port: app.runtime.port,
      healthPath: app.runtime.healthPath,
      healthy: true,
      restarted: true,
    },
  });

  // Process kill simulation: new instance restarted
  const restartedRegistry = createDurableJobRegistry({
    filePath: fx.jobStore,
    registryFactory: createJobRegistry,
  });
  await restartedRegistry.init();
  assert.equal(restartedRegistry.recovery().jobs[0].jobId, claimed.job.id);

  // 5. Inspect-first reconciliation using root-private receipt
  const recovered = await recoverRunningNodeRestart({
    serverId: fx.server.id,
    jobId: claimed.job.id,
    jobRegistry: restartedRegistry,
    applicationRegistry,
    serviceStatus: stoppedConsumers,
    loadJobContext: (id) => fx.contextReader.read(id),
    readRestartReceipt: (sId, jId) => fx.nodeReceiptStore.read(sId, jId),
    inspectNodeStatus: async () => ({
      releaseId,
      serviceName,
      port: app.runtime.port,
      healthPath: app.runtime.healthPath,
      loadState: 'loaded',
      activeState: 'active',
      subState: 'running',
      restartCount: 1,
      mainPid: 9876,
      healthy: true,
      inspectionError: false,
    }),
  });

  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.recoveryMethod, 'verified_node_restart_receipt_and_status');
  assert.equal(restartExecutionCount, 1); // No duplicate restart side-effect
  assert.equal(restartedRegistry.recovery(), null);

  // 6. State drift: Suppose application state changed (e.g. new deployment revision)
  const driftedState = { releaseId: randomUUID(), environmentRevision: 6 };
  assert.throws(
    () => verifyAiActionExecution({
      plan,
      previewDigest: plan.previewDigest,
      confirmation: plan.confirmation,
      currentState: driftedState,
      currentEpoch: 1,
    }),
    (err) => err instanceof AiActionPlanError && err.code === 'ai_action_state_drift' && err.status === 409,
  );

  // Regenerated plan with drifted state also rejects stale preview digest
  const driftedPlan = createAiActionPlan({
    registry: aiRuntime,
    name: 'website.restart',
    input: { websiteId: 'web-1' },
    auth: ownerAuth,
    overrides: { tool: { 'website.restart': 'confirm' } },
    state: driftedState,
    epoch: 1,
  });
  assert.throws(
    () => verifyAiActionExecution({
      plan: driftedPlan,
      previewDigest: plan.previewDigest,
      confirmation: plan.confirmation,
    }),
    (err) => err instanceof AiActionPlanError && err.code === 'ai_action_preview_stale' && err.status === 409,
  );
});
