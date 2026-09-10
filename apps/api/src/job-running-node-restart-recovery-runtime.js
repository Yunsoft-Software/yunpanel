import os from 'node:os';
import { createNodeStatusInspector } from '@yunpanel/host-runtime';
import { createApplicationRegistry } from './application-registry.js';
import { createDurableJobRegistry } from './durable-job-registry.js';
import { createJobRecoveryContextReader } from './job-recovery-context.js';
import { JobRecoveryRuntimeError, jobRecoveryRuntimeInternals, resolveJobRecoveryPaths } from './job-recovery-runtime.js';
import { createJobRecoveryStore } from './job-recovery-store.js';
import { createJobRegistry } from './job-registry.js';
import { recoverRunningNodeRestart } from './job-running-node-restart-recovery.js';
import { createMigrationServiceStatus } from './local-migration-cli.js';
import { createNodeRestartReceiptStore } from './node-restart-receipt.js';
import { createServerRegistry } from './server-registry.js';

export async function runRunningNodeRestartRecoveryFromStores({
  serverId,
  jobId,
  hostname = os.hostname(),
  env = process.env,
  packaged = false,
  cwd = process.cwd(),
  serverRegistryFactory = createServerRegistry,
  applicationRegistryFactory = createApplicationRegistry,
  jobRegistryFactory = createJobRegistry,
  durableRegistryFactory = createDurableJobRegistry,
  recoveryStoreFactory = createJobRecoveryStore,
  contextReaderFactory = createJobRecoveryContextReader,
  receiptStoreFactory = createNodeRestartReceiptStore,
  statusInspectorFactory = createNodeStatusInspector,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = recoverRunningNodeRestart,
} = {}) {
  for (const dependency of [serverRegistryFactory, applicationRegistryFactory, jobRegistryFactory, durableRegistryFactory,
    recoveryStoreFactory, contextReaderFactory, receiptStoreFactory, statusInspectorFactory, serviceStatus, recoverCommand]) {
    if (typeof dependency !== 'function') {
      throw new JobRecoveryRuntimeError('job_recovery_runtime_dependencies_invalid', 'Node restart recovery runtime dependencies are invalid');
    }
  }

  const paths = resolveJobRecoveryPaths({ env, packaged, cwd });
  const { serverRegistry, jobRegistry, contextReader } = await jobRecoveryRuntimeInternals.initHostScopedRecovery({
    paths, serverId, hostname, serverRegistryFactory, jobRegistryFactory, durableRegistryFactory, recoveryStoreFactory, contextReaderFactory,
  });
  const serverExists = async (id) => Boolean(await serverRegistry.getServer(id));
  const applicationRegistry = await jobRecoveryRuntimeInternals.initRegistry(
    applicationRegistryFactory({ filePath: paths.applicationStore, serverExists }),
    'Application',
  );
  const receiptStore = receiptStoreFactory();
  if (!receiptStore || typeof receiptStore.read !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_node_restart_receipt_invalid', 'Node restart recovery receipt store is invalid');
  }
  const statusInspector = statusInspectorFactory();
  if (!statusInspector || typeof statusInspector.inspectNodeStatus !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_node_restart_status_invalid', 'Node restart recovery status inspector is invalid');
  }

  const result = await recoverCommand({
    serverId,
    jobId,
    jobRegistry,
    applicationRegistry,
    serviceStatus,
    loadJobContext: (id) => contextReader.read(id),
    readRestartReceipt: (receiptServerId, receiptJobId) => receiptStore.read(receiptServerId, receiptJobId),
    inspectNodeStatus: (intent) => statusInspector.inspectNodeStatus(intent),
  });
  return Object.freeze({ ...result, statePaths: paths });
}
