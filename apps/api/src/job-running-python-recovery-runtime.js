import os from 'node:os';
import { createPythonSiteManager } from '@yunpanel/host-runtime';
import { createApplicationRegistry } from './application-registry.js';
import { createDurableJobRegistry } from './durable-job-registry.js';
import { createJobRecoveryContextReader } from './job-recovery-context.js';
import { JobRecoveryRuntimeError, jobRecoveryRuntimeInternals, resolveJobRecoveryPaths } from './job-recovery-runtime.js';
import { createJobRecoveryStore } from './job-recovery-store.js';
import { createJobRegistry } from './job-registry.js';
import {
  recoverRunningPythonDeployment,
  recoverRunningPythonRestart,
  recoverRunningPythonRollback,
} from './job-running-python-recovery.js';
import { createMigrationServiceStatus } from './local-migration-cli.js';
import { createPythonOperationReceiptStore } from './python-operation-receipt.js';
import { createServerRegistry } from './server-registry.js';

async function runRunningPythonRecoveryFromStores(receiptReader, defaultCommand, {
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
  receiptStoreFactory = createPythonOperationReceiptStore,
  statusInspectorFactory = createPythonSiteManager,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = defaultCommand,
} = {}) {
  for (const dependency of [serverRegistryFactory, applicationRegistryFactory, jobRegistryFactory, durableRegistryFactory,
    recoveryStoreFactory, contextReaderFactory, receiptStoreFactory, statusInspectorFactory, serviceStatus, recoverCommand]) {
    if (typeof dependency !== 'function') {
      throw new JobRecoveryRuntimeError('job_recovery_runtime_dependencies_invalid', 'Python recovery runtime dependencies are invalid');
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
    throw new JobRecoveryRuntimeError('job_recovery_python_receipt_invalid', 'Python recovery receipt store is invalid');
  }
  const statusInspector = statusInspectorFactory();
  if (!statusInspector || typeof statusInspector.inspect !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_python_status_invalid', 'Python recovery status inspector is invalid');
  }

  const result = await recoverCommand({
    serverId,
    jobId,
    jobRegistry,
    applicationRegistry,
    serviceStatus,
    loadJobContext: (id) => contextReader.read(id),
    [receiptReader]: (receiptServerId, receiptJobId) => receiptStore.read(receiptServerId, receiptJobId),
    inspectPythonStatus: (intent) => statusInspector.inspect(intent),
  });
  return Object.freeze({ ...result, statePaths: paths });
}

export function runRunningPythonDeploymentRecoveryFromStores(input) {
  return runRunningPythonRecoveryFromStores('readDeploymentReceipt', recoverRunningPythonDeployment, input);
}

export function runRunningPythonRollbackRecoveryFromStores(input) {
  return runRunningPythonRecoveryFromStores('readRollbackReceipt', recoverRunningPythonRollback, input);
}

export function runRunningPythonRestartRecoveryFromStores(input) {
  return runRunningPythonRecoveryFromStores('readRestartReceipt', recoverRunningPythonRestart, input);
}
