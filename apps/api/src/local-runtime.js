import { acquireLocalExecutionLock, LocalExecutionLockError } from './local-execution-lock.js';
import { createLocalHostOperations } from './local-host-operations.js';
import { createLocalJobExecutor } from './local-job-executor.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const DEFAULT_SNAPSHOT_INTERVAL_MS = 30_000;
const EXECUTOR_FAULT_CODES = new Set([
  'local_claim_unconfirmed',
  'local_claim_invalid',
  'local_completion_unconfirmed',
  'local_reconciliation_failed',
]);
const EXECUTOR_FAULT_PHASES = new Set(['claim', 'execute', 'complete', 'reconcile']);
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNAPSHOT_FIELDS = new Set(['inventory', 'services']);

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

function normalizeSnapshotPayload(value) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalRuntimeError('local_runtime_snapshot_invalid', 'Local runtime snapshot provider returned invalid state');
  }
  if (Object.keys(value).some((key) => !SNAPSHOT_FIELDS.has(key))) {
    throw new LocalRuntimeError('local_runtime_snapshot_invalid', 'Local runtime snapshot provider returned unsupported state');
  }
  const output = {};
  for (const field of SNAPSHOT_FIELDS) {
    if (!(field in value)) continue;
    const snapshot = value[field];
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new LocalRuntimeError('local_runtime_snapshot_invalid', `Local runtime ${field} snapshot is invalid`);
    }
    output[field] = snapshot;
  }
  return output;
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

function normalizeExecutorFault(error) {
  const code = typeof error?.code === 'string' && EXECUTOR_FAULT_CODES.has(error.code)
    ? error.code
    : 'local_executor_fault';
  const phase = typeof error?.phase === 'string' && EXECUTOR_FAULT_PHASES.has(error.phase)
    ? error.phase
    : 'executor';
  const jobId = typeof error?.jobId === 'string' && JOB_ID_PATTERN.test(error.jobId)
    ? error.jobId.toLowerCase()
    : null;
  return { code, phase, jobId };
}

function safeFaultError(metadata, message) {
  return Object.assign(new Error(message), {
    name: 'LocalRuntimeError',
    code: metadata.code,
    phase: metadata.phase,
    jobId: metadata.jobId,
  });
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
  snapshotProvider = null,
  recordExecutionEvidence = null,
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
  if (snapshotProvider !== null && typeof snapshotProvider !== 'function') {
    throw new LocalRuntimeError('local_runtime_snapshot_provider_invalid', 'Local runtime snapshot provider must be a function');
  }
  if (recordExecutionEvidence !== null && typeof recordExecutionEvidence !== 'function') {
    throw new LocalRuntimeError('local_runtime_evidence_recorder_invalid', 'Local runtime evidence recorder must be a function');
  }
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

  function reportFault(metadata, message) {
    if (fault) return;
    fault = Object.freeze({ ...metadata });
    const safeError = safeFaultError(fault, message);
    try { onError(safeError); } catch {}
    void closeResources().catch(() => {});
  }

  function handleExecutorFault(error) {
    if (stopped || fault) return;
    reportFault(
      normalizeExecutorFault(error),
      'Local host execution stopped because the executor entered a fault state.',
    );
  }

  async function refreshSnapshot() {
    const provided = snapshotProvider ? normalizeSnapshotPayload(await snapshotProvider()) : {};
    const snapshot = await registry.updateLocalSnapshot({
      serverId,
      hostname: normalizedHostname,
      runtimeVersion: normalizedVersion,
      ...provided,
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
        reportFault(
          { code: 'local_runtime_snapshot_refresh_failed', phase: 'snapshot', jobId: null },
          'Local runtime snapshot refresh failed; host execution has been stopped.',
        );
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
      recordExecutionEvidence,
      onError: handleExecutorFault,
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
  normalizeSnapshotPayload,
  normalizeExecutorFault,
  assertBoundServer,
  defaultSnapshotIntervalMs: DEFAULT_SNAPSHOT_INTERVAL_MS,
});
