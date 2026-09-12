import os from 'node:os';
import path from 'node:path';
import {
  createMailDiagnosticsInspector,
  createMailDkimEvidenceInspector,
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
import { recoverRunningMailDkim } from './job-running-mail-dkim-recovery.js';
import { createMailDkimConfigurationService } from './mail-dkim-configuration.js';
import { createMailDkimOperationReceiptStore } from './mail-dkim-operation-receipt.js';
import { createMailDkimRegistry } from './mail-dkim-registry.js';
import { createMailDomainRegistry } from './mail-domain-registry.js';
import { createMigrationServiceStatus } from './local-migration-cli.js';
import { createServerRegistry } from './server-registry.js';

function resolveMailDkimRecoveryPaths({ env, packaged, cwd }) {
  const base = resolveJobRecoveryPaths({ env, packaged, cwd });
  const defaultRoot = packaged
    ? jobRecoveryRuntimeInternals.packagedStateRoot
    : path.resolve(cwd, '.data');
  const mailDomainStore = jobRecoveryRuntimeInternals.resolveRecoveryStorePath(
    env.YUNPANEL_MAIL_DOMAIN_STORE,
    path.join(defaultRoot, 'mail-domain-registry.json'),
    { packaged, cwd, label: 'mail domain' },
  );
  const mailDkimKeyRoot = jobRecoveryRuntimeInternals.resolveRecoveryStorePath(
    env.YUNPANEL_MAIL_DKIM_KEY_ROOT,
    path.join(defaultRoot, 'mail-dkim'),
    { packaged, cwd, label: 'mail dkim key root' },
  );
  return Object.freeze({ ...base, mailDomainStore, mailDkimKeyRoot });
}

export async function runRunningMailDkimRecoveryFromStores({
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
  mailDkimRegistryFactory = createMailDkimRegistry,
  jobRegistryFactory = createJobRegistry,
  durableRegistryFactory = createDurableJobRegistry,
  recoveryStoreFactory = createJobRecoveryStore,
  contextReaderFactory = createJobRecoveryContextReader,
  receiptStoreFactory = createMailDkimOperationReceiptStore,
  diagnosticsInspectorFactory = createMailDiagnosticsInspector,
  evidenceInspectorFactory = createMailDkimEvidenceInspector,
  configurationServiceFactory = createMailDkimConfigurationService,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = recoverRunningMailDkim,
} = {}) {
  for (const dependency of [
    serverRegistryFactory,
    domainRegistryFactory,
    certificateRegistryFactory,
    applicationRegistryFactory,
    mailDomainRegistryFactory,
    mailDkimRegistryFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    contextReaderFactory,
    receiptStoreFactory,
    diagnosticsInspectorFactory,
    evidenceInspectorFactory,
    configurationServiceFactory,
    serviceStatus,
    recoverCommand,
  ]) {
    if (typeof dependency !== 'function') {
      throw new JobRecoveryRuntimeError(
        'job_recovery_runtime_dependencies_invalid',
        'DKIM recovery runtime dependencies are invalid',
      );
    }
  }

  const paths = resolveMailDkimRecoveryPaths({ env, packaged, cwd });
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
  const mailDkimRegistry = await jobRecoveryRuntimeInternals.initRegistry(mailDkimRegistryFactory({
    keyRoot: paths.mailDkimKeyRoot,
    getMailDomain: async (mailDomainId) => mailDomainRegistry.getMailDomain(mailDomainId),
  }), 'Mail DKIM');
  const diagnosticsInspector = diagnosticsInspectorFactory();
  if (!diagnosticsInspector || typeof diagnosticsInspector.inspect !== 'function') {
    throw new JobRecoveryRuntimeError(
      'job_recovery_mail_dkim_diagnostics_invalid',
      'DKIM recovery DNS diagnostics provider is invalid',
    );
  }
  const configurationService = configurationServiceFactory({
    mailDomainRegistry,
    mailDkimRegistry,
    mailDiagnosticsInspector: diagnosticsInspector,
  });
  if (!configurationService || typeof configurationService.materializeApply !== 'function') {
    throw new JobRecoveryRuntimeError(
      'job_recovery_mail_dkim_configuration_invalid',
      'DKIM recovery configuration provider is invalid',
    );
  }
  const receiptStore = receiptStoreFactory();
  if (!receiptStore || typeof receiptStore.read !== 'function') {
    throw new JobRecoveryRuntimeError(
      'job_recovery_mail_dkim_receipt_invalid',
      'DKIM recovery receipt store is invalid',
    );
  }
  const evidenceInspector = evidenceInspectorFactory();
  if (!evidenceInspector || typeof evidenceInspector.inspect !== 'function') {
    throw new JobRecoveryRuntimeError(
      'job_recovery_mail_dkim_evidence_invalid',
      'DKIM recovery host evidence provider is invalid',
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
    materializeApply: (input, expected) => configurationService.materializeApply(input, expected),
    readOperationReceipt: (receiptServerId, receiptJobId) => receiptStore.read(receiptServerId, receiptJobId),
    inspectActiveEvidence: (bundle) => evidenceInspector.inspect(bundle),
  });
  return Object.freeze({ ...result, statePaths: paths });
}

export const jobRunningMailDkimRecoveryRuntimeInternals = Object.freeze({
  resolveMailDkimRecoveryPaths,
});
