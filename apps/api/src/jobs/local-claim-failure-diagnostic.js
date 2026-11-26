import { ProcessStoreLockError } from '../runtime/process-store-lock.js';
import { DurableJobRegistryError } from './durable-job-registry.js';
import { JobRegistryError } from './job-registry.js';

const BOUNDARIES = new Set(['select_queued', 'claim_next']);
const CLASSES = new Set(['ProcessStoreLockError', 'DurableJobRegistryError', 'JobRegistryError', 'SyntaxError', 'TypeError', 'Error', 'unknown']);
const CODES = new Set([
  'none', 'unknown', 'process_store_locked', 'process_store_lock_failed',
  'process_store_lock_unreadable', 'process_store_lock_ownership_changed',
  'process_store_lock_invalid', 'process_store_lock_action_invalid',
  'durable_job_reconciliation_required', 'durable_job_method_missing',
  'durable_job_recovery_failed', 'durable_job_recovery_record_failed',
  'durable_job_recovery_scan_failed', 'durable_job_recovery_state_invalid',
  'durable_job_init_failed', 'EACCES', 'EPERM', 'ENOENT', 'EIO', 'ENOSPC',
  'EROFS', 'EMFILE', 'ENFILE', 'EINVAL',
]);
const FAULT_CODES = new Set(['local_claim_unconfirmed', 'local_claim_invalid', 'local_completion_unconfirmed', 'local_reconciliation_failed', 'local_runtime_snapshot_refresh_failed', 'local_executor_fault']);
const PHASES = new Set(['claim', 'execute', 'complete', 'reconcile', 'snapshot', 'executor', 'unknown']);

function ownData(value, key) {
  try {
    const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : null;
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}

export function safeClaimFailureFields(value) {
  const failureBoundary = ownData(value, 'failureBoundary');
  const causeClass = ownData(value, 'causeClass'), causeCode = ownData(value, 'causeCode');
  if (!BOUNDARIES.has(failureBoundary) || !CLASSES.has(causeClass) || !CODES.has(causeCode)) return {};
  return { failureBoundary, causeClass, causeCode };
}

export function claimFailureDiagnostic(error, failureBoundary) {
  let causeClass = 'unknown', causeCode = 'none';
  try {
    if (error instanceof ProcessStoreLockError) causeClass = 'ProcessStoreLockError';
    else if (error instanceof DurableJobRegistryError) causeClass = 'DurableJobRegistryError';
    else if (error instanceof JobRegistryError) causeClass = 'JobRegistryError';
    else if (error instanceof SyntaxError) causeClass = 'SyntaxError';
    else if (error instanceof TypeError) causeClass = 'TypeError';
    else if (error instanceof Error) causeClass = 'Error';
    const descriptor = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : null;
    if (descriptor) { const code = Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined; causeCode = CODES.has(code) ? code : 'unknown'; }
  } catch { causeClass = 'unknown'; causeCode = 'unknown'; }
  return safeClaimFailureFields({ failureBoundary, causeClass, causeCode });
}

export function localExecutorFaultLine(error) {
  const rawCode = ownData(error, 'code'), rawPhase = ownData(error, 'phase'), rawJobId = ownData(error, 'jobId');
  const code = FAULT_CODES.has(rawCode) ? rawCode : 'local_executor_fault';
  const phase = PHASES.has(rawPhase) ? rawPhase : 'unknown';
  const jobId = typeof rawJobId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawJobId) ? rawJobId : 'none';
  const diagnostic = safeClaimFailureFields(error);
  const suffix = phase === 'claim' && diagnostic.failureBoundary
    ? ` failureBoundary=${diagnostic.failureBoundary} causeClass=${diagnostic.causeClass} causeCode=${diagnostic.causeCode}` : '';
  return `[yunpanel-api] local executor fault code=${code} phase=${phase} job=${jobId}${suffix}`;
}
