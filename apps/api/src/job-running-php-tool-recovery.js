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
  serviceStatus, inspect = inspectDurableJobRecovery,
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
  if (!candidate || candidate.status !== 'running' || candidate.operation !== 'website.php.action'
    || candidate.resourceType !== 'application') {
    throw new JobRunningPhpToolRecoveryError('job_php_tool_recovery_job_mismatch', 'Running PHP tool recovery metadata is inconsistent');
  }
  const [job, context, receipt] = await Promise.all([
    jobRegistry.getJob(jobId), loadJobContext(jobId), readOperationReceipt(serverId, jobId),
  ]);
  if (!job || job.id !== jobId || job.serverId !== serverId || job.status !== 'running'
    || job.operation !== 'website.php.action' || job.resourceType !== 'application'
    || !context || context.id !== jobId || context.serverId !== serverId || context.status !== 'running'
    || context.operation !== job.operation || context.resourceType !== job.resourceType || context.resourceId !== job.resourceId
    || !receipt || receipt.serverId !== serverId || receipt.jobId !== jobId
    || receipt.payload.websiteId !== context.payload?.websiteId
    || receipt.payload.applicationId !== context.payload?.applicationId
    || receipt.payload.unixUser !== context.payload?.unixUser
    || receipt.payload.expectedWebsiteRevision !== context.payload?.expectedWebsiteRevision
    || receipt.payload.actionId !== context.payload?.actionId
    || receipt.payload.previewDigest !== context.payload?.previewDigest
    || receipt.payload.confirmation !== context.payload?.confirmation
    || receipt.result.applicationId !== job.resourceId) {
    throw new JobRunningPhpToolRecoveryError(
      receipt ? 'job_php_tool_recovery_evidence_mismatch' : 'job_php_tool_recovery_receipt_missing',
      receipt ? 'PHP tool recovery evidence does not match durable job context' : 'PHP tool receipt is absent; the job remains unresolved',
    );
  }
  const begun = await jobRegistry.beginReconciliation({ serverId, jobId });
  if (!begun || begun.pending !== true || begun.status !== 'running') {
    throw new JobRunningPhpToolRecoveryError('job_php_tool_recovery_journal_invalid', 'PHP tool recovery journal is inconsistent');
  }
  const terminal = await jobRegistry.complete({ serverId, jobId, status: 'succeeded', result: receipt.result });
  if (!terminal || terminal.id !== jobId || terminal.status !== 'succeeded') {
    throw new JobRunningPhpToolRecoveryError('job_php_tool_recovery_completion_invalid', 'PHP tool recovery completion is inconsistent');
  }
  const ack = await jobRegistry.acknowledgeReconciliation({ serverId, jobId });
  if (!ack || ack.acknowledged !== true || ack.jobId !== jobId || ack.serverId !== serverId) {
    throw new JobRunningPhpToolRecoveryError('job_php_tool_recovery_acknowledgement_invalid', 'PHP tool recovery acknowledgement is inconsistent');
  }
  return Object.freeze({
    serverId, jobId, operation: 'website.php.action', status: 'succeeded',
    recoveryMethod: 'verified_php_tool_receipt', reconciled: true,
  });
}
