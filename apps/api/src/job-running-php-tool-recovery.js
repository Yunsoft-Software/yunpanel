import { OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';

const JOB = /^[A-Za-z0-9._:-]{8,128}$/;

export class JobRunningPhpToolRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningPhpToolRecoveryError';
    this.code = code;
  }
}

async function stopped(serviceStatus) {
  let status;
  try { status = await serviceStatus(); } catch {
    throw new JobRunningPhpToolRecoveryError('job_php_tool_recovery_service_status_unavailable', 'Could not verify YunPanel service state');
  }
  if (!status || status.apiActive !== false || status.agentActive !== false) {
    throw new JobRunningPhpToolRecoveryError('job_php_tool_recovery_consumers_must_be_stopped', 'Stop YunPanel API and legacy agent before recovering PHP tool jobs');
  }
}

export async function recoverRunningPhpTool({
  serverId, jobId, jobRegistry, readOperationReceipt, loadJobContext,
  serviceStatus, inspect = inspectDurableJobRecovery, inspectConfiguration = null, rollbackInterruptedSelectiveTransfer = null,
} = {}) {
  if (typeof serverId !== 'string' || !serverId || typeof jobId !== 'string' || !JOB.test(jobId)
    || !jobRegistry || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.beginReconciliation !== 'function'
    || typeof jobRegistry.complete !== 'function'
    || typeof jobRegistry.acknowledgeReconciliation !== 'function'
    || typeof readOperationReceipt !== 'function' || typeof loadJobContext !== 'function'
    || typeof serviceStatus !== 'function' || typeof inspect !== 'function') {
    throw new JobRunningPhpToolRecoveryError('job_php_tool_recovery_dependencies_invalid', 'PHP tool recovery dependencies are invalid');
  }
  await stopped(serviceStatus);
  const snapshot = await inspect({ registry: jobRegistry });
  const candidate = snapshot?.jobs?.find((entry) => entry.jobId === jobId && entry.serverId === serverId) ?? null;
  if (!candidate || candidate.status !== 'running' || candidate.operation !== OPERATIONS.WEBSITE_PHP_ACTION
    || candidate.resourceType !== 'application') {
    throw new JobRunningPhpToolRecoveryError('job_php_tool_recovery_job_mismatch', 'Running PHP tool recovery metadata is inconsistent');
  }
  const [job, context, receipt] = await Promise.all([
    jobRegistry.getJob(jobId), loadJobContext(jobId), readOperationReceipt(serverId, jobId),
  ]);
  if (!job || job.id !== jobId || job.serverId !== serverId || job.status !== 'running'
    || job.operation !== OPERATIONS.WEBSITE_PHP_ACTION || job.resourceType !== 'application'
    || !context || context.id !== jobId || context.serverId !== serverId || context.status !== 'running'
    || context.operation !== job.operation || context.resourceType !== job.resourceType || context.resourceId !== job.resourceId) {
    throw new JobRunningPhpToolRecoveryError('job_php_tool_recovery_evidence_mismatch', 'PHP tool recovery evidence does not match durable job context');
  }

  const selective = context.payload?.actionId === 'wp.toolkit' && context.payload.options?.action === 'selective_transfer';
  if (selective && context.payload.applicationId !== job.resourceId) {
    throw new JobRunningPhpToolRecoveryError('job_php_tool_recovery_evidence_mismatch', 'WordPress action does not match the queued Application');
  }
  if (!receipt) {
    const recovered = selective && typeof rollbackInterruptedSelectiveTransfer === 'function'
      ? await rollbackInterruptedSelectiveTransfer({ serverId, jobId, payload: context.payload }) : null;
    if (!recovered) {
      throw new JobRunningPhpToolRecoveryError('job_php_tool_recovery_receipt_missing', 'PHP tool receipt is absent; the job remains unresolved');
    }
    if (recovered.status !== 'rolled_back' || !Array.isArray(recovered.conflicts) || recovered.conflicts.length !== 0
      || !Number.isSafeInteger(recovered.filesRolledBack) || recovered.filesRolledBack < 0
      || !Number.isSafeInteger(recovered.unchangedFiles) || recovered.unchangedFiles < 0) {
      const error = new JobRunningPhpToolRecoveryError('job_wordpress_selective_rollback_unresolved', 'Some WordPress files require recovery inspection; the job remains unresolved');
      error.evidence = recovered;
      throw error;
    }
    await completeReconciliation(jobRegistry, { serverId, jobId }, 'failed', { error: { code: 'wordpress_selective_transfer_interrupted' } });
    return Object.freeze({
      serverId, jobId, operation: OPERATIONS.WEBSITE_PHP_ACTION, status: 'failed', reconciled: true,
      recoveryMethod: 'verified_wordpress_selective_rollback', filesRolledBack: recovered.filesRolledBack, unchangedFiles: recovered.unchangedFiles,
    });
  }

  if (receipt.serverId !== serverId || receipt.jobId !== jobId
    || receipt.payload.websiteId !== context.payload?.websiteId
    || receipt.payload.applicationId !== context.payload?.applicationId
    || receipt.payload.unixUser !== context.payload?.unixUser
    || receipt.payload.expectedWebsiteRevision !== context.payload?.expectedWebsiteRevision
    || receipt.payload.actorSessionId !== context.payload?.actorSessionId
    || receipt.payload.actorUserId !== context.payload?.actorUserId
    || receipt.payload.actorRole !== context.payload?.actorRole
    || receipt.payload.actionId !== context.payload?.actionId
    || receipt.payload.previewDigest !== context.payload?.previewDigest
    || receipt.payload.confirmation !== context.payload?.confirmation
    || receipt.result.applicationId !== job.resourceId) {
    throw new JobRunningPhpToolRecoveryError('job_php_tool_recovery_evidence_mismatch', 'PHP tool recovery evidence does not match durable job context');
  }
  if (context.payload.actionId === 'php.fpm.update') {
    if (JSON.stringify(receipt.payload.config) !== JSON.stringify(context.payload.config)
      || typeof inspectConfiguration !== 'function' || !await inspectConfiguration(context.payload)) {
      throw new JobRunningPhpToolRecoveryError('job_php_configuration_recovery_unverified', 'Persistent PHP settings and active FPM pool could not be verified');
    }
  }
  if (context.payload.actionId === 'wp.toolkit' && (JSON.stringify(receipt.payload.options) !== JSON.stringify(context.payload.options)
    || receipt.payload.secretRef !== context.payload.secretRef)) throw new JobRunningPhpToolRecoveryError('job_php_tool_recovery_evidence_mismatch', 'WordPress action receipt does not match the durable job');
  if (selective && (receipt.payload.targetApplicationId !== context.payload.targetApplicationId
    || receipt.payload.targetWebsiteRevision !== context.payload.targetWebsiteRevision)) {
    throw new JobRunningPhpToolRecoveryError('job_php_tool_recovery_evidence_mismatch', 'WordPress action receipt does not match the approved target site');
  }
  await completeReconciliation(jobRegistry, { serverId, jobId }, 'succeeded', { result: receipt.result });
  return Object.freeze({
    serverId, jobId, operation: OPERATIONS.WEBSITE_PHP_ACTION, status: 'succeeded',
    recoveryMethod: 'verified_php_tool_receipt', reconciled: true,
  });
}

async function completeReconciliation(jobRegistry, { serverId, jobId }, status, outcome) {
  const begun = await jobRegistry.beginReconciliation({ serverId, jobId });
  if (!begun || begun.pending !== true || begun.status !== 'running') {
    throw new JobRunningPhpToolRecoveryError('job_php_tool_recovery_journal_invalid', 'PHP tool recovery journal is inconsistent');
  }
  const terminal = await jobRegistry.complete({ serverId, jobId, status, ...outcome });
  if (!terminal || terminal.id !== jobId || terminal.status !== status) {
    throw new JobRunningPhpToolRecoveryError('job_php_tool_recovery_completion_invalid', 'PHP tool recovery completion is inconsistent');
  }
  const ack = await jobRegistry.acknowledgeReconciliation({ serverId, jobId });
  if (!ack || ack.acknowledged !== true || ack.jobId !== jobId || ack.serverId !== serverId) {
    throw new JobRunningPhpToolRecoveryError('job_php_tool_recovery_acknowledgement_invalid', 'PHP tool recovery acknowledgement is inconsistent');
  }
}
