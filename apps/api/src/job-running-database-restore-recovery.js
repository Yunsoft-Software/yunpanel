import { OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const BACKUP_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class JobRunningDatabaseRestoreRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningDatabaseRestoreRecoveryError';
    this.code = code;
  }
}

function identity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobRunningDatabaseRestoreRecoveryError(
      'job_database_restore_recovery_identity_invalid',
      'Database restore recovery identity is invalid',
    );
  }
  return Object.freeze({ serverId, jobId });
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try { status = await serviceStatus(); }
  catch {
    throw new JobRunningDatabaseRestoreRecoveryError(
      'job_database_restore_recovery_service_status_unavailable',
      'Could not verify YunPanel service state',
    );
  }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    throw new JobRunningDatabaseRestoreRecoveryError(
      'job_database_restore_recovery_service_status_invalid',
      'YunPanel service state is invalid',
    );
  }
  if (status.apiActive || status.agentActive) {
    throw new JobRunningDatabaseRestoreRecoveryError(
      'job_database_restore_recovery_consumers_must_be_stopped',
      'Stop YunPanel API and legacy agent before recovering a database restore',
    );
  }
}

function assertCandidate(candidate, expected) {
  if (!candidate || candidate.jobId !== expected.jobId || candidate.serverId !== expected.serverId
    || candidate.status !== 'running' || candidate.operation !== OPERATIONS.DATABASE_RESTORE
    || candidate.resourceType !== 'database' || typeof candidate.resourceId !== 'string'
    || !DATABASE_NAME_PATTERN.test(candidate.resourceId)) {
    throw new JobRunningDatabaseRestoreRecoveryError(
      'job_database_restore_recovery_job_mismatch',
      'Running database restore recovery metadata is inconsistent',
    );
  }
  return candidate;
}

function recoveryIntent(context, job, candidate, expected) {
  const payload = context?.payload;
  if (!job || job.id !== expected.jobId || job.serverId !== expected.serverId
    || job.status !== 'running' || job.operation !== OPERATIONS.DATABASE_RESTORE
    || job.resourceType !== 'database' || job.resourceId !== candidate.resourceId
    || !context || context.id !== expected.jobId || context.serverId !== expected.serverId
    || context.status !== 'running' || context.operation !== OPERATIONS.DATABASE_RESTORE
    || context.resourceType !== 'database' || context.resourceId !== candidate.resourceId
    || !payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).length !== 3 || payload.databaseName !== candidate.resourceId
    || typeof payload.backupId !== 'string' || !BACKUP_ID_PATTERN.test(payload.backupId)
    || typeof payload.expectedBackupSha256 !== 'string' || !SHA256_PATTERN.test(payload.expectedBackupSha256)) {
    throw new JobRunningDatabaseRestoreRecoveryError(
      'job_database_restore_recovery_context_mismatch',
      'Private database restore recovery context does not match durable job metadata',
    );
  }
  return Object.freeze({
    databaseName: payload.databaseName,
    backupId: payload.backupId,
    expectedBackupSha256: payload.expectedBackupSha256,
  });
}

function assertReceipt(receipt, expected, intent) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || receipt.version !== 1 || receipt.transactionId !== expected.jobId
    || receipt.backupId !== intent.backupId
    || receipt.preRestoreBackupId !== `pre-restore:${expected.jobId}`
    || receipt.databaseName !== intent.databaseName
    || !['mariadb', 'mysql'].includes(receipt.engine)
    || receipt.dumpSha256 !== intent.expectedBackupSha256
    || typeof receipt.preRestoreDumpSha256 !== 'string' || !SHA256_PATTERN.test(receipt.preRestoreDumpSha256)
    || receipt.restored !== true || receipt.verified !== true || receipt.sideEffects !== true
    || typeof receipt.committedAt !== 'string' || !Number.isFinite(Date.parse(receipt.committedAt))) {
    throw new JobRunningDatabaseRestoreRecoveryError(
      'job_database_restore_recovery_receipt_mismatch',
      'Database restore receipt does not match the running job',
    );
  }
  return receipt;
}

function assertBackupManifest(manifest, {
  backupId,
  databaseName,
  engine,
  dumpSha256,
  role,
}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.version !== 1 || manifest.backupId !== backupId
    || manifest.databaseName !== databaseName || manifest.engine !== engine
    || typeof manifest.databaseVersion !== 'string' || !manifest.databaseVersion
    || manifest.dumpSha256 !== dumpSha256
    || !Number.isSafeInteger(manifest.dumpBytes) || manifest.dumpBytes < 1
    || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))
    || manifest.backedUp !== true || manifest.sideEffects !== true
    || Object.hasOwn(manifest, 'dumpPath')) {
    throw new JobRunningDatabaseRestoreRecoveryError(
      `job_database_restore_recovery_${role}_backup_mismatch`,
      `Database restore ${role} backup evidence does not match the running job`,
    );
  }
  return manifest;
}

async function verifyEvidence(intent, receipt, expected, { inspectBackup, inspectLive }) {
  let selected;
  let preRestore;
  let live;
  try {
    [selected, preRestore, live] = await Promise.all([
      inspectBackup(intent.backupId),
      inspectBackup(`pre-restore:${expected.jobId}`),
      inspectLive({ databaseName: intent.databaseName, engine: receipt.engine }),
    ]);
  } catch {
    throw new JobRunningDatabaseRestoreRecoveryError(
      'job_database_restore_recovery_evidence_failed',
      'Database restore evidence could not be verified',
    );
  }

  const selectedManifest = assertBackupManifest(selected, {
    backupId: intent.backupId,
    databaseName: intent.databaseName,
    engine: receipt.engine,
    dumpSha256: intent.expectedBackupSha256,
    role: 'selected',
  });
  assertBackupManifest(preRestore, {
    backupId: `pre-restore:${expected.jobId}`,
    databaseName: intent.databaseName,
    engine: receipt.engine,
    dumpSha256: receipt.preRestoreDumpSha256,
    role: 'pre_restore',
  });
  if (!live || typeof live !== 'object' || Array.isArray(live)
    || live.databaseName !== intent.databaseName || live.engine !== receipt.engine
    || typeof live.databaseVersion !== 'string' || !live.databaseVersion
    || live.dumpSha256 !== intent.expectedBackupSha256
    || live.dumpBytes !== selectedManifest.dumpBytes
    || Object.hasOwn(live, 'dumpPath')) {
    throw new JobRunningDatabaseRestoreRecoveryError(
      'job_database_restore_recovery_live_state_mismatch',
      'Live database state does not match the verified restore backup',
    );
  }

  return Object.freeze({
    version: 1,
    transactionId: expected.jobId,
    backupId: intent.backupId,
    preRestoreBackupId: `pre-restore:${expected.jobId}`,
    databaseName: intent.databaseName,
    engine: receipt.engine,
    dumpSha256: intent.expectedBackupSha256,
    preRestoreDumpSha256: receipt.preRestoreDumpSha256,
    restored: true,
    verified: true,
    sideEffects: true,
  });
}

export async function recoverRunningDatabaseRestore({
  serverId,
  jobId,
  jobRegistry,
  serviceStatus,
  loadJobContext,
  readRestoreReceipt,
  inspectBackup,
  inspectLive,
  inspect = inspectDurableJobRecovery,
  reconcile = reconcileCompletedJob,
} = {}) {
  const expected = identity(serverId, jobId);
  if (!jobRegistry || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.beginReconciliation !== 'function'
    || typeof jobRegistry.complete !== 'function'
    || typeof jobRegistry.acknowledgeReconciliation !== 'function'
    || typeof serviceStatus !== 'function' || typeof loadJobContext !== 'function'
    || typeof readRestoreReceipt !== 'function' || typeof inspectBackup !== 'function'
    || typeof inspectLive !== 'function' || typeof inspect !== 'function' || typeof reconcile !== 'function') {
    throw new JobRunningDatabaseRestoreRecoveryError(
      'job_database_restore_recovery_dependencies_invalid',
      'Database restore recovery dependencies are invalid',
    );
  }

  await requireStoppedConsumers(serviceStatus);
  let recovery;
  try { recovery = await inspect({ registry: jobRegistry }); }
  catch {
    throw new JobRunningDatabaseRestoreRecoveryError(
      'job_database_restore_recovery_inspection_failed',
      'Durable database restore recovery state could not be inspected',
    );
  }
  const candidate = assertCandidate(
    recovery?.jobs?.find((item) => item.jobId === expected.jobId && item.serverId === expected.serverId) ?? null,
    expected,
  );

  let job;
  try { job = await jobRegistry.getJob(expected.jobId); }
  catch {
    throw new JobRunningDatabaseRestoreRecoveryError(
      'job_database_restore_recovery_job_read_failed',
      'Running database restore job could not be read',
    );
  }
  let context;
  try { context = await loadJobContext(expected.jobId); }
  catch {
    throw new JobRunningDatabaseRestoreRecoveryError(
      'job_database_restore_recovery_context_failed',
      'Private database restore recovery context could not be read',
    );
  }
  const intent = recoveryIntent(context, job, candidate, expected);

  let receipt;
  try { receipt = await readRestoreReceipt(expected.jobId); }
  catch {
    throw new JobRunningDatabaseRestoreRecoveryError(
      'job_database_restore_recovery_receipt_failed',
      'Private database restore receipt could not be read',
    );
  }
  if (!receipt) {
    throw new JobRunningDatabaseRestoreRecoveryError(
      'job_database_restore_recovery_receipt_missing',
      'Database restore receipt is absent; the running job remains unresolved',
    );
  }
  assertReceipt(receipt, expected, intent);
  const result = await verifyEvidence(intent, receipt, expected, { inspectBackup, inspectLive });

  let begun;
  try { begun = await jobRegistry.beginReconciliation(expected); }
  catch {
    throw new JobRunningDatabaseRestoreRecoveryError(
      'job_database_restore_recovery_journal_failed',
      'Database restore recovery journal could not be opened',
    );
  }
  if (!begun || begun.jobId !== expected.jobId || begun.serverId !== expected.serverId
    || begun.status !== 'running' || begun.pending !== true) {
    throw new JobRunningDatabaseRestoreRecoveryError(
      'job_database_restore_recovery_journal_invalid',
      'Database restore recovery journal acknowledgement is inconsistent',
    );
  }

  let terminal;
  try {
    terminal = await jobRegistry.complete({
      serverId: expected.serverId,
      jobId: expected.jobId,
      status: 'succeeded',
      result,
    });
  } catch {
    throw new JobRunningDatabaseRestoreRecoveryError(
      'job_database_restore_recovery_completion_failed',
      'Verified database restore could not be committed to durable job state',
    );
  }
  if (!terminal || terminal.id !== expected.jobId || terminal.serverId !== expected.serverId
    || terminal.status !== 'succeeded' || terminal.operation !== OPERATIONS.DATABASE_RESTORE
    || terminal.resourceType !== 'database' || terminal.resourceId !== intent.databaseName) {
    throw new JobRunningDatabaseRestoreRecoveryError(
      'job_database_restore_recovery_completion_invalid',
      'Database restore recovery completion acknowledgement is inconsistent',
    );
  }

  try {
    const reconciliation = await reconcile({
      domainRegistry: {},
      certificateRegistry: {},
      applicationRegistry: {},
      job: terminal,
    });
    if (!reconciliation || reconciliation.reconciled !== true) throw new Error('reconciliation not confirmed');
  } catch {
    throw new JobRunningDatabaseRestoreRecoveryError(
      'job_database_restore_recovery_reconciliation_failed',
      'Database restore job is terminal but reconciliation remains pending',
    );
  }

  let acknowledgement;
  try { acknowledgement = await jobRegistry.acknowledgeReconciliation(expected); }
  catch {
    throw new JobRunningDatabaseRestoreRecoveryError(
      'job_database_restore_recovery_acknowledgement_failed',
      'Database restore recovery could not be durably acknowledged',
    );
  }
  if (!acknowledgement || acknowledgement.acknowledged !== true
    || acknowledgement.jobId !== expected.jobId || acknowledgement.serverId !== expected.serverId
    || acknowledgement.status !== 'succeeded') {
    throw new JobRunningDatabaseRestoreRecoveryError(
      'job_database_restore_recovery_acknowledgement_invalid',
      'Database restore recovery acknowledgement is inconsistent',
    );
  }

  return Object.freeze({
    serverId: expected.serverId,
    jobId: expected.jobId,
    operation: OPERATIONS.DATABASE_RESTORE,
    status: 'succeeded',
    recoveryMethod: 'verified_database_restore_receipt_backups_and_live_digest',
    reconciled: true,
  });
}

export const jobRunningDatabaseRestoreRecoveryInternals = Object.freeze({
  identity,
  requireStoppedConsumers,
  assertCandidate,
  recoveryIntent,
  assertReceipt,
  assertBackupManifest,
  verifyEvidence,
});
