import { createJobRecoveryStore } from './job-recovery-store.js';

const automaticReconciliationAcks = new WeakMap();

export class DurableJobRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DurableJobRegistryError';
    this.code = code;
  }
}

const RECOVERY_CODE = 'durable_job_reconciliation_required';
const RECOVERY_MESSAGE = 'Persisted running jobs require reconciliation before new job mutations can continue';
const RECOVERABLE_STATUSES = new Set(['running', 'succeeded', 'failed']);
const TERMINAL_STATUSES = new Set(['succeeded', 'failed']);

function safeRecoveryJob(job) {
  const jobId = typeof job?.id === 'string' && job.id.length >= 8 && job.id.length <= 128 ? job.id : null;
  const serverId = typeof job?.serverId === 'string' && job.serverId.length >= 1 && job.serverId.length <= 128 ? job.serverId : null;
  return jobId && serverId ? Object.freeze({ jobId, serverId }) : null;
}

function recoveryIdentity(jobs) {
  return [...jobs].map((job) => `${job.serverId}:${job.jobId}`).sort().join('\n');
}

function recoveryKey(job) {
  return `${job.serverId}:${job.jobId}`;
}

function uniqueRecoveryJobs(jobs) {
  const seen = new Set();
  const output = [];
  for (const job of jobs) {
    if (!job) continue;
    const key = recoveryKey(job);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(Object.freeze({ jobId: job.jobId, serverId: job.serverId }));
  }
  return output;
}

export async function acknowledgeAutomaticJobReconciliation(job) {
  if (!job || typeof job !== 'object') return false;
  const acknowledge = automaticReconciliationAcks.get(job);
  if (typeof acknowledge !== 'function') return false;
  await acknowledge();
  automaticReconciliationAcks.delete(job);
  return true;
}

export function createDurableJobRegistry({
  filePath,
  registryFactory,
  recoveryStoreFactory = createJobRecoveryStore,
  automaticReconciliation = false,
  now = () => Date.now(),
} = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new DurableJobRegistryError('durable_job_store_required', 'Durable job registry requires a file path');
  if (typeof registryFactory !== 'function') throw new DurableJobRegistryError('durable_job_factory_required', 'Durable job registry requires a registry factory');
  if (typeof recoveryStoreFactory !== 'function') throw new DurableJobRegistryError('durable_job_recovery_factory_required', 'Durable job registry requires a recovery store factory');
  if (typeof automaticReconciliation !== 'boolean') throw new DurableJobRegistryError('durable_job_reconciliation_mode_invalid', 'Durable job automatic reconciliation mode is invalid');

  const recoveryFilePath = `${filePath}.recovery.json`;
  let registry = registryFactory({ filePath, now });
  const recoveryStore = recoveryStoreFactory({ filePath: recoveryFilePath, now });
  let initialized = false;
  let initializing = null;
  let mutationTail = Promise.resolve();
  let fatal = null;
  let recovery = null;
  const reconciliationPending = new Set();
  const explicitlyBegunReconciliation = new Set();

  function assertHealthy() {
    if (fatal) throw new DurableJobRegistryError(fatal.code, fatal.message);
  }

  function assertMutationAllowed(method) {
    assertHealthy();
    if (recovery && method !== 'complete') throw new DurableJobRegistryError(RECOVERY_CODE, RECOVERY_MESSAGE);
  }

  function latch(code, message) {
    fatal = Object.freeze({ code, message });
    throw new DurableJobRegistryError(code, message);
  }

  function setRecovery(jobs) {
    const normalized = uniqueRecoveryJobs(jobs);
    recovery = normalized.length > 0 ? Object.freeze({ code: RECOVERY_CODE, jobs: Object.freeze(normalized) }) : null;
  }

  async function initialize(candidate = registry) {
    if (!candidate || typeof candidate.init !== 'function' || typeof candidate.listJobs !== 'function' || typeof candidate.getJob !== 'function') {
      throw new DurableJobRegistryError('durable_job_registry_invalid', 'Durable job registry factory returned an invalid registry');
    }
    await candidate.init();
    return candidate;
  }

  async function initializeRecoveryStore() {
    if (!recoveryStore || typeof recoveryStore.init !== 'function' || typeof recoveryStore.replace !== 'function' || typeof recoveryStore.snapshot !== 'function') {
      latch('durable_job_recovery_store_invalid', 'Durable job recovery store is invalid');
    }
    try {
      await recoveryStore.init();
    } catch {
      latch('durable_job_recovery_record_failed', 'Durable job recovery record could not be initialized');
    }
  }

  function recoverySnapshotJobs() {
    let stored;
    try {
      stored = recoveryStore.snapshot();
    } catch {
      latch('durable_job_recovery_record_failed', 'Durable job recovery record could not be inspected');
    }
    if (!stored || !Array.isArray(stored.jobs)) latch('durable_job_recovery_record_failed', 'Durable job recovery record could not be inspected');
    const jobs = stored.jobs.map((job) => safeRecoveryJob({ id: job?.jobId, serverId: job?.serverId }));
    if (jobs.some((job) => job === null)) latch('durable_job_recovery_state_invalid', 'Durable job recovery record contains invalid job identity');
    return jobs;
  }

  async function replaceRecoveryJobs(jobs) {
    try {
      await recoveryStore.replace(jobs);
    } catch {
      latch('durable_job_recovery_record_failed', 'Durable job recovery record could not be synchronized');
    }
  }

  async function addRecoveryJob(job) {
    try {
      if (typeof recoveryStore.add === 'function') return await recoveryStore.add(job);
      const stored = recoverySnapshotJobs();
      if (stored.some((candidate) => recoveryKey(candidate) === recoveryKey(job))) return recoveryStore.snapshot();
      return await recoveryStore.replace([...stored, job]);
    } catch (error) {
      if (fatal) throw error;
      latch('durable_job_recovery_record_failed', 'Durable job recovery record could not be synchronized');
    }
  }

  async function removeRecoveryJob(job) {
    try {
      if (typeof recoveryStore.remove === 'function') return await recoveryStore.remove(job);
      const stored = recoverySnapshotJobs();
      return await recoveryStore.replace(stored.filter((candidate) => recoveryKey(candidate) !== recoveryKey(job)));
    } catch (error) {
      if (fatal) throw error;
      latch('durable_job_recovery_record_failed', 'Durable job recovery record could not be synchronized');
    }
  }

  async function syncRecoveryRecord(jobs = recovery?.jobs ?? []) {
    const stored = recoverySnapshotJobs();
    if (recoveryIdentity(stored) === recoveryIdentity(jobs)) return;
    await replaceRecoveryJobs(jobs);
  }

  async function detectRecovery(candidate = registry) {
    let running;
    try {
      running = await candidate.listJobs({ status: 'running' });
    } catch {
      latch('durable_job_recovery_scan_failed', 'Durable job registry could not inspect recovery state');
    }
    if (!Array.isArray(running)) latch('durable_job_recovery_scan_failed', 'Durable job registry could not inspect recovery state');

    const runningJobs = running.map(safeRecoveryJob);
    if (runningJobs.some((job) => job === null)) latch('durable_job_recovery_state_invalid', 'Durable job registry contains invalid running-job identity');
    const storedJobs = recoverySnapshotJobs();
    const jobs = uniqueRecoveryJobs([...storedJobs, ...runningJobs]);
    reconciliationPending.clear();
    explicitlyBegunReconciliation.clear();

    for (const identity of storedJobs) {
      let job;
      try {
        job = await candidate.getJob(identity.jobId);
      } catch {
        latch('durable_job_recovery_scan_failed', 'Durable job registry could not inspect recovery state');
      }
      if (!job || job.serverId !== identity.serverId || !RECOVERABLE_STATUSES.has(job.status)) {
        latch('durable_job_recovery_state_invalid', 'Durable job recovery record does not match persisted job state');
      }
      if (TERMINAL_STATUSES.has(job.status)) reconciliationPending.add(recoveryKey(identity));
    }

    setRecovery(jobs);
    await syncRecoveryRecord(jobs);
  }

  async function init() {
    if (initialized) return;
    assertHealthy();
    if (initializing) return initializing;
    initializing = (async () => {
      try {
        registry = await initialize(registry);
        await initializeRecoveryStore();
        await detectRecovery(registry);
        initialized = true;
      } catch (error) {
        if (error instanceof DurableJobRegistryError && fatal) throw error;
        latch('durable_job_init_failed', 'Durable job registry could not be initialized');
      } finally {
        initializing = null;
      }
    })();
    return initializing;
  }

  async function reloadDurableState({ inspectRecovery = false } = {}) {
    try {
      const replacement = registryFactory({ filePath, now });
      registry = await initialize(replacement);
      initialized = true;
      if (inspectRecovery || recovery) await detectRecovery(registry);
    } catch (error) {
      if (error instanceof DurableJobRegistryError && fatal) throw error;
      latch('durable_job_recovery_failed', 'Durable job registry could not recover committed state');
    }
  }

  async function prepareAutomaticReconciliation(input) {
    if (!automaticReconciliation) return null;
    const identity = safeRecoveryJob({ id: input?.jobId, serverId: input?.serverId });
    if (!identity) return null;
    const key = recoveryKey(identity);
    if (explicitlyBegunReconciliation.has(key)) return { identity, key, explicit: true };

    let job;
    try {
      job = await registry.getJob(identity.jobId);
    } catch {
      latch('durable_job_recovery_scan_failed', 'Durable job registry could not inspect recovery state');
    }
    if (job?.serverId === identity.serverId && job.status === 'running') {
      await addRecoveryJob(identity);
      reconciliationPending.add(key);
      setRecovery([...(recovery?.jobs ?? []), identity]);
    }
    return { identity, key, explicit: false };
  }

  async function mutate(method, args) {
    await init();
    const operation = mutationTail.then(async () => {
      assertMutationAllowed(method);
      if (typeof registry[method] !== 'function') throw new DurableJobRegistryError('durable_job_method_missing', `Durable job registry does not implement ${method}`);
      try {
        const automatic = method === 'complete' ? await prepareAutomaticReconciliation(args[0] ?? {}) : null;
        const result = await registry[method](...args);
        if (method === 'complete') {
          const input = args[0] ?? {};
          const identity = automatic?.identity ?? safeRecoveryJob({ id: input.jobId, serverId: input.serverId });
          const key = identity ? recoveryKey(identity) : null;
          if (automaticReconciliation && identity && key && !automatic?.explicit && reconciliationPending.has(key)) {
            automaticReconciliationAcks.set(result, () => acknowledgeReconciliation(identity));
          } else if (recovery && identity && key && !reconciliationPending.has(key)) {
            await removeRecoveryJob(identity);
            await detectRecovery(registry);
          }
        }
        return result;
      } catch (error) {
        if (fatal) throw error;
        await reloadDurableState({ inspectRecovery: method === 'claimNext' || method === 'complete' });
        throw error;
      }
    });
    mutationTail = operation.catch(() => {});
    return operation;
  }

  async function beginReconciliation({ serverId, jobId } = {}) {
    await init();
    const operation = mutationTail.then(async () => {
      assertHealthy();
      const identity = safeRecoveryJob({ id: jobId, serverId });
      if (!identity) throw new DurableJobRegistryError('durable_job_reconciliation_identity_invalid', 'Durable job reconciliation identity is invalid');
      let job;
      try {
        job = await registry.getJob(jobId);
      } catch {
        latch('durable_job_recovery_scan_failed', 'Durable job registry could not inspect recovery state');
      }
      if (!job || job.serverId !== serverId) throw new DurableJobRegistryError('durable_job_reconciliation_job_not_found', 'Durable job reconciliation job was not found');
      if (TERMINAL_STATUSES.has(job.status)) return { jobId, serverId, status: job.status, pending: reconciliationPending.has(recoveryKey(identity)) };
      if (job.status !== 'running') throw new DurableJobRegistryError('durable_job_reconciliation_not_running', 'Only running jobs can enter durable reconciliation');

      await addRecoveryJob(identity);
      const key = recoveryKey(identity);
      reconciliationPending.add(key);
      explicitlyBegunReconciliation.add(key);
      setRecovery([...(recovery?.jobs ?? []), identity]);
      return { jobId, serverId, status: job.status, pending: true };
    });
    mutationTail = operation.catch(() => {});
    return operation;
  }

  async function acknowledgeReconciliation({ serverId, jobId } = {}) {
    await init();
    const operation = mutationTail.then(async () => {
      assertHealthy();
      const identity = safeRecoveryJob({ id: jobId, serverId });
      if (!identity) throw new DurableJobRegistryError('durable_job_reconciliation_identity_invalid', 'Durable job reconciliation identity is invalid');
      let job;
      try {
        job = await registry.getJob(jobId);
      } catch {
        latch('durable_job_recovery_scan_failed', 'Durable job registry could not inspect recovery state');
      }
      if (!job || job.serverId !== serverId) throw new DurableJobRegistryError('durable_job_reconciliation_job_not_found', 'Durable job reconciliation job was not found');
      if (!TERMINAL_STATUSES.has(job.status)) throw new DurableJobRegistryError('durable_job_reconciliation_not_ready', 'Durable job reconciliation can only be acknowledged after terminal completion');

      const stored = recoverySnapshotJobs();
      const key = recoveryKey(identity);
      const recorded = stored.some((candidate) => recoveryKey(candidate) === key);
      if (!recorded) {
        if (reconciliationPending.has(key) || recovery?.jobs.some((candidate) => recoveryKey(candidate) === key)) {
          latch('durable_job_recovery_state_invalid', 'Durable job recovery memory does not match the recovery record');
        }
        explicitlyBegunReconciliation.delete(key);
        return { jobId, serverId, status: job.status, acknowledged: false };
      }

      await removeRecoveryJob(identity);
      reconciliationPending.delete(key);
      explicitlyBegunReconciliation.delete(key);
      setRecovery((recovery?.jobs ?? []).filter((candidate) => recoveryKey(candidate) !== key));
      return { jobId, serverId, status: job.status, acknowledged: true };
    });
    mutationTail = operation.catch(() => {});
    return operation;
  }

  async function read(method, args) {
    await init();
    await mutationTail;
    assertHealthy();
    if (typeof registry[method] !== 'function') throw new DurableJobRegistryError('durable_job_method_missing', `Durable job registry does not implement ${method}`);
    return registry[method](...args);
  }

  return {
    init,
    enqueue: (...args) => mutate('enqueue', args),
    claimNext: (...args) => mutate('claimNext', args),
    complete: (...args) => mutate('complete', args),
    cancel: (...args) => mutate('cancel', args),
    beginReconciliation,
    acknowledgeReconciliation,
    getJob: (...args) => read('getJob', args),
    listJobs: (...args) => read('listJobs', args),
    failure: () => fatal ? { ...fatal } : null,
    recovery: () => recovery ? { code: recovery.code, jobs: recovery.jobs.map((job) => ({ ...job })) } : null,
    recoveryRecord: () => recoveryStore.snapshot(),
  };
}

export const durableJobRegistryInternals = Object.freeze({
  recoveryCode: RECOVERY_CODE,
  recoveryMessage: RECOVERY_MESSAGE,
  safeRecoveryJob,
  recoveryIdentity,
  recoveryKey,
  uniqueRecoveryJobs,
});
