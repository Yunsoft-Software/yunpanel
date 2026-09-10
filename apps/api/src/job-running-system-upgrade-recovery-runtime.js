import os from 'node:os';
import { createSystemPackageManager } from '@yunpanel/host-runtime';
import { createDurableJobRegistry } from './durable-job-registry.js';
import { createJobRecoveryContextReader } from './job-recovery-context.js';
import { JobRecoveryRuntimeError, jobRecoveryRuntimeInternals, resolveJobRecoveryPaths } from './job-recovery-runtime.js';
import { createJobRecoveryStore } from './job-recovery-store.js';
import { createJobRegistry } from './job-registry.js';
import { recoverRunningSystemUpgrade } from './job-running-system-upgrade-recovery.js';
import { createMigrationServiceStatus } from './local-migration-cli.js';
import { createServerRegistry } from './server-registry.js';
import { createSystemUpgradeReceiptStore } from './system-upgrade-receipt.js';

export async function runRunningSystemUpgradeRecoveryFromStores({
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
  receiptStoreFactory = createSystemUpgradeReceiptStore,
  packageManagerFactory = createSystemPackageManager,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = recoverRunningSystemUpgrade,
} = {}) {
  for (const dependency of [serverRegistryFactory, jobRegistryFactory, durableRegistryFactory, recoveryStoreFactory,
    contextReaderFactory, receiptStoreFactory, packageManagerFactory, serviceStatus, recoverCommand]) {
    if (typeof dependency !== 'function') {
      throw new JobRecoveryRuntimeError('job_recovery_runtime_dependencies_invalid', 'System upgrade recovery runtime dependencies are invalid');
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
    throw new JobRecoveryRuntimeError('job_recovery_system_upgrade_receipt_invalid', 'System upgrade recovery receipt store is invalid');
  }
  const packageManager = packageManagerFactory();
  if (!packageManager || typeof packageManager.inspect !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_system_upgrade_evidence_invalid', 'System upgrade recovery package inspector is invalid');
  }

  const result = await recoverCommand({
    serverId,
    jobId,
    jobRegistry,
    serviceStatus,
    loadJobContext: (id) => contextReader.read(id),
    readUpgradeReceipt: (receiptServerId, receiptJobId) => receiptStore.read(receiptServerId, receiptJobId),
    inspectPackageState: () => packageManager.inspect(),
  });
  return Object.freeze({ ...result, statePaths: paths });
}
