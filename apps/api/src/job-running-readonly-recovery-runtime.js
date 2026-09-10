import os from 'node:os';
import { createDurableJobRegistry } from './durable-job-registry.js';
import { createLocalHostOperations } from './local-host-operations.js';
import { createJobRecoveryContextReader } from './job-recovery-context.js';
import { JobRecoveryRuntimeError, jobRecoveryRuntimeInternals, resolveJobRecoveryPaths } from './job-recovery-runtime.js';
import { createJobRecoveryStore } from './job-recovery-store.js';
import { recoverRunningInspection } from './job-running-recovery.js';
import { createJobRegistry } from './job-registry.js';
import { createMigrationServiceStatus } from './local-migration-cli.js';
import { createServerRegistry } from './server-registry.js';

export async function runRunningReadOnlyRecoveryFromStores({
  serverId,
  jobId,
  hostname = os.hostname(),
  env = process.env,
  packaged = false,
  cwd = process.cwd(),
  serverRegistryFactory = createServerRegistry,
  jobRegistryFactory = createJobRegistry,
  durableRegistryFactory = createDurableJobRegistry,
  recoveryStoreFactory = createJobRecoveryStore,
  contextReaderFactory = createJobRecoveryContextReader,
  hostOperationsFactory = createLocalHostOperations,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = recoverRunningInspection,
} = {}) {
  for (const dependency of [
    serverRegistryFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    contextReaderFactory,
    hostOperationsFactory,
    serviceStatus,
    recoverCommand,
  ]) {
    if (typeof dependency !== 'function') {
      throw new JobRecoveryRuntimeError('job_recovery_runtime_dependencies_invalid', 'Read-only recovery runtime dependencies are invalid');
    }
  }

  const paths = resolveJobRecoveryPaths({ env, packaged, cwd });
  const { jobRegistry, contextReader } = await jobRecoveryRuntimeInternals.initHostScopedRecovery({
    paths,
    serverId,
    hostname,
    serverRegistryFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    contextReaderFactory,
  });
  const hostOperations = hostOperationsFactory();
  if (!hostOperations || typeof hostOperations.executeOperation !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_host_operations_invalid', 'Read-only recovery host operations are invalid');
  }

  const result = await recoverCommand({
    serverId,
    jobId,
    jobRegistry,
    serviceStatus,
    loadJobContext: (id) => contextReader.read(id),
    executeOperation: (operation, payload) => hostOperations.executeOperation(operation, payload),
  });
  return Object.freeze({ ...result, statePaths: paths });
}
