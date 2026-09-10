import { createJobRecoveryStore } from './job-recovery-store.js';

export class DurableJobRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DurableJobRegistryError';
    this.code = code;
  }
}

const RECOVERY_CODE = 'durable_job_reconciliation_required';
const RECOVERY_MESSAGE = 'Persisted running jobs require reconciliation before new job mutations can continue';

function safeRecoveryJob(job) {
  const jobId = typeof job?.id === 'string' && job.id.length >= 8 && job.id.length <= 128 ? job.id : null;
  const serverId = typeof job?.serverId === 'string' && job.serverId.length >= 1 && job.serverId.length <= 128 ? job.serverId : null;
  return jobId && serverId ? Object.freeze({ jobId, serverId }) : null;
}

function recoveryIdentity(jobs) {
  return [...jobs].map((job) => `${job.serverId}:${job.jobId}`).sort().join('\n');
}

export function createDurableJobRegistry({
  filePath,
  registryFactory,
  recoveryStoreFactory = createJobRecoveryStore,
  now = () => Date.now(),
} = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new DurableJobRegistryError('durable_job_store_required', 'Durable job registry requires a file path');
  if (typeof registryFactory !== 'function') throw new DurableJobRegistryError('durable_job_factory_required', 'Durable job registry requires a registry factory');
  if (typeof recoveryStoreFactory !== 'function') throw new DurableJobRegistryError('durable_job_recovery_factory_required', 'Durable job registry requires a recovery store factory');

  const recoveryFilePath = `${filePath}.recovery.json`;
  let registry = registryFactory({ filePath, now });
  const recoveryStore = recoveryStoreFactory({ filePath: recoveryFilePath, now });
  let initialized = false;
  let initializing = null;
  let mutationTail = Promise.resolve();
  let fatal = null;
  let recovery = null;

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

  async function initialize(candidate = registry) {
    if (!candidate || typeof candidate.init !== 'function' || typeof candidate.listJobs !== 'function') {
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

  async function syncRecoveryRecord() {
    const jobs = recovery?.jobs ?? [];
    let stored;
    try {
      stored = recoveryStore.snapshot();
    } catch {
      latch('durable_job_recovery_record_failed', 'Durable job recovery record could not be inspected');
    }
    if (Array.isArray(stored?.jobs) && recoveryIdentity(stored.jobs) === recoveryIdentity(jobs)) return;
    try {
      await recoveryStore.replace(jobs);
    } catch {
      latch('durable_job_recovery_record_failed', 'Durable job recovery record could not be synchronized');
    }
  }

  async function detectRecovery(candidate = registry) {
    let running;
    try {
      running = await candidate.listJobs({ status: 'running' });
    } catch {
      latch('durable_job_recovery_scan_failed', 'Durable job registry could not inspect recovery state');
    }
    if (!Array.isArray(running)) latch('durable_job_recovery_scan_failed', 'Durable job registry could not inspect recovery state');
    const jobs = running.map(safeRecoveryJob);
    if (jobs.some((job) => job === null)) latch('durable_job_recovery_state_invalid', 'Durable job registry contains invalid running-job identity');
    recovery = jobs.length > 0 ? Object.freeze({ code: RECOVERY_CODE, jobs: Object.freeze(jobs) }) : null;
    await syncRecoveryRecord();
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

  async function mutate(method, args) {
    await init();
    const operation = mutationTail.then(async () => {
      assertMutationAllowed(method);
      if (typeof registry[method] !== 'function') throw new DurableJobRegistryError('durable_job_method_missing', `Durable job registry does not implement ${method}`);
      try {
        const result = await registry[method](...args);
        if (method === 'complete' && recovery) await detectRecovery(registry);
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
});
