import { OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const FINGERPRINT_PATTERN = /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/i;

export class JobRunningCertificateRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningCertificateRecoveryError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobRunningCertificateRecoveryError('job_certificate_recovery_identity_invalid', 'Certificate recovery identity is invalid');
  }
  return { serverId, jobId };
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try { status = await serviceStatus(); }
  catch { throw new JobRunningCertificateRecoveryError('job_certificate_recovery_service_status_unavailable', 'Could not verify YunPanel service state'); }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    throw new JobRunningCertificateRecoveryError('job_certificate_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (status.apiActive || status.agentActive) {
    throw new JobRunningCertificateRecoveryError('job_certificate_recovery_consumers_must_be_stopped', 'Stop YunPanel API and legacy agent before recovering a certificate operation');
  }
}

function sameStrings(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((value, index) => typeof value === 'string' && value === right[index]);
}

function assertContext(context, job, candidate, identity) {
  if (!context || context.id !== identity.jobId || context.serverId !== identity.serverId || context.status !== 'running'
    || context.operation !== job.operation || context.operation !== candidate.operation
    || context.resourceType !== 'certificate' || context.resourceId !== job.resourceId || context.resourceId !== candidate.resourceId) {
    throw new JobRunningCertificateRecoveryError('job_certificate_recovery_context_mismatch', 'Private certificate recovery context does not match durable job metadata');
  }

  if (context.operation === OPERATIONS.SSL_ISSUE) {
    if (!Array.isArray(context.payload?.domains) || context.payload.domains.length < 1
      || typeof context.payload.email !== 'string' || !context.payload.email
      || typeof context.payload.staging !== 'boolean') {
      throw new JobRunningCertificateRecoveryError('job_certificate_recovery_context_mismatch', 'Certificate issue recovery intent is invalid');
    }
    return {
      operation: context.operation,
      certificateId: context.resourceId,
      certName: context.payload.domains[0],
      domains: [...context.payload.domains],
      email: context.payload.email,
      staging: context.payload.staging,
      dryRun: null,
      expectedState: context.payload.staging ? 'validating' : 'issuing',
      requiresLiveCertificate: !context.payload.staging,
    };
  }

  if (context.operation === OPERATIONS.SSL_RENEW) {
    if (typeof context.payload?.certName !== 'string' || !context.payload.certName
      || typeof context.payload.dryRun !== 'boolean') {
      throw new JobRunningCertificateRecoveryError('job_certificate_recovery_context_mismatch', 'Certificate renewal recovery intent is invalid');
    }
    return {
      operation: context.operation,
      certificateId: context.resourceId,
      certName: context.payload.certName,
      domains: null,
      email: null,
      staging: null,
      dryRun: context.payload.dryRun,
      expectedState: context.payload.dryRun ? 'active' : 'renewing',
      requiresLiveCertificate: !context.payload.dryRun,
    };
  }

  throw new JobRunningCertificateRecoveryError('job_certificate_recovery_operation_unsupported', 'Certificate recovery operation is not supported');
}

async function requireCertificateIntent(certificateRegistry, serverId, intent) {
  let certificate;
  try { certificate = await certificateRegistry.getCertificate(intent.certificateId); }
  catch { throw new JobRunningCertificateRecoveryError('job_certificate_recovery_certificate_read_failed', 'Certificate state could not be read'); }
  if (!certificate || certificate.id !== intent.certificateId || certificate.serverId !== serverId
    || certificate.certName !== intent.certName || certificate.state !== intent.expectedState) {
    throw new JobRunningCertificateRecoveryError('job_certificate_recovery_certificate_mismatch', 'Certificate state no longer matches the running operation');
  }

  if (intent.operation === OPERATIONS.SSL_ISSUE) {
    if (!sameStrings(certificate.domains, intent.domains) || certificate.email !== intent.email.toLowerCase()
      || certificate.staging !== intent.staging) {
      throw new JobRunningCertificateRecoveryError('job_certificate_recovery_certificate_mismatch', 'Certificate issue desired state no longer matches the running operation');
    }
  } else if (certificate.staging !== false) {
    throw new JobRunningCertificateRecoveryError('job_certificate_recovery_certificate_mismatch', 'Staging certificate records cannot be renewed');
  }
  return certificate;
}

function assertReceipt(receipt, identity, intent) {
  if (!receipt || receipt.serverId !== identity.serverId || receipt.jobId !== identity.jobId
    || receipt.certificateId !== intent.certificateId || receipt.operation !== intent.operation
    || receipt.certName !== intent.certName) {
    throw new JobRunningCertificateRecoveryError('job_certificate_recovery_receipt_mismatch', 'Certificate recovery receipt does not match the running job');
  }

  if (intent.operation === OPERATIONS.SSL_ISSUE) {
    if (!sameStrings(receipt.domains, intent.domains) || receipt.staging !== intent.staging || receipt.dryRun !== null
      || receipt.status !== (intent.staging ? 'validated' : 'issued')) {
      throw new JobRunningCertificateRecoveryError('job_certificate_recovery_receipt_mismatch', 'Certificate issue receipt is inconsistent');
    }
  } else if (receipt.domains !== null || receipt.staging !== null || receipt.dryRun !== intent.dryRun
    || receipt.status !== (intent.dryRun ? 'validated' : 'renewed')) {
    throw new JobRunningCertificateRecoveryError('job_certificate_recovery_receipt_mismatch', 'Certificate renewal receipt is inconsistent');
  }

  if (intent.requiresLiveCertificate) {
    if (typeof receipt.fingerprint256 !== 'string' || !FINGERPRINT_PATTERN.test(receipt.fingerprint256)
      || typeof receipt.validFrom !== 'string' || !Number.isFinite(Date.parse(receipt.validFrom))
      || typeof receipt.validTo !== 'string' || !Number.isFinite(Date.parse(receipt.validTo))) {
      throw new JobRunningCertificateRecoveryError('job_certificate_recovery_receipt_mismatch', 'Production certificate receipt evidence is incomplete');
    }
  } else if (receipt.fingerprint256 !== null || receipt.validFrom !== null || receipt.validTo !== null) {
    throw new JobRunningCertificateRecoveryError('job_certificate_recovery_receipt_mismatch', 'Validation-only certificate receipt contains unexpected production evidence');
  }
}

function verifyLiveCertificate(live, receipt, intent) {
  const base = `/etc/letsencrypt/live/${intent.certName}`;
  if (!live || live.certName !== intent.certName
    || live.certificatePath !== `${base}/cert.pem`
    || live.fullchainPath !== `${base}/fullchain.pem`
    || live.privateKeyPath !== `${base}/privkey.pem`
    || typeof live.fingerprint256 !== 'string'
    || live.fingerprint256.toUpperCase() !== receipt.fingerprint256.toUpperCase()
    || typeof live.validFrom !== 'string' || Date.parse(live.validFrom) !== Date.parse(receipt.validFrom)
    || typeof live.validTo !== 'string' || Date.parse(live.validTo) !== Date.parse(receipt.validTo)
    || Date.parse(live.validTo) <= Date.parse(live.validFrom)) {
    throw new JobRunningCertificateRecoveryError('job_certificate_recovery_evidence_not_satisfied', 'Live certificate no longer matches the recorded successful operation');
  }
  return live;
}

function completionResult(intent, receipt, live) {
  if (intent.operation === OPERATIONS.SSL_ISSUE && intent.staging) {
    return { certName: intent.certName, domains: [...intent.domains], staging: true, status: 'validated' };
  }
  if (intent.operation === OPERATIONS.SSL_RENEW && intent.dryRun) {
    return { certName: intent.certName, dryRun: true, status: 'validated' };
  }
  if (intent.operation === OPERATIONS.SSL_ISSUE) {
    return { ...live, domains: [...intent.domains], staging: false, status: 'issued' };
  }
  return { ...live, dryRun: false, status: 'renewed' };
}

export async function recoverRunningCertificateOperation({
  serverId,
  jobId,
  jobRegistry,
  domainRegistry,
  certificateRegistry,
  serviceStatus,
  loadJobContext,
  readCertificateReceipt,
  inspectCertificate,
  inspect = inspectDurableJobRecovery,
  reconcile = reconcileCompletedJob,
} = {}) {
  const identity = normalizeIdentity(serverId, jobId);
  if (!jobRegistry || typeof jobRegistry.getJob !== 'function' || typeof jobRegistry.beginReconciliation !== 'function'
    || typeof jobRegistry.complete !== 'function' || typeof jobRegistry.acknowledgeReconciliation !== 'function'
    || !domainRegistry || !certificateRegistry || typeof certificateRegistry.getCertificate !== 'function'
    || typeof serviceStatus !== 'function' || typeof loadJobContext !== 'function'
    || typeof readCertificateReceipt !== 'function' || typeof inspectCertificate !== 'function'
    || typeof inspect !== 'function' || typeof reconcile !== 'function') {
    throw new JobRunningCertificateRecoveryError('job_certificate_recovery_dependencies_invalid', 'Certificate recovery dependencies are invalid');
  }

  await requireStoppedConsumers(serviceStatus);
  let inspection;
  try { inspection = await inspect({ registry: jobRegistry }); }
  catch { throw new JobRunningCertificateRecoveryError('job_certificate_recovery_inspection_failed', 'Durable certificate recovery state could not be inspected'); }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw new JobRunningCertificateRecoveryError('job_certificate_recovery_inspection_invalid', 'Durable certificate recovery state is invalid');
  }
  const candidate = inspection.jobs.find((entry) => entry.jobId === identity.jobId && entry.serverId === identity.serverId) ?? null;
  if (!candidate || candidate.status !== 'running' || ![OPERATIONS.SSL_ISSUE, OPERATIONS.SSL_RENEW].includes(candidate.operation)
    || candidate.resourceType !== 'certificate' || typeof candidate.resourceId !== 'string' || !candidate.resourceId) {
    throw new JobRunningCertificateRecoveryError('job_certificate_recovery_job_mismatch', 'Running certificate recovery metadata is inconsistent');
  }

  let job;
  try { job = await jobRegistry.getJob(identity.jobId); }
  catch { throw new JobRunningCertificateRecoveryError('job_certificate_recovery_job_read_failed', 'Running certificate job could not be read'); }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || job.operation !== candidate.operation || job.resourceType !== 'certificate' || job.resourceId !== candidate.resourceId) {
    throw new JobRunningCertificateRecoveryError('job_certificate_recovery_job_mismatch', 'Running certificate job no longer matches durable recovery state');
  }

  let context;
  try { context = await loadJobContext(identity.jobId); }
  catch { throw new JobRunningCertificateRecoveryError('job_certificate_recovery_context_failed', 'Private certificate recovery context could not be read'); }
  const intent = assertContext(context, job, candidate, identity);
  await requireCertificateIntent(certificateRegistry, identity.serverId, intent);

  let receipt;
  try { receipt = await readCertificateReceipt(identity.serverId, identity.jobId); }
  catch { throw new JobRunningCertificateRecoveryError('job_certificate_recovery_receipt_failed', 'Certificate recovery receipt could not be read'); }
  if (!receipt) {
    throw new JobRunningCertificateRecoveryError('job_certificate_recovery_receipt_missing', 'Certificate receipt is absent; the running job remains unresolved');
  }
  assertReceipt(receipt, identity, intent);

  let live = null;
  if (intent.requiresLiveCertificate) {
    try { live = await inspectCertificate(intent.certName); }
    catch { throw new JobRunningCertificateRecoveryError('job_certificate_recovery_evidence_failed', 'Live certificate state could not be inspected'); }
    verifyLiveCertificate(live, receipt, intent);
  }
  const result = completionResult(intent, receipt, live);

  let begun;
  try { begun = await jobRegistry.beginReconciliation(identity); }
  catch { throw new JobRunningCertificateRecoveryError('job_certificate_recovery_journal_failed', 'Certificate recovery reconciliation journal could not be opened'); }
  if (!begun || begun.jobId !== identity.jobId || begun.serverId !== identity.serverId || begun.status !== 'running' || begun.pending !== true) {
    throw new JobRunningCertificateRecoveryError('job_certificate_recovery_journal_invalid', 'Certificate recovery journal acknowledgement is inconsistent');
  }

  let terminal;
  try { terminal = await jobRegistry.complete({ serverId: identity.serverId, jobId: identity.jobId, status: 'succeeded', result }); }
  catch { throw new JobRunningCertificateRecoveryError('job_certificate_recovery_completion_failed', 'Certificate evidence was verified but durable completion could not be confirmed'); }
  if (!terminal || terminal.id !== identity.jobId || terminal.serverId !== identity.serverId || terminal.status !== 'succeeded'
    || terminal.operation !== intent.operation || terminal.resourceType !== 'certificate' || terminal.resourceId !== intent.certificateId) {
    throw new JobRunningCertificateRecoveryError('job_certificate_recovery_completion_invalid', 'Certificate recovery completion acknowledgement is inconsistent');
  }

  try {
    const reconciliation = await reconcile({ domainRegistry, certificateRegistry, applicationRegistry: {}, job: terminal });
    if (!reconciliation || reconciliation.reconciled !== true) throw new Error('reconciliation not confirmed');
  } catch {
    throw new JobRunningCertificateRecoveryError('job_certificate_recovery_reconciliation_failed', 'Certificate job is terminal but reconciliation remains pending');
  }

  let acknowledgement;
  try { acknowledgement = await jobRegistry.acknowledgeReconciliation(identity); }
  catch { throw new JobRunningCertificateRecoveryError('job_certificate_recovery_acknowledgement_failed', 'Certificate recovery could not be durably acknowledged'); }
  if (!acknowledgement || acknowledgement.acknowledged !== true || acknowledgement.jobId !== identity.jobId
    || acknowledgement.serverId !== identity.serverId || acknowledgement.status !== 'succeeded') {
    throw new JobRunningCertificateRecoveryError('job_certificate_recovery_acknowledgement_invalid', 'Certificate recovery acknowledgement is inconsistent');
  }

  return Object.freeze({
    serverId: identity.serverId,
    jobId: identity.jobId,
    operation: intent.operation,
    certificateId: intent.certificateId,
    certName: intent.certName,
    status: 'succeeded',
    recoveryMethod: intent.requiresLiveCertificate
      ? 'verified_certificate_receipt_and_live_x509'
      : 'verified_certificate_operation_receipt',
    reconciled: true,
  });
}

export const jobRunningCertificateRecoveryInternals = Object.freeze({
  normalizeIdentity,
  requireStoppedConsumers,
  sameStrings,
  assertContext,
  requireCertificateIntent,
  assertReceipt,
  verifyLiveCertificate,
  completionResult,
});
