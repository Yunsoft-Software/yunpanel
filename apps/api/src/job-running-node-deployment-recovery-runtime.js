import os from 'node:os';
import { createNodeStatusInspector } from '@yunpanel/host-runtime';
import { createApplicationRegistry } from './application-registry.js';
import { createDurableJobRegistry } from './durable-job-registry.js';
import { createJobRecoveryContextReader } from './job-recovery-context.js';
import { JobRecoveryRuntimeError, jobRecoveryRuntimeInternals, resolveJobRecoveryPaths } from './job-recovery-runtime.js';
import { createJobRecoveryStore } from './job-recovery-store.js';
import { createJobRegistry } from './job-registry.js';
import { createNodeDeploymentReceiptStore } from './node-deployment-receipt.js';
import { recoverRunningNodeDeployment } from './job-running-node-deployment-recovery.js';
import { createMigrationServiceStatus } from './local-migration-cli.js';
import { createServerRegistry } from './server-registry.js';

export async function runRunningNodeDeploymentRecoveryFromStores({
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
  receiptStoreFactory = createNodeDeploymentReceiptStore,
  statusInspectorFactory = createNodeStatusInspector,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = recoverRunningNodeDeployment,
} = {}) {
  for (const dependency of [serverRegistryFactory, applicationRegistryFactory, jobRegistryFactory, durableRegistryFactory,
    recoveryStoreFactory, contextReaderFactory, receiptStoreFactory, statusInspectorFactory, serviceStatus, recoverCommand]) {
    if (typeof dependency !== 'function') {
      throw new JobRecoveryRuntimeError('job_recovery_runtime_dependencies_invalid', 'Node deployment recovery runtime dependencies are invalid');
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
    throw new JobRecoveryRuntimeError('job_recovery_node_deployment_receipt_invalid', 'Node deployment recovery receipt store is invalid');
  }
  const statusInspector = statusInspectorFactory();
  if (!statusInspector || typeof statusInspector.inspectNodeStatus !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_node_deployment_status_invalid', 'Node deployment recovery status inspector is invalid');
  }

  const result = await recoverCommand({
    serverId,
    jobId,
    jobRegistry,
    applicationRegistry,
    serviceStatus,
    loadJobContext: (id) => contextReader.read(id),
    readDeploymentReceipt: (receiptServerId, receiptJobId) => receiptStore.read(receiptServerId, receiptJobId),
    inspectNodeStatus: (intent) => statusInspector.inspectNodeStatus(intent),
  });
  return Object.freeze({ ...result, statePaths: paths });
}
