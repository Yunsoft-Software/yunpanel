import { acquireLocalExecutionLock, LocalExecutionLockError } from './local-execution-lock.js';
import { createLocalHostOperations } from './local-host-operations.js';
import { createLocalJobExecutor } from './local-job-executor.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const DEFAULT_SNAPSHOT_INTERVAL_MS = 30_000;

export class LocalRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalRuntimeError';
    this.code = code;
  }
}

function normalizeHostname(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 253) {
    throw new LocalRuntimeError('invalid_local_hostname', 'Local runtime hostname is invalid');
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalized)) {
    throw new LocalRuntimeError('invalid_local_hostname', 'Local runtime hostname is invalid');
  }
  return normalized;
}

function normalizeRuntimeVersion(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 40 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new LocalRuntimeError('invalid_local_runtime_version', 'Local runtime version is invalid');
  }
  return value;
}

function normalizeSnapshotInterval(value) {
  if (!Number.isInteger(value) || value < 50 || value > 60_000) {
    throw new LocalRuntimeError('invalid_local_snapshot_interval', 'Local runtime snapshot interval must be between 50 and 60000 milliseconds');
  }
  return value;
}

function assertBoundServer(server, serverId, hostname) {
  if (!server || server.id !== serverId) {
    throw new LocalRuntimeError('local_server_not_found', 'Configured local server record was not found');
  }
  if (server.executionMode !== 'local') {
    throw new LocalRuntimeError('local_server_not_bound', 'Configured server is not assigned to the local runtime');
  }
  if (typeof server.localBoundAt !== 'string' || !Number.isFinite(Date.parse(server.localBoundAt))) {
    throw new LocalRuntimeError('local_server_binding_invalid', 'Configured local server binding is incomplete');
  }
  if (normalizeHostname(server.hostname) !== hostname) {
    throw new LocalRuntimeError('local_server_hostname_mismatch', 'Configured local server hostname does not match this runtime');
  }
  return server;
}

function validateDependencies({ registry, jobRegistry, domainRegistry, certificateRegistry, applicationRegistry, hostOperations }) {
  if (!registry || typeof registry.getServer !== 'function' || typeof registry.updateLocalSnapshot !== 'function') {
    throw new LocalRuntimeError('local_runtime_registry_invalid', 'Local runtime requires the server registry');
  }
  if (!jobRegistry || typeof jobRegistry.claimNext !== 'function' || typeof jobRegistry.listJobs !== 'function' || typeof jobRegistry.complete !== 'function') {
    throw new LocalRuntimeError('local_runtime_jobs_invalid', 'Local runtime requires the job registry');
  }
  if (!domainRegistry || !certificateRegistry || !applicationRegistry) {
    throw new LocalRuntimeError('local_runtime_reconciliation_invalid', 'Local runtime requires resource registries');
  }
  if (!hostOperations || typeof hostOperations.supports !== 'function' || typeof hostOperations.executeOperation !== 'function') {
    throw new LocalRuntimeError('local_runtime_operations_invalid', 'Local runtime requires host operations');
  }
}

function snapshotFault() {
  return Object.assign(
    new Error('Local runtime snapshot refresh failed; host execution has been stopped.'),
    {
      name: 'LocalRuntimeError',
      code: 'local_runtime_snapshot_refresh_failed',
      phase: 'snapshot',
      jobId: null,
    },
  );
}

export async function startLocalRuntime({
  serverId,
  hostname,
  runtimeVersion,
  lockPath,
  registry,
  jobRegistry,
  domainRegistry,
  certificateRegistry,
  applicationRegistry,
  hostOperations = createLocalHostOperations(),
  executorFactory = createLocalJobExecutor,
  acquireLock = acquireLocalExecutionLock,
  reconcile = reconcileCompletedJob,
  onError = () => {},
  snapshotIntervalMs = DEFAULT_SNAPSHOT_INTERVAL_MS,
} = {}) {
  if (typeof serverId !== 'string' || serverId.length < 1 || serverId.length > 128) {
    throw new LocalRuntimeError('invalid_local_server_id', 'Local runtime server id is invalid');
  }
  const normalizedHostname = normalizeHostname(hostname);
  const normalizedVersion = normalizeRuntimeVersion(runtimeVersion);
  const normalizedSnapshotInterval = normalizeSnapshotInterval(snapshotIntervalMs);
  if (typeof lockPath !== 'string' || !lockPath) throw new LocalRuntimeError('invalid_local_lock_path', 'Local runtime lock path is required');
  if (typeof executorFactory !== 'function' || typeof acquireLock !== 'function' || typeof reconcile !== 'function' || typeof onError !== 'function') {
    throw new LocalRuntimeError('local_runtime_adapter_invalid', 'Local runtime adapter configuration is invalid');
  }
  validateDependencies({ registry, jobRegistry, domainRegistry, certificateRegistry, applicationRegistry, hostOperations });

  assertBoundServer(await registry.getServer(serverId), serverId, normalizedHostname);
  let lock;
  let executor;
  let snapshotTimer = null;
  let stopped = false;
  let resourcesClosed = false;
  let stopping = null;
  let fault = null;

  async function closeResources() {
    if (stopping) return stopping;
    if (resourcesClosed) return;
    stopped = true;
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
      snapshotTimer = null;
    }
    stopping = (async () => {
      let stopError = null;
      try { await executor?.stop?.(); } catch (error) { stopError = error; }
      try { await lock?.release?.(); } catch (error) { if (!stopError) stopError = error; }
      resourcesClosed = true;
      if (stopError) throw stopError;
    })().finally(() => { stopping = null; });
    return stopping;
  }

  async function refreshSnapshot() {
    const snapshot = await registry.updateLocalSnapshot({
      serverId,
      hostname: normalizedHostname,
      runtimeVersion: normalizedVersion,
    });
    assertBoundServer(snapshot, serverId, normalizedHostname);
    return snapshot;
  }

  function scheduleSnapshotRefresh() {
    if (stopped || snapshotTimer) return;
    snapshotTimer = setTimeout(async () => {
      snapshotTimer = null;
      if (stopped) return;
      try {
        await refreshSnapshot();
        scheduleSnapshotRefresh();
      } catch {
        fault = Object.freeze({
          code: 'local_runtime_snapshot_refresh_failed',
          phase: 'snapshot',
          jobId: null,
        });
        const error = snapshotFault();
        try { onError(error); } catch {}
        await closeResources().catch(() => {});
      }
    }, normalizedSnapshotInterval);
    snapshotTimer.unref?.();
  }

  try {
    lock = await acquireLock({ filePath: lockPath, serverId });
    assertBoundServer(await registry.getServer(serverId), serverId, normalizedHostname);

    const reconcileJob = async (job) => {
      const result = await reconcile({ domainRegistry, certificateRegistry, applicationRegistry, job });
      if (!result || result.reconciled !== true) {
        const error = new Error('Local job reconciliation did not complete');
        error.code = result?.error?.code ?? 'local_reconciliation_failed';
        throw error;
      }
      return result;
    };

    executor = executorFactory({
      serverId,
      jobRegistry,
      supportsOperation: (operation) => hostOperations.supports(operation),
      executeOperation: (operation, payload) => hostOperations.executeOperation(operation, payload),
      reconcileCompletedJob: reconcileJob,
      onError,
    });
    if (!executor || typeof executor.start !== 'function' || typeof executor.stop !== 'function') {
      throw new LocalRuntimeError('local_runtime_executor_invalid', 'Local executor factory returned an invalid executor');
    }

    await refreshSnapshot();
    executor.start();
    scheduleSnapshotRefresh();

    return {
      serverId,
      hostname: normalizedHostname,
      runtimeVersion: normalizedVersion,
      operations: Array.isArray(hostOperations.operations) ? [...hostOperations.operations] : [],
      failure: () => fault ? { ...fault } : null,
      async stop() {
        await closeResources();
      },
    };
  } catch (error) {
    stopped = true;
    if (snapshotTimer) clearTimeout(snapshotTimer);
    if (executor && typeof executor.stop === 'function') await executor.stop().catch(() => {});
    if (lock && typeof lock.release === 'function') await lock.release().catch(() => {});
    if (error instanceof LocalRuntimeError || error instanceof LocalExecutionLockError) throw error;
    throw new LocalRuntimeError('local_runtime_start_failed', 'Local runtime could not be started safely');
  }
}

export const localRuntimeInternals = Object.freeze({
  normalizeHostname,
  normalizeRuntimeVersion,
  normalizeSnapshotInterval,
  assertBoundServer,
  defaultSnapshotIntervalMs: DEFAULT_SNAPSHOT_INTERVAL_MS,
});
