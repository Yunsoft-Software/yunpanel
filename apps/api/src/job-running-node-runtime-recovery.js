import { MANAGED_NODE_RUNTIME_MAJORS, OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const VERSION_PATTERN = /^v(\d{1,2})\.\d{1,3}\.\d{1,3}$/;

export class JobRunningNodeRuntimeRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningNodeRuntimeRecoveryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new JobRunningNodeRuntimeRecoveryError(code, message);
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    fail('job_node_runtime_recovery_identity_invalid', 'Node runtime recovery job identity is invalid');
  }
  return { serverId, jobId };
}

async function requireStoppedConsumers(serviceStatus) {
  let state;
  try { state = await serviceStatus(); }
  catch { fail('job_node_runtime_recovery_service_status_unavailable', 'Could not verify YunPanel service state'); }
  if (!state || typeof state.apiActive !== 'boolean' || typeof state.agentActive !== 'boolean') {
    fail('job_node_runtime_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (state.apiActive || state.agentActive) {
    fail('job_node_runtime_recovery_consumers_must_be_stopped', 'Stop YunPanel API and legacy agent before recovering Node runtime installation');
  }
}

function assertContext(context, job, candidate, identity) {
  const payload = context?.payload;
  if (!context || context.id !== identity.jobId || context.serverId !== identity.serverId || context.status !== 'running'
    || context.operation !== OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL || context.resourceType !== 'system'
    || context.resourceId !== identity.serverId || context.resourceId !== candidate.resourceId || context.resourceId !== job.resourceId
    || !payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1
    || !Number.isInteger(payload.major) || !MANAGED_NODE_RUNTIME_MAJORS.includes(payload.major)) {
    fail('job_node_runtime_recovery_context_mismatch', 'Private Node runtime install context does not match durable job metadata');
  }
  return payload.major;
}

function installationEvidence(inventory, major) {
  const expectedPath = `/opt/yunpanel/node-runtimes/v${major}/bin/node`;
  const runtime = Array.isArray(inventory?.managedRuntimes)
    ? inventory.managedRuntimes.find((entry) => entry?.major === major)
    : null;
  const match = typeof runtime?.version === 'string' ? runtime.version.match(VERSION_PATTERN) : null;
  if (!inventory || inventory.platform !== 'linux' || !['x64', 'arm64'].includes(inventory.architecture)
    || !Array.isArray(inventory.supportedMajors)
    || inventory.supportedMajors.length !== MANAGED_NODE_RUNTIME_MAJORS.length
    || inventory.supportedMajors.some((value, index) => value !== MANAGED_NODE_RUNTIME_MAJORS[index])
    || inventory.panelRuntime?.path !== '/usr/local/bin/node' || inventory.panelRuntime?.source !== 'panel'
    || !VERSION_PATTERN.test(inventory.panelRuntime?.version ?? '')
    || !runtime || runtime.installed !== true || runtime.path !== expectedPath || !match
    || Number.parseInt(match[1], 10) !== major || !Array.isArray(runtime.packageManagers)
    || runtime.packageManagers.length !== 3
    || runtime.packageManagers.some((name, index) => name !== ['npm', 'pnpm', 'yarn'][index])) {
    fail('job_node_runtime_recovery_evidence_not_satisfied', 'Managed Node.js runtime installation is not proven by current host state');
  }
  return {
    changed: false,
    runtime: {
      path: expectedPath,
      source: 'managed',
      version: runtime.version,
      major,
      packageManagers: [...runtime.packageManagers],
    },
    inventory,
  };
}

export async function recoverRunningNodeRuntimeInstall({
  serverId,
  jobId,
  jobRegistry,
  serviceStatus,
  loadJobContext,
  inspectNodeRuntimes,
  inspect = inspectDurableJobRecovery,
  reconcile = reconcileCompletedJob,
} = {}) {
  const identity = normalizeIdentity(serverId, jobId);
  if (!jobRegistry || typeof jobRegistry.getJob !== 'function' || typeof jobRegistry.beginReconciliation !== 'function'
    || typeof jobRegistry.complete !== 'function' || typeof jobRegistry.acknowledgeReconciliation !== 'function'
    || typeof serviceStatus !== 'function' || typeof loadJobContext !== 'function'
    || typeof inspectNodeRuntimes !== 'function' || typeof inspect !== 'function' || typeof reconcile !== 'function') {
    fail('job_node_runtime_recovery_dependencies_invalid', 'Node runtime recovery dependencies are invalid');
  }
  await requireStoppedConsumers(serviceStatus);
  let recovery;
  try { recovery = await inspect({ registry: jobRegistry }); }
  catch { fail('job_node_runtime_recovery_inspection_failed', 'Durable Node runtime recovery state could not be inspected'); }
  if (!recovery || !Array.isArray(recovery.jobs)) fail('job_node_runtime_recovery_inspection_invalid', 'Durable Node runtime recovery state is invalid');
  const candidate = recovery.jobs.find((entry) => entry.jobId === identity.jobId && entry.serverId === identity.serverId) ?? null;
  if (!candidate || candidate.status !== 'running' || candidate.operation !== OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL
    || candidate.resourceType !== 'system' || candidate.resourceId !== identity.serverId) {
    fail('job_node_runtime_recovery_job_mismatch', 'Running Node runtime install recovery metadata is inconsistent');
  }
  let job;
  try { job = await jobRegistry.getJob(identity.jobId); }
  catch { fail('job_node_runtime_recovery_job_read_failed', 'Running Node runtime install job could not be read'); }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || job.operation !== OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL || job.resourceType !== 'system' || job.resourceId !== identity.serverId) {
    fail('job_node_runtime_recovery_job_mismatch', 'Running Node runtime install no longer matches durable recovery state');
  }
  let context;
  try { context = await loadJobContext(identity.jobId); }
  catch { fail('job_node_runtime_recovery_context_failed', 'Private Node runtime install context could not be read'); }
  const major = assertContext(context, job, candidate, identity);
  let inventory;
  try { inventory = await inspectNodeRuntimes(); }
  catch { fail('job_node_runtime_recovery_evidence_failed', 'Managed Node runtime host state could not be inspected'); }
  const result = installationEvidence(inventory, major);

  let begun;
  try { begun = await jobRegistry.beginReconciliation(identity); }
  catch { fail('job_node_runtime_recovery_journal_failed', 'Node runtime recovery journal could not be opened'); }
  if (!begun || begun.jobId !== identity.jobId || begun.serverId !== identity.serverId || begun.status !== 'running' || begun.pending !== true) {
    fail('job_node_runtime_recovery_journal_invalid', 'Node runtime recovery journal acknowledgement is inconsistent');
  }
  let terminal;
  try { terminal = await jobRegistry.complete({ serverId: identity.serverId, jobId: identity.jobId, status: 'succeeded', result }); }
  catch { fail('job_node_runtime_recovery_completion_failed', 'Node runtime evidence was verified but durable completion could not be confirmed'); }
  if (!terminal || terminal.id !== identity.jobId || terminal.serverId !== identity.serverId || terminal.status !== 'succeeded'
    || terminal.operation !== OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL || terminal.resourceType !== 'system' || terminal.resourceId !== identity.serverId) {
    fail('job_node_runtime_recovery_completion_invalid', 'Node runtime recovery completion acknowledgement is inconsistent');
  }
  try {
    const resultState = await reconcile({ domainRegistry: {}, certificateRegistry: {}, applicationRegistry: {}, job: terminal });
    if (!resultState || resultState.reconciled !== true) throw new Error('not reconciled');
  } catch { fail('job_node_runtime_recovery_reconciliation_failed', 'Node runtime job is terminal but reconciliation remains pending'); }
  let acknowledgement;
  try { acknowledgement = await jobRegistry.acknowledgeReconciliation(identity); }
  catch { fail('job_node_runtime_recovery_acknowledgement_failed', 'Node runtime recovery could not be durably acknowledged'); }
  if (!acknowledgement || acknowledgement.acknowledged !== true || acknowledgement.jobId !== identity.jobId
    || acknowledgement.serverId !== identity.serverId || acknowledgement.status !== 'succeeded') {
    fail('job_node_runtime_recovery_acknowledgement_invalid', 'Node runtime recovery acknowledgement is inconsistent');
  }
  return Object.freeze({
    serverId: identity.serverId,
    jobId: identity.jobId,
    operation: OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL,
    major,
    status: 'succeeded',
    recoveryMethod: 'verified_managed_node_runtime',
    reconciled: true,
  });
}

export const jobRunningNodeRuntimeRecoveryInternals = Object.freeze({
  normalizeIdentity, requireStoppedConsumers, assertContext, installationEvidence,
});
