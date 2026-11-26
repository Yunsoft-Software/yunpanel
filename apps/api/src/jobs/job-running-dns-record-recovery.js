import { createOperationEnvelope, OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class JobRunningDnsRecordRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningDnsRecordRecoveryError';
    this.code = code;
  }
}

function identity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobRunningDnsRecordRecoveryError('job_dns_record_recovery_identity_invalid', 'DNS record recovery identity is invalid');
  }
  return { serverId, jobId };
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try { status = await serviceStatus(); }
  catch {
    throw new JobRunningDnsRecordRecoveryError('job_dns_record_recovery_service_status_unavailable', 'Could not verify YunPanel service state');
  }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    throw new JobRunningDnsRecordRecoveryError('job_dns_record_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (status.apiActive || status.agentActive) {
    throw new JobRunningDnsRecordRecoveryError('job_dns_record_recovery_consumers_must_be_stopped', 'Stop YunPanel API and legacy agent before recovering a DNS record operation');
  }
}

function assertJob(value, expected, candidate) {
  if (!value || value.id !== expected.jobId || value.serverId !== expected.serverId || value.status !== 'running'
    || value.operation !== OPERATIONS.DNS_RECORD_APPLY || value.resourceType !== 'dns_zone'
    || typeof value.resourceId !== 'string' || !value.resourceId || value.resourceId !== candidate.resourceId) {
    throw new JobRunningDnsRecordRecoveryError('job_dns_record_recovery_job_mismatch', 'Running DNS record job metadata is inconsistent');
  }
}

function recoveryPayload(context, expected, job) {
  if (!context || context.id !== expected.jobId || context.serverId !== expected.serverId || context.status !== 'running'
    || context.operation !== OPERATIONS.DNS_RECORD_APPLY || context.resourceType !== 'dns_zone'
    || context.resourceId !== job.resourceId || context.payload?.dnsZoneId !== job.resourceId) {
    throw new JobRunningDnsRecordRecoveryError('job_dns_record_recovery_context_mismatch', 'Private DNS record recovery context does not match durable job metadata');
  }
  try {
    return createOperationEnvelope({ id: context.id, operation: context.operation, payload: context.payload }).payload;
  } catch {
    throw new JobRunningDnsRecordRecoveryError('job_dns_record_recovery_context_mismatch', 'Private DNS record recovery payload is invalid');
  }
}

export async function recoverRunningDnsRecord({
  serverId,
  jobId,
  jobRegistry,
  serviceStatus,
  loadJobContext,
  applyDnsRecord,
  inspect = inspectDurableJobRecovery,
  reconcile = reconcileCompletedJob,
} = {}) {
  const expected = identity(serverId, jobId);
  if (!jobRegistry || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.beginReconciliation !== 'function' || typeof jobRegistry.complete !== 'function'
    || typeof jobRegistry.acknowledgeReconciliation !== 'function' || typeof serviceStatus !== 'function'
    || typeof loadJobContext !== 'function' || typeof applyDnsRecord !== 'function'
    || typeof inspect !== 'function' || typeof reconcile !== 'function') {
    throw new JobRunningDnsRecordRecoveryError('job_dns_record_recovery_dependencies_invalid', 'DNS record recovery dependencies are invalid');
  }
  await requireStoppedConsumers(serviceStatus);

  let inspection;
  try { inspection = await inspect({ registry: jobRegistry }); }
  catch {
    throw new JobRunningDnsRecordRecoveryError('job_dns_record_recovery_inspection_failed', 'Durable DNS record recovery state could not be inspected');
  }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw new JobRunningDnsRecordRecoveryError('job_dns_record_recovery_inspection_invalid', 'Durable DNS record recovery state is invalid');
  }
  const candidate = inspection.jobs.find((entry) => entry.jobId === expected.jobId && entry.serverId === expected.serverId) ?? null;
  if (!candidate) {
    throw new JobRunningDnsRecordRecoveryError('job_dns_record_recovery_job_not_found', 'Requested DNS record job is not present in durable recovery state');
  }
  assertJob({
    id: candidate.jobId,
    serverId: candidate.serverId,
    status: candidate.status,
    operation: candidate.operation,
    resourceType: candidate.resourceType,
    resourceId: candidate.resourceId,
  }, expected, candidate);

  let job;
  try { job = await jobRegistry.getJob(expected.jobId); }
  catch {
    throw new JobRunningDnsRecordRecoveryError('job_dns_record_recovery_job_read_failed', 'Running DNS record job could not be read');
  }
  assertJob(job, expected, candidate);

  let context;
  try { context = await loadJobContext(expected.jobId); }
  catch {
    throw new JobRunningDnsRecordRecoveryError('job_dns_record_recovery_context_failed', 'Private DNS record recovery context could not be read');
  }
  const payload = recoveryPayload(context, expected, job);

  let result;
  try { result = await applyDnsRecord(payload); }
  catch {
    throw new JobRunningDnsRecordRecoveryError(
      'job_dns_record_recovery_evidence_failed',
      'DNS provider post-condition could not be safely established; the running job remains unresolved',
    );
  }

  let begun;
  try { begun = await jobRegistry.beginReconciliation(expected); }
  catch {
    throw new JobRunningDnsRecordRecoveryError('job_dns_record_recovery_journal_failed', 'DNS record recovery journal could not be opened');
  }
  if (!begun || begun.jobId !== expected.jobId || begun.serverId !== expected.serverId
    || begun.status !== 'running' || begun.pending !== true) {
    throw new JobRunningDnsRecordRecoveryError('job_dns_record_recovery_journal_invalid', 'DNS record recovery journal acknowledgement is inconsistent');
  }

  let terminal;
  try {
    terminal = await jobRegistry.complete({ serverId: expected.serverId, jobId: expected.jobId, status: 'succeeded', result });
  } catch {
    throw new JobRunningDnsRecordRecoveryError('job_dns_record_recovery_completion_failed', 'DNS provider state was confirmed but durable completion failed');
  }
  if (!terminal || terminal.id !== expected.jobId || terminal.serverId !== expected.serverId
    || terminal.status !== 'succeeded' || terminal.operation !== OPERATIONS.DNS_RECORD_APPLY
    || terminal.resourceType !== 'dns_zone' || terminal.resourceId !== job.resourceId) {
    throw new JobRunningDnsRecordRecoveryError('job_dns_record_recovery_completion_invalid', 'DNS record recovery completion acknowledgement is inconsistent');
  }

  try {
    const reconciled = await reconcile({ domainRegistry: {}, certificateRegistry: {}, applicationRegistry: {}, job: terminal });
    if (!reconciled || reconciled.reconciled !== true) throw new Error('reconciliation not confirmed');
  } catch {
    throw new JobRunningDnsRecordRecoveryError('job_dns_record_recovery_reconciliation_failed', 'DNS record job is terminal but reconciliation remains pending');
  }

  let acknowledgement;
  try { acknowledgement = await jobRegistry.acknowledgeReconciliation(expected); }
  catch {
    throw new JobRunningDnsRecordRecoveryError('job_dns_record_recovery_acknowledgement_failed', 'DNS record recovery could not be durably acknowledged');
  }
  if (!acknowledgement || acknowledgement.acknowledged !== true || acknowledgement.jobId !== expected.jobId
    || acknowledgement.serverId !== expected.serverId || acknowledgement.status !== 'succeeded') {
    throw new JobRunningDnsRecordRecoveryError('job_dns_record_recovery_acknowledgement_invalid', 'DNS record recovery acknowledgement is inconsistent');
  }

  return Object.freeze({
    serverId: expected.serverId,
    jobId: expected.jobId,
    operation: OPERATIONS.DNS_RECORD_APPLY,
    status: 'succeeded',
    recoveryMethod: 'idempotent_provider_postcondition',
    reconciled: true,
  });
}

export const jobRunningDnsRecordRecoveryInternals = Object.freeze({
  identity,
  requireStoppedConsumers,
  assertJob,
  recoveryPayload,
});
