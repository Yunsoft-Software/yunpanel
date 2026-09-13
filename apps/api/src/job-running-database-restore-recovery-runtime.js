import os from 'node:os';
import {
  createDatabaseDumpManager,
  createDatabaseRestoreEvidenceInspector,
  createDatabaseRestoreReceiptStore,
} from '@yunpanel/host-runtime';
import { createDurableJobRegistry } from './durable-job-registry.js';
import { createJobRecoveryContextReader } from './job-recovery-context.js';
import {
  JobRecoveryRuntimeError,
  jobRecoveryRuntimeInternals,
  resolveJobRecoveryPaths,
} from './job-recovery-runtime.js';
import { createJobRecoveryStore } from './job-recovery-store.js';
import { createJobRegistry } from './job-registry.js';
import { recoverRunningDatabaseRestore } from './job-running-database-restore-recovery.js';
import { createMigrationServiceStatus } from './local-migration-cli.js';
import { createServerRegistry } from './server-registry.js';

export async function runRunningDatabaseRestoreRecoveryFromStores({
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
  databaseDumpManagerFactory = createDatabaseDumpManager,
  restoreReceiptStoreFactory = createDatabaseRestoreReceiptStore,
  restoreEvidenceInspectorFactory = createDatabaseRestoreEvidenceInspector,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = recoverRunningDatabaseRestore,
} = {}) {
  for (const dependency of [
    serverRegistryFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    contextReaderFactory,
    databaseDumpManagerFactory,
    restoreReceiptStoreFactory,
    restoreEvidenceInspectorFactory,
    serviceStatus,
    recoverCommand,
  ]) {
    if (typeof dependency !== 'function') {
      throw new JobRecoveryRuntimeError(
        'job_recovery_runtime_dependencies_invalid',
        'Database restore recovery runtime dependencies are invalid',
      );
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

  const databaseDumpManager = databaseDumpManagerFactory();
  const restoreReceiptStore = restoreReceiptStoreFactory();
  const restoreEvidenceInspector = restoreEvidenceInspectorFactory();
  if (!databaseDumpManager || typeof databaseDumpManager.inspectBackup !== 'function'
    || !restoreReceiptStore || typeof restoreReceiptStore.read !== 'function'
    || !restoreEvidenceInspector || typeof restoreEvidenceInspector.inspectLive !== 'function') {
    throw new JobRecoveryRuntimeError(
      'job_recovery_database_restore_evidence_invalid',
      'Database restore recovery evidence providers are invalid',
    );
  }

  const result = await recoverCommand({
    serverId,
    jobId,
    jobRegistry,
    serviceStatus,
    loadJobContext: (id) => contextReader.read(id),
    readRestoreReceipt: (id) => restoreReceiptStore.read(id),
    inspectBackup: (id) => databaseDumpManager.inspectBackup(id),
    inspectLive: (input) => restoreEvidenceInspector.inspectLive(input),
  });
  return Object.freeze({ ...result, statePaths: paths });
}
