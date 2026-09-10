import { OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class JobRunningSystemUpgradeRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningSystemUpgradeRecoveryError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_identity_invalid', 'System upgrade recovery job identity is invalid');
  }
  return { serverId, jobId };
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try { status = await serviceStatus(); }
  catch { throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_service_status_unavailable', 'Could not verify YunPanel service state'); }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (status.apiActive || status.agentActive) {
    throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_consumers_must_be_stopped', 'Stop YunPanel API and legacy agent before recovering a system upgrade');
  }
}

function assertContext(context, job, candidate, identity) {
  if (!context || context.id !== identity.jobId || context.serverId !== identity.serverId || context.status !== 'running'
    || context.operation !== OPERATIONS.SYSTEM_UPGRADE || context.resourceType !== 'system'
    || context.resourceId !== identity.serverId || context.resourceId !== candidate.resourceId || context.resourceId !== job.resourceId
    || !context.payload || typeof context.payload !== 'object' || Array.isArray(context.payload)
    || Object.keys(context.payload).length !== 0) {
    throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_context_mismatch', 'Private system upgrade context does not match durable job metadata');
  }
}

function assertReceipt(receipt, identity) {
  if (!receipt || receipt.serverId !== identity.serverId || receipt.jobId !== identity.jobId || receipt.packageName !== 'yunpanel'
    || typeof receipt.installedVersion !== 'string' || !receipt.installedVersion
    || !(receipt.candidateVersion === null || typeof receipt.candidateVersion === 'string')
    || typeof receipt.updateAvailable !== 'boolean' || typeof receipt.previousVersion !== 'string' || !receipt.previousVersion
    || typeof receipt.upgraded !== 'boolean' || typeof receipt.restartScheduled !== 'boolean') {
    throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_receipt_mismatch', 'System upgrade receipt does not match the running job');
  }
  if (receipt.upgraded) {
    if (receipt.installedVersion === receipt.previousVersion || receipt.restartScheduled !== true) {
      throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_receipt_mismatch', 'System upgrade receipt transition is inconsistent');
    }
  } else if (receipt.installedVersion !== receipt.previousVersion || receipt.restartScheduled !== false) {
    throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_receipt_mismatch', 'No-op system upgrade receipt transition is inconsistent');
  }
}

function assertCurrentState(state, receipt) {
  if (!state || state.packageName !== 'yunpanel' || state.installed !== true
    || state.installedVersion !== receipt.installedVersion
    || (state.candidateVersion ?? null) !== receipt.candidateVersion
    || state.updateAvailable !== receipt.updateAvailable) {
    throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_evidence_not_satisfied', 'Current YunPanel package state no longer matches the recorded upgrade result');
  }
}

export async function recoverRunningSystemUpgrade({
  serverId,
  jobId,
  jobRegistry,
  serviceStatus,
  loadJobContext,
  readUpgradeReceipt,
  inspectPackageState,
  inspect = inspectDurableJobRecovery,
  reconcile = reconcileCompletedJob,
} = {}) {
  const identity = normalizeIdentity(serverId, jobId);
  if (!jobRegistry || typeof jobRegistry.getJob !== 'function' || typeof jobRegistry.beginReconciliation !== 'function'
    || typeof jobRegistry.complete !== 'function' || typeof jobRegistry.acknowledgeReconciliation !== 'function'
    || typeof serviceStatus !== 'function' || typeof loadJobContext !== 'function'
    || typeof readUpgradeReceipt !== 'function' || typeof inspectPackageState !== 'function'
    || typeof inspect !== 'function' || typeof reconcile !== 'function') {
    throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_dependencies_invalid', 'System upgrade recovery dependencies are invalid');
  }

  await requireStoppedConsumers(serviceStatus);
  let inspection;
  try { inspection = await inspect({ registry: jobRegistry }); }
  catch { throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_inspection_failed', 'Durable system upgrade recovery state could not be inspected'); }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_inspection_invalid', 'Durable system upgrade recovery state is invalid');
  }
  const candidate = inspection.jobs.find((entry) => entry.jobId === identity.jobId && entry.serverId === identity.serverId) ?? null;
  if (!candidate || candidate.status !== 'running' || candidate.operation !== OPERATIONS.SYSTEM_UPGRADE
    || candidate.resourceType !== 'system' || candidate.resourceId !== identity.serverId) {
    throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_job_mismatch', 'Running system upgrade recovery metadata is inconsistent');
  }

  let job;
  try { job = await jobRegistry.getJob(identity.jobId); }
  catch { throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_job_read_failed', 'Running system upgrade job could not be read'); }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || job.operation !== OPERATIONS.SYSTEM_UPGRADE || job.resourceType !== 'system' || job.resourceId !== identity.serverId) {
    throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_job_mismatch', 'Running system upgrade no longer matches durable recovery state');
  }

  let context;
  try { context = await loadJobContext(identity.jobId); }
  catch { throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_context_failed', 'Private system upgrade context could not be read'); }
  assertContext(context, job, candidate, identity);

  let receipt;
  try { receipt = await readUpgradeReceipt(identity.serverId, identity.jobId); }
  catch { throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_receipt_failed', 'System upgrade receipt could not be read'); }
  if (!receipt) {
    throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_receipt_missing', 'System upgrade receipt is absent; the running job remains unresolved');
  }
  assertReceipt(receipt, identity);

  let state;
  try { state = await inspectPackageState(); }
  catch { throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_evidence_failed', 'Current YunPanel package state could not be inspected'); }
  assertCurrentState(state, receipt);

  const result = {
    packageName: 'yunpanel',
    installed: true,
    installedVersion: receipt.installedVersion,
    candidateVersion: receipt.candidateVersion,
    updateAvailable: receipt.updateAvailable,
    previousVersion: receipt.previousVersion,
    upgraded: receipt.upgraded,
    restartScheduled: receipt.restartScheduled,
  };

  let begun;
  try { begun = await jobRegistry.beginReconciliation(identity); }
  catch { throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_journal_failed', 'System upgrade recovery journal could not be opened'); }
  if (!begun || begun.jobId !== identity.jobId || begun.serverId !== identity.serverId || begun.status !== 'running' || begun.pending !== true) {
    throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_journal_invalid', 'System upgrade recovery journal acknowledgement is inconsistent');
  }

  let terminal;
  try { terminal = await jobRegistry.complete({ serverId: identity.serverId, jobId: identity.jobId, status: 'succeeded', result }); }
  catch { throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_completion_failed', 'System upgrade evidence was verified but durable completion could not be confirmed'); }
  if (!terminal || terminal.id !== identity.jobId || terminal.serverId !== identity.serverId || terminal.status !== 'succeeded'
    || terminal.operation !== OPERATIONS.SYSTEM_UPGRADE || terminal.resourceType !== 'system' || terminal.resourceId !== identity.serverId) {
    throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_completion_invalid', 'System upgrade recovery completion acknowledgement is inconsistent');
  }

  try {
    const reconciliation = await reconcile({ domainRegistry: {}, certificateRegistry: {}, applicationRegistry: {}, job: terminal });
    if (!reconciliation || reconciliation.reconciled !== true) throw new Error('reconciliation not confirmed');
  } catch {
    throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_reconciliation_failed', 'System upgrade job is terminal but reconciliation remains pending');
  }

  let acknowledgement;
  try { acknowledgement = await jobRegistry.acknowledgeReconciliation(identity); }
  catch { throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_acknowledgement_failed', 'System upgrade recovery could not be durably acknowledged'); }
  if (!acknowledgement || acknowledgement.acknowledged !== true || acknowledgement.jobId !== identity.jobId
    || acknowledgement.serverId !== identity.serverId || acknowledgement.status !== 'succeeded') {
    throw new JobRunningSystemUpgradeRecoveryError('job_system_upgrade_recovery_acknowledgement_invalid', 'System upgrade recovery acknowledgement is inconsistent');
  }

  return Object.freeze({
    serverId: identity.serverId,
    jobId: identity.jobId,
    operation: OPERATIONS.SYSTEM_UPGRADE,
    status: 'succeeded',
    upgraded: receipt.upgraded,
    recoveryMethod: 'verified_system_upgrade_receipt_and_package_state',
    reconciled: true,
  });
}

export const jobRunningSystemUpgradeRecoveryInternals = Object.freeze({
  normalizeIdentity,
  requireStoppedConsumers,
  assertContext,
  assertReceipt,
  assertCurrentState,
});
