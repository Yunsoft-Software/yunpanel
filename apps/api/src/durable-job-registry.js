export class DurableJobRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DurableJobRegistryError';
    this.code = code;
  }
}

export function createDurableJobRegistry({ filePath, registryFactory, now = () => Date.now() } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new DurableJobRegistryError('durable_job_store_required', 'Durable job registry requires a file path');
  if (typeof registryFactory !== 'function') throw new DurableJobRegistryError('durable_job_factory_required', 'Durable job registry requires a registry factory');

  let registry = registryFactory({ filePath, now });
  let initialized = false;
  let initializing = null;
  let mutationTail = Promise.resolve();
  let fatal = null;

  function assertHealthy() {
    if (fatal) throw new DurableJobRegistryError(fatal.code, fatal.message);
  }

  async function initialize(candidate = registry) {
    if (!candidate || typeof candidate.init !== 'function') {
      throw new DurableJobRegistryError('durable_job_registry_invalid', 'Durable job registry factory returned an invalid registry');
    }
    await candidate.init();
    return candidate;
  }

  async function init() {
    if (initialized) return;
    assertHealthy();
    if (initializing) return initializing;
    initializing = (async () => {
      try {
        registry = await initialize(registry);
        initialized = true;
      } catch {
        fatal = Object.freeze({ code: 'durable_job_init_failed', message: 'Durable job registry could not be initialized' });
        throw new DurableJobRegistryError(fatal.code, fatal.message);
      } finally {
        initializing = null;
      }
    })();
    return initializing;
  }

  async function reloadDurableState() {
    try {
      const replacement = registryFactory({ filePath, now });
      registry = await initialize(replacement);
      initialized = true;
    } catch {
      fatal = Object.freeze({ code: 'durable_job_recovery_failed', message: 'Durable job registry could not recover committed state' });
      throw new DurableJobRegistryError(fatal.code, fatal.message);
    }
  }

  async function mutate(method, args) {
    await init();
    const operation = mutationTail.then(async () => {
      assertHealthy();
      if (typeof registry[method] !== 'function') throw new DurableJobRegistryError('durable_job_method_missing', `Durable job registry does not implement ${method}`);
      try {
        return await registry[method](...args);
      } catch (error) {
        await reloadDurableState();
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
  };
}
