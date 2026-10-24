import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createPhpFpmSiteManager } from '@yunpanel/host-runtime';
import { createDurableJobRegistry } from './durable-job-registry.js';
import { createJobRecoveryContextReader } from './job-recovery-context.js';
import {
  JobRecoveryRuntimeError,
  jobRecoveryRuntimeInternals,
  resolveJobRecoveryPaths,
} from './job-recovery-runtime.js';
import { createJobRecoveryStore } from './job-recovery-store.js';
import { createJobRegistry } from './job-registry.js';
import { recoverRunningPhpTool } from './job-running-php-tool-recovery.js';
import { createMigrationServiceStatus } from './local-migration-cli.js';
import { createServerRegistry } from './server-registry.js';
import { createWebsitePhpToolOperationReceiptStore } from './website-php-tool-operation-receipt.js';

export async function runRunningPhpToolRecoveryFromStores({
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
  receiptStoreFactory = createWebsitePhpToolOperationReceiptStore,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = recoverRunningPhpTool,
} = {}) {
  for (const dependency of [
    serverRegistryFactory,
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
        'PHP tool recovery runtime dependencies are invalid',
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

  const receiptStore = receiptStoreFactory();
  if (!receiptStore || typeof receiptStore.read !== 'function') {
    throw new JobRecoveryRuntimeError(
      'job_recovery_php_tool_receipt_invalid',
      'PHP tool recovery receipt store is invalid',
    );
  }

  const result = await recoverCommand({
    serverId,
    jobId,
    jobRegistry,
    serviceStatus,
    loadJobContext: (id) => contextReader.read(id),
    readOperationReceipt: (receiptServerId, receiptJobId) => receiptStore.read(receiptServerId, receiptJobId),
    inspectConfiguration: async (payload) => {
      try {
        const filePath = env.YUNPANEL_WEBSITE_STORE ?? path.join(path.dirname(paths.applicationStore), 'website-registry.json');
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        const matches = parsed.websites?.filter((website) => website.id === payload.websiteId) ?? [];
        if (parsed.version !== 6 || matches.length !== 1) return false;
        const website = matches[0];
        if (website.runtimeType !== 'php' || website.serverId !== serverId || website.applicationId !== payload.applicationId
          || website.unixUser !== payload.unixUser || website.revision !== payload.expectedWebsiteRevision + 1
          || Object.keys(payload.config).some((key) => website.phpConfig?.[key] !== payload.config[key])) return false;
        const result = await createPhpFpmSiteManager().inspect({ websiteId: website.id, applicationId: website.applicationId,
          unixUser: website.unixUser, documentRoot: website.documentRoot, ...payload.config });
        return result.satisfied === true;
      } catch { return false; }
    },
  });
  return Object.freeze({ ...result, statePaths: paths });
}
