import os from 'node:os';
import path from 'node:path';
import { createWebsiteCronManager } from '@yunpanel/host-runtime';
import { createApplicationRegistry } from '../applications/application-registry.js';
import { createDurableJobRegistry } from './durable-job-registry.js';
import { createJobRecoveryContextReader } from './job-recovery-context.js';
import {
  JobRecoveryRuntimeError,
  jobRecoveryRuntimeInternals,
  resolveJobRecoveryPaths,
} from './job-recovery-runtime.js';
import { createJobRecoveryStore } from './job-recovery-store.js';
import { createJobRegistry } from './job-registry.js';
import { recoverRunningCron } from './job-running-cron-recovery.js';
import { createMigrationServiceStatus } from '../migration/local-migration-cli.js';
import { createServerRegistry } from '../runtime/server-registry.js';
import { createWebsiteCronOperationReceiptStore } from '../websites/website-cron-operation-receipt.js';
import { createWebsiteCronRegistry } from '../websites/website-cron-registry.js';
import { createWebsiteRegistry } from '../websites/website-registry.js';

function resolveCronRecoveryPaths({ env, packaged, cwd }) {
  const base = resolveJobRecoveryPaths({ env, packaged, cwd });
  const defaultRoot = packaged
    ? jobRecoveryRuntimeInternals.packagedStateRoot
    : path.resolve(cwd, '.data');
  const websiteCronStore = jobRecoveryRuntimeInternals.resolveRecoveryStorePath(
    env.YUNPANEL_WEBSITE_CRON_STORE,
    path.join(defaultRoot, 'website-cron-registry.json'),
    { packaged, cwd, label: 'website cron' },
  );
  return Object.freeze({ ...base, websiteCronStore });
}

export async function runRunningCronRecoveryFromStores({
  serverId,
  jobId,
  hostname = os.hostname(),
  env = process.env,
  packaged = false,
  cwd = process.cwd(),
  serverRegistryFactory = createServerRegistry,
  applicationRegistryFactory = createApplicationRegistry,
  websiteRegistryFactory = createWebsiteRegistry,
  websiteCronRegistryFactory = createWebsiteCronRegistry,
  websiteCronManagerFactory = createWebsiteCronManager,
  jobRegistryFactory = createJobRegistry,
  durableRegistryFactory = createDurableJobRegistry,
  recoveryStoreFactory = createJobRecoveryStore,
  contextReaderFactory = createJobRecoveryContextReader,
  receiptStoreFactory = createWebsiteCronOperationReceiptStore,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = recoverRunningCron,
} = {}) {
  for (const dependency of [
    serverRegistryFactory,
    applicationRegistryFactory,
    websiteRegistryFactory,
    websiteCronRegistryFactory,
    websiteCronManagerFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    contextReaderFactory,
    receiptStoreFactory,
    serviceStatus,
    recoverCommand,
  ]) {
    if (typeof dependency !== 'function') {
      throw new JobRecoveryRuntimeError(
        'job_recovery_runtime_dependencies_invalid',
        'Cron recovery runtime dependencies are invalid',
      );
    }
  }

  const paths = resolveCronRecoveryPaths({ env, packaged, cwd });
  const { serverRegistry, jobRegistry, contextReader } = await jobRecoveryRuntimeInternals.initHostScopedRecovery({
    paths,
    serverId,
    hostname,
    serverRegistryFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    contextReaderFactory,
  });

  const serverExists = async (id) => Boolean(await serverRegistry.getServer(id));
  const applicationRegistry = await jobRecoveryRuntimeInternals.initRegistry(
    applicationRegistryFactory({ filePath: paths.applicationStore, serverExists }),
    'Application',
  );
  const websiteRegistry = await jobRecoveryRuntimeInternals.initRegistry(
    websiteRegistryFactory({
      filePath: paths.websiteStore,
      serverExists,
      getApplication: (id) => applicationRegistry.getApplication(id),
    }),
    'Website',
  );
  const websiteCronRegistry = await jobRecoveryRuntimeInternals.initRegistry(
    websiteCronRegistryFactory({
      filePath: paths.websiteCronStore,
      getWebsite: async (websiteId) => websiteRegistry.getWebsite(websiteId),
    }),
    'Website cron',
  );
  if (typeof websiteCronRegistry.getTask !== 'function') {
    throw new JobRecoveryRuntimeError(
      'job_recovery_cron_registry_invalid',
      'Cron recovery registry is invalid',
    );
  }

  const websiteCronManager = websiteCronManagerFactory();
  if (!websiteCronManager || typeof websiteCronManager.listManagedFiles !== 'function') {
    throw new JobRecoveryRuntimeError(
      'job_recovery_cron_manager_invalid',
      'Cron recovery host manager is invalid',
    );
  }

  const receiptStore = receiptStoreFactory();
  if (!receiptStore || typeof receiptStore.read !== 'function') {
    throw new JobRecoveryRuntimeError(
      'job_recovery_cron_receipt_invalid',
      'Cron recovery receipt store is invalid',
    );
  }

  const result = await recoverCommand({
    serverId,
    jobId,
    jobRegistry,
    websiteCronRegistry,
    websiteCronManager,
    readOperationReceipt: (receiptServerId, receiptJobId) => receiptStore.read(receiptServerId, receiptJobId),
    serviceStatus,
    loadJobContext: (id) => contextReader.read(id),
  });
  return Object.freeze({ ...result, statePaths: paths });
}

export const jobRunningCronRecoveryRuntimeInternals = Object.freeze({
  resolveCronRecoveryPaths,
});
