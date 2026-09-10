import os from 'node:os';
import { createManagedServiceManager } from '@yunpanel/host-runtime';
import { createDurableJobRegistry } from './durable-job-registry.js';
import { createJobRecoveryContextReader } from './job-recovery-context.js';
import {
  JobRecoveryRuntimeError,
  jobRecoveryRuntimeInternals,
  resolveJobRecoveryPaths,
} from './job-recovery-runtime.js';
import { createJobRecoveryStore } from './job-recovery-store.js';
import { createJobRegistry } from './job-registry.js';
import { recoverRunningServiceReceiptMutation } from './job-running-service-receipt-recovery.js';
import { createMigrationServiceStatus } from './local-migration-cli.js';
import { createManagedServiceMutationReceiptStore } from './managed-service-mutation-receipt.js';
import { createServerRegistry } from './server-registry.js';

export async function runRunningServiceReceiptRecoveryFromStores({
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
  receiptStoreFactory = createManagedServiceMutationReceiptStore,
  managedServiceManagerFactory = createManagedServiceManager,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = recoverRunningServiceReceiptMutation,
} = {}) {
  for (const dependency of [
    serverRegistryFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    contextReaderFactory,
    receiptStoreFactory,
    managedServiceManagerFactory,
    serviceStatus,
    recoverCommand,
  ]) {
    if (typeof dependency !== 'function') {
      throw new JobRecoveryRuntimeError('job_recovery_runtime_dependencies_invalid', 'Managed service receipt recovery runtime dependencies are invalid');
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

  const receiptStore = receiptStoreFactory();
  if (!receiptStore || typeof receiptStore.read !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_service_receipt_invalid', 'Managed service recovery receipt store is invalid');
  }
  const manager = managedServiceManagerFactory();
  if (!manager || typeof manager.inspect !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_service_evidence_invalid', 'Managed service recovery evidence provider is invalid');
  }

  const result = await recoverCommand({
    serverId,
    jobId,
    jobRegistry,
    serviceStatus,
    loadJobContext: (id) => contextReader.read(id),
    readMutationReceipt: (receiptServerId, receiptJobId) => receiptStore.read(receiptServerId, receiptJobId),
    inspectServiceState: (serviceId) => manager.inspect(serviceId),
  });
  return Object.freeze({ ...result, statePaths: paths });
}
