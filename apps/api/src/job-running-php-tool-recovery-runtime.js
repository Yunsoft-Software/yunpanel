import os from 'node:os';
import path from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
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
import { JobRunningPhpToolRecoveryError, recoverRunningPhpTool } from './job-running-php-tool-recovery.js';
import { createMigrationServiceStatus } from './local-migration-cli.js';
import { createServerRegistry } from './server-registry.js';
import { createSiteMutationLock } from './site-mutation-lock.js';
import { createWebsitePhpToolOperationReceiptStore } from './website-php-tool-operation-receipt.js';
import { createWordPressSelectiveTransferJournal } from './wordpress-selective-transfer-journal.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function matchesWordPressTarget(paths, serverId, payload, target) {
  try {
    const [websites, domains] = await Promise.all([paths.websiteStore, paths.domainStore]
      .map(async (filename) => JSON.parse(await readFile(filename, 'utf8'))));
    if (websites.version !== 6 || domains.version !== 4) return false;
    const sourceMatches = websites.websites.filter((website) => website.id === payload.websiteId);
    const targetMatches = websites.websites.filter((website) => website.id === payload.options.targetWebsiteId);
    if (sourceMatches.length !== 1 || targetMatches.length !== 1) return false;
    const [sourceSite] = sourceMatches;
    const [targetSite] = targetMatches;
    if (sourceSite.serverId !== serverId || targetSite.serverId !== serverId
      || sourceSite.runtimeType !== 'php' || targetSite.runtimeType !== 'php'
      || sourceSite.applicationId !== payload.applicationId || targetSite.applicationId !== payload.targetApplicationId
      || sourceSite.revision !== payload.expectedWebsiteRevision || targetSite.revision !== payload.targetWebsiteRevision
      || sourceSite.unixUser !== payload.unixUser || !/^yunapp-[a-f0-9]{12}$/.test(targetSite.unixUser)
      || targetSite.unixUser === sourceSite.unixUser || !path.isAbsolute(targetSite.documentRoot)) return false;

    const bound = domains.domains.filter((domain) => domain.websiteId === targetSite.id && domain.serverId === serverId);
    const preferred = bound.filter((domain) => domain.primaryDomain === targetSite.name);
    const domain = preferred.length === 1 ? preferred[0] : bound.length === 1 ? bound[0] : null;
    if (!domain || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(domain.primaryDomain ?? '')) return false;
    const childRoot = domain.nginxSettings?.documentRoot ?? null;
    if (childRoot && !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(childRoot)) return false;
    const documentRoot = await realpath(targetSite.documentRoot);
    const expectedPath = childRoot ? path.join(documentRoot, childRoot) : documentRoot;
    if (await realpath(expectedPath) !== expectedPath) return false;
    const pinned = await lstat(expectedPath, { bigint: true });
    return pinned.isDirectory() && (!target || (target.releaseRoot === expectedPath
      && String(pinned.dev) === target.expectedRoot.device && String(pinned.ino) === target.expectedRoot.inode));
  } catch { return false; }
}

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
  journalFactory = createWordPressSelectiveTransferJournal,
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
    journalFactory,
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
    rollbackInterruptedSelectiveTransfer: async ({ payload }) => {
      const applications = [payload.applicationId, payload.targetApplicationId];
      if (applications.some((id) => !UUID.test(id ?? '')) || applications[0] === applications[1]) {
        throw new JobRunningPhpToolRecoveryError('job_wordpress_selective_recovery_identity_invalid', 'WordPress recovery requires two distinct approved Applications');
      }
      const [first, second] = applications.map((id) => id.toLowerCase()).sort();
      const lock = createSiteMutationLock({ root: path.join(path.dirname(paths.serverStore), 'locks', 'site-mutations') });
      return lock.withApplicationLock(first, () => lock.withApplicationLock(second, async () => {
        const status = await serviceStatus();
        if (status?.apiActive !== false || status?.agentActive !== false) {
          throw new JobRunningPhpToolRecoveryError('job_php_tool_recovery_consumers_must_be_stopped', 'Stop YunPanel API and legacy agent before recovering PHP tool jobs');
        }
        return journalFactory().rollbackInterrupted({ serverId, jobId, payload,
          verifyTarget: (target) => matchesWordPressTarget(paths, serverId, payload, target) });
      }));
    },
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
