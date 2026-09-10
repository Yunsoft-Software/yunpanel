import { safeLocalOperationError as safeExecutionError } from './local-execution-error.js';

const FAULTS = Object.freeze({
  claim: ['local_claim_unconfirmed', 'Local job claim could not be confirmed. Inspect stored job state before recovery.'],
  execute: ['local_claim_invalid', 'Local job identity is inconsistent. Host execution was not started.'],
  complete: ['local_completion_unconfirmed', 'Host execution ended but its saved result could not be confirmed. Do not repeat the host operation.'],
  reconcile: ['local_reconciliation_failed', 'The job result is saved but resource reconciliation is incomplete. Inspect state before recovery.'],
});

function faultError(fault) {
  return Object.assign(new Error(fault.message), { name: 'LocalExecutorError', ...fault });
}
function unsupportedOperationError(jobId) {
  return Object.assign(new Error('The next queued operation has not been migrated to the local runtime.'), {
    name: 'LocalExecutorError',
    code: 'local_operation_not_migrated',
    phase: 'select',
    jobId,
  });
}
function validClaim(claim, serverId) {
  const { job, envelope } = claim ?? {};
  return job && typeof job.id === 'string' && job.id.length >= 8 && job.id.length <= 128
    && job.serverId === serverId && job.status === 'running'
    && envelope?.id === job.id && typeof job.operation === 'string'
    && envelope.operation === job.operation && envelope.payload
    && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload);
}
function validQueuedJob(job, serverId) {
  return job && typeof job.id === 'string' && job.id.length >= 8 && job.id.length <= 128
    && job.serverId === serverId && job.status === 'queued' && typeof job.operation === 'string';
}
function durableReconciliationMode(jobRegistry) {
  const begin = typeof jobRegistry?.beginReconciliation === 'function';
  const acknowledge = typeof jobRegistry?.acknowledgeReconciliation === 'function';
  if (begin !== acknowledge) throw new Error('Local executor durable reconciliation boundary is incomplete');
  return begin;
}
function cloneEvidenceValue(value) {
  try { return structuredClone(value); }
  catch { return null; }
}

/**
 * Executes one already-authorized job inside the API process. An uncertain
 * claim, result write or reconciliation HALTS this instance, including manual
 * runOnce/start calls. Recovery must inspect durable and host state first; this
 * is not a retry engine and does not claim crash-safe exactly-once execution.
 *
 * When supportsOperation is supplied, the executor inspects the head of the
 * local server queue before claiming it. An unmigrated operation is left queued
 * and rejected without changing attempts/status, so a partial migration cannot
 * accidentally consume work that still belongs to the legacy transport.
 *
 * recordExecutionEvidence is an internal best-effort hook for tightly-scoped,
 * secret-free recovery receipts. It runs only after successful host execution
 * and before durable completion. Its failure never recasts a successful host
 * operation as failed and never prevents the normal completion attempt.
 */
export function createLocalJobExecutor({
  serverId,
  jobRegistry,
  executeOperation,
  reconcileCompletedJob,
  supportsOperation = null,
  recordExecutionEvidence = null,
  pollMs = 1000,
  onError = () => {},
} = {}) {
  if (typeof serverId !== 'string' || !serverId) throw new Error('Local executor requires a serverId');
  if (!jobRegistry || typeof jobRegistry.claimNext !== 'function' || typeof jobRegistry.complete !== 'function') throw new Error('Local executor requires a job registry');
  const journalReconciliation = durableReconciliationMode(jobRegistry);
  if (supportsOperation !== null && typeof supportsOperation !== 'function') throw new Error('Local executor operation selector must be a function');
  if (supportsOperation && typeof jobRegistry.listJobs !== 'function') throw new Error('Local executor operation selection requires job listing');
  if (recordExecutionEvidence !== null && typeof recordExecutionEvidence !== 'function') throw new Error('Local executor evidence recorder must be a function');
  if (typeof executeOperation !== 'function') throw new Error('Local executor requires an operation handler');
  if (typeof reconcileCompletedJob !== 'function') throw new Error('Local executor requires job reconciliation');
  if (!Number.isInteger(pollMs) || pollMs < 50 || pollMs > 60_000) throw new Error('Local executor poll interval is invalid');

  let stopped = true;
  let timer = null;
  let active = null;
  let stopping = null;
  let epoch = 0;
  let fault = null;

  function halt(phase, jobId = null) {
    const [code, message] = FAULTS[phase];
    fault = Object.freeze({ code, message, phase, jobId });
    stopped = true;
    epoch += 1;
    if (timer) { clearTimeout(timer); timer = null; }
    return faultError(fault);
  }

  async function selectNextJob() {
    if (!supportsOperation) return null;
    let queued;
    try {
      queued = await jobRegistry.listJobs({ serverId, status: 'queued' });
    } catch {
      throw halt('claim');
    }
    if (!Array.isArray(queued)) throw halt('claim');
    const next = queued[0] ?? null;
    if (!next) return null;
    if (!validQueuedJob(next, serverId)) throw halt('claim');
    let supported = false;
    try { supported = supportsOperation(next.operation) === true; }
    catch { throw halt('execute', next.id); }
    if (!supported) throw unsupportedOperationError(next.id);
    return next.id;
  }

  async function work() {
    const expectedJobId = await selectNextJob();
    let claim;
    try { claim = await jobRegistry.claimNext(serverId); }
    catch { throw halt('claim'); }
    if (claim === null) {
      if (expectedJobId) throw halt('claim', expectedJobId);
      return { claimed: false, job: null, reconciliation: null };
    }
    if (!validClaim(claim, serverId)) throw halt('execute');
    if (expectedJobId && claim.job.id !== expectedJobId) throw halt('execute', claim.job.id);
    if (supportsOperation) {
      let supported = false;
      try { supported = supportsOperation(claim.job.operation) === true; }
      catch { throw halt('execute', claim.job.id); }
      if (!supported) throw halt('execute', claim.job.id);
    }

    // A host error is the ONLY reason to record a failed operation. Storage and
    // reconciliation failures must never be recast as a host failure.
    const jobId = claim.job.id;
    let completion;
    try {
      const result = await executeOperation(claim.envelope.operation, claim.envelope.payload);
      if (recordExecutionEvidence) {
        const payloadCopy = cloneEvidenceValue(claim.envelope.payload);
        const resultCopy = cloneEvidenceValue(result);
        if (payloadCopy && resultCopy) {
          try {
            await recordExecutionEvidence({
              serverId,
              jobId,
              operation: claim.envelope.operation,
              payload: payloadCopy,
              result: resultCopy,
            });
          } catch {
            // Recovery receipts are supplementary. Normal durable completion is
            // still attempted so a receipt failure cannot strand a successful job.
          }
        }
      }
      completion = { serverId, jobId, status: 'succeeded', result };
    } catch (error) {
      completion = { serverId, jobId, status: 'failed', error: safeExecutionError(error) };
    }

    if (journalReconciliation) {
      try {
        const pending = await jobRegistry.beginReconciliation({ serverId, jobId });
        if (!pending || pending.jobId !== jobId || pending.serverId !== serverId || pending.status !== 'running' || pending.pending !== true) {
          throw new Error('Inconsistent durable reconciliation acknowledgement');
        }
      } catch { throw halt('complete', jobId); }
    }

    let terminal;
    try {
      terminal = await jobRegistry.complete(completion);
      if (!terminal || terminal.id !== jobId || terminal.serverId !== serverId || terminal.status !== completion.status) {
        throw new Error('Inconsistent completion acknowledgement');
      }
    } catch { throw halt('complete', jobId); }

    let reconciliation;
    try {
      reconciliation = await reconcileCompletedJob(terminal);
      if (journalReconciliation) {
        const acknowledged = await jobRegistry.acknowledgeReconciliation({ serverId, jobId });
        if (!acknowledged || acknowledged.jobId !== jobId || acknowledged.serverId !== serverId
          || acknowledged.status !== terminal.status || acknowledged.acknowledged !== true) {
          throw new Error('Inconsistent durable reconciliation completion');
        }
      }
    } catch { throw halt('reconcile', jobId); }
    return { claimed: true, job: terminal, reconciliation };
  }

  function runOnce() {
    if (fault) return Promise.reject(faultError(fault));
    if (stopping) return Promise.reject(Object.assign(new Error('Local executor is draining.'), { code: 'local_executor_stopping' }));
    if (active) return active;
    active = work().finally(() => { active = null; });
    return active;
  }

  function schedule(delay = pollMs, generation = epoch) {
    if (stopped || timer || generation !== epoch) return;
    timer = setTimeout(async () => {
      timer = null;
      if (stopped || generation !== epoch) return;
      try {
        const result = await runOnce();
        schedule(result.claimed ? 0 : pollMs, generation);
      } catch (error) {
        try { onError(error); } catch {}
        schedule(pollMs, generation);
      }
    }, delay);
    timer.unref?.();
  }

  function start() {
    if (fault) throw faultError(fault);
    if (stopping) throw Object.assign(new Error('Local executor is draining.'), { code: 'local_executor_stopping' });
    if (!stopped) return;
    stopped = false;
    epoch += 1;
    schedule(0);
  }

  function stop() {
    stopped = true;
    epoch += 1;
    if (timer) { clearTimeout(timer); timer = null; }
    if (stopping) return stopping;
    if (!active) return Promise.resolve();
    stopping = active.catch(() => {}).finally(() => { stopping = null; });
    return stopping;
  }

  return {
    serverId,
    runOnce,
    start,
    stop,
    running: () => !stopped,
    failure: () => fault ? { ...fault } : null,
  };
}

export const localExecutorInternals = Object.freeze({
  safeExecutionError,
  durableReconciliationMode,
  cloneEvidenceValue,
});
