import os from 'node:os';
import path from 'node:path';
import { createMailConfigEvidenceInspector } from '@yunpanel/host-runtime';
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
import { recoverRunningMailConfig } from './job-running-mail-config-recovery.js';
import { createMailAliasRegistry } from './mail-alias-registry.js';
import { createMailConfigurationService } from './mail-configuration.js';
import { createMailConfigOperationReceiptStore } from './mail-config-operation-receipt.js';
import { createMailDomainRegistry } from './mail-domain-registry.js';
import { createMailServiceIdentityRegistry } from './mail-service-identity-registry.js';
import { createMailSrsConfigurationService } from './mail-srs-configuration.js';
import { createMailSrsSecretRegistry } from './mail-srs-secret-registry.js';
import { createMailboxForwardingRegistry } from './mailbox-forwarding-registry.js';
import { createMailboxQuotaRegistry } from './mailbox-quota-registry.js';
import { createMailboxRegistry } from './mailbox-registry.js';
import { createMigrationServiceStatus } from './local-migration-cli.js';
import { createServerRegistry } from './server-registry.js';

function resolveMailRecoveryPaths({ env, packaged, cwd }) {
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
  const mailboxQuotaStore = jobRecoveryRuntimeInternals.resolveRecoveryStorePath(
    env.YUNPANEL_MAILBOX_QUOTA_STORE,
    path.join(defaultRoot, 'mailbox-quota-registry.json'),
    { packaged, cwd, label: 'mailbox quota' },
  );
  const mailboxForwardingStore = jobRecoveryRuntimeInternals.resolveRecoveryStorePath(
    env.YUNPANEL_MAILBOX_FORWARDING_STORE,
    path.join(defaultRoot, 'mailbox-forwarding-registry.json'),
    { packaged, cwd, label: 'mailbox forwarding' },
  );
  const mailAliasStore = jobRecoveryRuntimeInternals.resolveRecoveryStorePath(
    env.YUNPANEL_MAIL_ALIAS_STORE,
    path.join(defaultRoot, 'mail-alias-registry.json'),
    { packaged, cwd, label: 'mail alias' },
  );
  const mailServiceIdentityStore = jobRecoveryRuntimeInternals.resolveRecoveryStorePath(
    env.YUNPANEL_MAIL_SERVICE_IDENTITY_STORE,
    path.join(defaultRoot, 'mail-service-identity-registry.json'),
    { packaged, cwd, label: 'mail service identity' },
  );
  const mailSrsSecretStore = jobRecoveryRuntimeInternals.resolveRecoveryStorePath(
    env.YUNPANEL_MAIL_SRS_SECRET_STORE,
    path.join(defaultRoot, 'mail-srs-secret-registry.json'),
    { packaged, cwd, label: 'mail SRS secret' },
  );
  return Object.freeze({
    ...base,
    mailDomainStore,
    mailboxStore,
    mailboxQuotaStore,
    mailboxForwardingStore,
    mailAliasStore,
    mailServiceIdentityStore,
    mailSrsSecretStore,
  });
}

export async function runRunningMailConfigRecoveryFromStores({
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
  mailServiceIdentityRegistryFactory = createMailServiceIdentityRegistry,
  mailSrsSecretRegistryFactory = createMailSrsSecretRegistry,
  mailSrsConfigurationServiceFactory = createMailSrsConfigurationService,
  mailboxRegistryFactory = createMailboxRegistry,
  mailboxQuotaRegistryFactory = createMailboxQuotaRegistry,
  mailboxForwardingRegistryFactory = createMailboxForwardingRegistry,
  mailAliasRegistryFactory = createMailAliasRegistry,
  jobRegistryFactory = createJobRegistry,
  durableRegistryFactory = createDurableJobRegistry,
  recoveryStoreFactory = createJobRecoveryStore,
  contextReaderFactory = createJobRecoveryContextReader,
  receiptStoreFactory = createMailConfigOperationReceiptStore,
  evidenceInspectorFactory = createMailConfigEvidenceInspector,
  mailConfigurationServiceFactory = createMailConfigurationService,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = recoverRunningMailConfig,
} = {}) {
  for (const dependency of [
    serverRegistryFactory,
    domainRegistryFactory,
    certificateRegistryFactory,
    applicationRegistryFactory,
    mailDomainRegistryFactory,
    mailServiceIdentityRegistryFactory,
    mailSrsSecretRegistryFactory,
    mailSrsConfigurationServiceFactory,
    mailboxRegistryFactory,
    mailboxQuotaRegistryFactory,
    mailboxForwardingRegistryFactory,
    mailAliasRegistryFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    contextReaderFactory,
    receiptStoreFactory,
    evidenceInspectorFactory,
    mailConfigurationServiceFactory,
    serviceStatus,
    recoverCommand,
  ]) {
    if (typeof dependency !== 'function') {
      throw new JobRecoveryRuntimeError(
        'job_recovery_runtime_dependencies_invalid',
        'Managed mail recovery runtime dependencies are invalid',
      );
    }
  }

  const paths = resolveMailRecoveryPaths({ env, packaged, cwd });
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

  const mailServiceIdentityRegistry = await jobRecoveryRuntimeInternals.initRegistry(mailServiceIdentityRegistryFactory({
    filePath: paths.mailServiceIdentityStore,
    getWebDomain: async (domainId) => domainRegistry.getDomain(domainId),
    getCertificate: async (certificateId) => certificateRegistry.getCertificate(certificateId),
  }), 'Mail service identity');
  const mailSrsSecretRegistry = await jobRecoveryRuntimeInternals.initRegistry(mailSrsSecretRegistryFactory({
    filePath: paths.mailSrsSecretStore,
    masterKey: env.YUNPANEL_SECRET_MASTER_KEY ?? null,
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
  }), 'Mail SRS secret');
  const mailSrsConfigurationService = mailSrsConfigurationServiceFactory({
    mailServiceIdentityRegistry,
    mailSrsSecretRegistry,
  });
  if (!mailSrsConfigurationService
    || typeof mailSrsConfigurationService.previewForServer !== 'function'
    || typeof mailSrsConfigurationService.materializeForServer !== 'function') {
    throw new JobRecoveryRuntimeError(
      'job_recovery_mail_srs_configuration_invalid',
      'Managed mail recovery SRS configuration provider is invalid',
    );
  }
  const mailDomainRegistry = await jobRecoveryRuntimeInternals.initRegistry(mailDomainRegistryFactory({
    filePath: paths.mailDomainStore,
    getWebDomain: async (domainId) => domainRegistry.getDomain(domainId),
  }), 'Mail domain');
  const mailboxRegistry = await jobRecoveryRuntimeInternals.initRegistry(mailboxRegistryFactory({
    filePath: paths.mailboxStore,
    masterKey: env.YUNPANEL_SECRET_MASTER_KEY ?? null,
    getMailDomain: async (mailDomainId) => mailDomainRegistry.getMailDomain(mailDomainId),
  }), 'Mailbox');
  const mailboxQuotaRegistry = await jobRecoveryRuntimeInternals.initRegistry(mailboxQuotaRegistryFactory({
    filePath: paths.mailboxQuotaStore,
    getMailbox: (mailboxId) => mailboxRegistry.getMailbox(mailboxId),
  }), 'Mailbox quota');
  const mailboxForwardingRegistry = await jobRecoveryRuntimeInternals.initRegistry(mailboxForwardingRegistryFactory({
    filePath: paths.mailboxForwardingStore,
    getMailbox: (mailboxId) => mailboxRegistry.getMailbox(mailboxId),
  }), 'Mailbox forwarding');
  const mailAliasRegistry = await jobRecoveryRuntimeInternals.initRegistry(mailAliasRegistryFactory({
    filePath: paths.mailAliasStore,
    getMailDomain: async (mailDomainId) => mailDomainRegistry.getMailDomain(mailDomainId),
    listMailboxes: (filter) => mailboxRegistry.listMailboxes(filter),
  }), 'Mail alias');

  const configurationService = mailConfigurationServiceFactory({
    mailDomainRegistry,
    mailboxRegistry,
    mailboxQuotaRegistry,
    mailboxForwardingRegistry,
    mailAliasRegistry,
    domainRegistry,
    mailServiceIdentityRegistry,
    mailSrsConfigurationService,
  });
  if (!configurationService || typeof configurationService.materializeTransition !== 'function') {
    throw new JobRecoveryRuntimeError(
      'job_recovery_mail_configuration_invalid',
      'Managed mail recovery configuration provider is invalid',
    );
  }
  const receiptStore = receiptStoreFactory();
  if (!receiptStore || typeof receiptStore.read !== 'function') {
    throw new JobRecoveryRuntimeError(
      'job_recovery_mail_receipt_invalid',
      'Managed mail recovery receipt store is invalid',
    );
  }
  const evidenceInspector = evidenceInspectorFactory();
  if (!evidenceInspector || typeof evidenceInspector.inspect !== 'function') {
    throw new JobRecoveryRuntimeError(
      'job_recovery_mail_evidence_invalid',
      'Managed mail recovery host evidence provider is invalid',
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
    serviceStatus,
    loadJobContext: (id) => contextReader.read(id),
    materializeTransition: (input, expected) => configurationService.materializeTransition(input, expected),
    readOperationReceipt: (receiptServerId, receiptJobId) => receiptStore.read(receiptServerId, receiptJobId),
    inspectActiveEvidence: (preview) => evidenceInspector.inspect(preview),
  });
  return Object.freeze({ ...result, statePaths: paths });
}

export const jobRunningMailConfigRecoveryRuntimeInternals = Object.freeze({
  resolveMailRecoveryPaths,
});