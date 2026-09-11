import os from 'node:os';
import { createNodeRuntimeManager } from '@yunpanel/host-runtime';
import { createDurableJobRegistry } from './durable-job-registry.js';
import { createJobRecoveryContextReader } from './job-recovery-context.js';
import { JobRecoveryRuntimeError, jobRecoveryRuntimeInternals, resolveJobRecoveryPaths } from './job-recovery-runtime.js';
import { createJobRecoveryStore } from './job-recovery-store.js';
import { createJobRegistry } from './job-registry.js';
import { recoverRunningNodeRuntimeInstall } from './job-running-node-runtime-recovery.js';
import { createMigrationServiceStatus } from './local-migration-cli.js';
import { createServerRegistry } from './server-registry.js';

export async function runRunningNodeRuntimeRecoveryFromStores({
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
  runtimeManagerFactory = createNodeRuntimeManager,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = recoverRunningNodeRuntimeInstall,
} = {}) {
  for (const dependency of [serverRegistryFactory, jobRegistryFactory, durableRegistryFactory, recoveryStoreFactory,
    contextReaderFactory, runtimeManagerFactory, serviceStatus, recoverCommand]) {
    if (typeof dependency !== 'function') throw new JobRecoveryRuntimeError('job_recovery_runtime_dependencies_invalid', 'Node runtime recovery dependencies are invalid');
  }
  const paths = resolveJobRecoveryPaths({ env, packaged, cwd });
  const { jobRegistry, contextReader } = await jobRecoveryRuntimeInternals.initHostScopedRecovery({
    paths, serverId, hostname, serverRegistryFactory, jobRegistryFactory, durableRegistryFactory, recoveryStoreFactory, contextReaderFactory,
  });
  const manager = runtimeManagerFactory();
  if (!manager || typeof manager.inspect !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_node_runtime_inspector_invalid', 'Node runtime recovery inspector is invalid');
  }
  const result = await recoverCommand({
    serverId,
    jobId,
    jobRegistry,
    serviceStatus,
    loadJobContext: (id) => contextReader.read(id),
    inspectNodeRuntimes: () => manager.inspect(),
  });
  return Object.freeze({ ...result, statePaths: paths });
}
