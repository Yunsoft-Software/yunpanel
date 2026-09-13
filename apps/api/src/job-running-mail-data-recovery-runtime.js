import os from 'node:os';
import path from 'node:path';
import {
  createMailDataBackupManager,
  createMailDataDeleteManager,
  createMailDataRestoreManager,
} from '@yunpanel/host-runtime';
import { createApplicationRegistry } from './application-registry.js';
import { createCertificateRegistry } from './certificate-registry.js';
import { createDomainRegistry } from './domain-registry.js';
import { createDurableJobRegistry } from './durable-job-registry.js';
import { createJobRecoveryContextReader } from './job-recovery-context.js';
import {
  JobRecoveryRuntimeError,
  jobRecoveryRuntimeInternals,
  resolveJobRecoveryPaths,
} from './job-recovery-runtime.js';
import { createJobRecoveryStore } from './job-recovery-store.js';
import { createJobRegistry } from './job-registry.js';
import { recoverRunningMailData } from './job-running-mail-data-recovery.js';
import { createMailDataOperationReceiptStore } from './mail-data-operation-receipt.js';
import { createMailDomainRegistry } from './mail-domain-registry.js';
import { createMailboxRegistry } from './mailbox-registry.js';
import { createMigrationServiceStatus } from './local-migration-cli.js';
import { createServerRegistry } from './server-registry.js';

function resolveMailDataRecoveryPaths({ env, packaged, cwd }) {
  const base = resolveJobRecoveryPaths({ env, packaged, cwd });
  const defaultRoot = packaged
    ? jobRecoveryRuntimeInternals.packagedStateRoot
    : path.resolve(cwd, '.data');
  const mailDomainStore = jobRecoveryRuntimeInternals.resolveRecoveryStorePath(
    env.YUNPANEL_MAIL_DOMAIN_STORE,
    path.join(defaultRoot, 'mail-domain-registry.json'),
    { packaged, cwd, label: 'mail domain' },
  );
  const mailboxStore = jobRecoveryRuntimeInternals.resolveRecoveryStorePath(
    env.YUNPANEL_MAILBOX_STORE,
    path.join(defaultRoot, 'mailbox-registry.json'),
    { packaged, cwd, label: 'mailbox' },
  );
  return Object.freeze({ ...base, mailDomainStore, mailboxStore });
}

export async function runRunningMailDataRecoveryFromStores({
  serverId,
  jobId,
  hostname = os.hostname(),
  env = process.env,
  packaged = false,
  cwd = process.cwd(),
  serverRegistryFactory = createServerRegistry,
  domainRegistryFactory = createDomainRegistry,
  certificateRegistryFactory = createCertificateRegistry,
  applicationRegistryFactory = createApplicationRegistry,
  mailDomainRegistryFactory = createMailDomainRegistry,
  mailboxRegistryFactory = createMailboxRegistry,
  jobRegistryFactory = createJobRegistry,
  durableRegistryFactory = createDurableJobRegistry,
  recoveryStoreFactory = createJobRecoveryStore,
  contextReaderFactory = createJobRecoveryContextReader,
  receiptStoreFactory = createMailDataOperationReceiptStore,
  backupManagerFactory = createMailDataBackupManager,
  restoreManagerFactory = createMailDataRestoreManager,
  deleteManagerFactory = createMailDataDeleteManager,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = recoverRunningMailData,
} = {}) {
  for (const dependency of [
    serverRegistryFactory,
    domainRegistryFactory,
    certificateRegistryFactory,
    applicationRegistryFactory,
    mailDomainRegistryFactory,
    mailboxRegistryFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    contextReaderFactory,
    receiptStoreFactory,
    backupManagerFactory,
    restoreManagerFactory,
    deleteManagerFactory,
    serviceStatus,
    recoverCommand,
  ]) {
    if (typeof dependency !== 'function') {
      throw new JobRecoveryRuntimeError(
        'job_recovery_runtime_dependencies_invalid',
        'Mail data recovery runtime dependencies are invalid',
      );
    }
  }

  const paths = resolveMailDataRecoveryPaths({ env, packaged, cwd });
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
  const { domainRegistry, certificateRegistry, applicationRegistry } = await jobRecoveryRuntimeInternals.initResourceRegistries({
    paths,
    serverRegistry,
    domainRegistryFactory,
    certificateRegistryFactory,
    applicationRegistryFactory,
  });
  const mailDomainRegistry = await jobRecoveryRuntimeInternals.initRegistry(mailDomainRegistryFactory({
    filePath: paths.mailDomainStore,
    getWebDomain: async (domainId) => domainRegistry.getDomain(domainId),
  }), 'Mail domain');
  const mailboxRegistry = await jobRecoveryRuntimeInternals.initRegistry(mailboxRegistryFactory({
    filePath: paths.mailboxStore,
    masterKey: env.YUNPANEL_SECRET_MASTER_KEY ?? null,
    getMailDomain: async (mailDomainId) => mailDomainRegistry.getMailDomain(mailDomainId),
  }), 'Mailbox');

  const receiptStore = receiptStoreFactory();
  if (!receiptStore || typeof receiptStore.read !== 'function') {
    throw new JobRecoveryRuntimeError(
      'job_recovery_mail_data_receipt_invalid',
      'Mail data recovery receipt store is invalid',
    );
  }
  const backupManager = backupManagerFactory();
  if (!backupManager || typeof backupManager.inspectBackup !== 'function'
    || typeof backupManager.materializeBackup !== 'function') {
    throw new JobRecoveryRuntimeError(
      'job_recovery_mail_data_backup_invalid',
      'Mail data recovery backup manager is invalid',
    );
  }
  const restoreManager = restoreManagerFactory({ backupManager });
  if (!restoreManager || typeof restoreManager.inspectRestored !== 'function') {
    throw new JobRecoveryRuntimeError(
      'job_recovery_mail_data_restore_invalid',
      'Mail data recovery restore evidence provider is invalid',
    );
  }
  const deleteManager = deleteManagerFactory({ backupManager });
  if (!deleteManager || typeof deleteManager.inspectDeleted !== 'function') {
    throw new JobRecoveryRuntimeError(
      'job_recovery_mail_data_delete_invalid',
      'Mail data recovery delete evidence provider is invalid',
    );
  }

  const result = await recoverCommand({
    serverId,
    jobId,
    jobRegistry,
    domainRegistry,
    certificateRegistry,
    applicationRegistry,
    mailDomainRegistry,
    mailboxRegistry,
    serviceStatus,
    loadJobContext: (id) => contextReader.read(id),
    readOperationReceipt: (receiptServerId, receiptJobId) => receiptStore.read(receiptServerId, receiptJobId),
    inspectBackup: (backupId) => backupManager.inspectBackup(backupId),
    inspectRestored: (input) => restoreManager.inspectRestored(input),
    inspectDeleted: (input) => deleteManager.inspectDeleted(input),
  });
  return Object.freeze({ ...result, statePaths: paths });
}

export const jobRunningMailDataRecoveryRuntimeInternals = Object.freeze({
  resolveMailDataRecoveryPaths,
});