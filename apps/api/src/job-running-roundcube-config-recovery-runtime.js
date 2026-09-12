import os from 'node:os';
import path from 'node:path';
import { createRoundcubeConfigEvidenceInspector } from '@yunpanel/host-runtime';
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
import { recoverRunningRoundcubeConfig } from './job-running-roundcube-config-recovery.js';
import { createMailServiceIdentityRegistry } from './mail-service-identity-registry.js';
import { createMigrationServiceStatus } from './local-migration-cli.js';
import { createRoundcubeConfigOperationReceiptStore } from './roundcube-config-operation-receipt.js';
import { createRoundcubeConfigurationService } from './roundcube-configuration.js';
import { createRoundcubeSecretRegistry } from './roundcube-secret-registry.js';
import { createServerRegistry } from './server-registry.js';

function resolveRoundcubeRecoveryPaths({ env, packaged, cwd }) {
  const base = resolveJobRecoveryPaths({ env, packaged, cwd });
  const defaultRoot = packaged
    ? jobRecoveryRuntimeInternals.packagedStateRoot
    : path.resolve(cwd, '.data');
  const mailServiceIdentityStore = jobRecoveryRuntimeInternals.resolveRecoveryStorePath(
    env.YUNPANEL_MAIL_SERVICE_IDENTITY_STORE,
    path.join(defaultRoot, 'mail-service-identity-registry.json'),
    { packaged, cwd, label: 'mail service identity' },
  );
  const roundcubeSecretStore = jobRecoveryRuntimeInternals.resolveRecoveryStorePath(
    env.YUNPANEL_ROUNDCUBE_SECRET_STORE,
    path.join(defaultRoot, 'roundcube-secret-registry.json'),
    { packaged, cwd, label: 'Roundcube secret' },
  );
  return Object.freeze({
    ...base,
    mailServiceIdentityStore,
    roundcubeSecretStore,
  });
}

export async function runRunningRoundcubeConfigRecoveryFromStores({
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
  mailServiceIdentityRegistryFactory = createMailServiceIdentityRegistry,
  roundcubeSecretRegistryFactory = createRoundcubeSecretRegistry,
  jobRegistryFactory = createJobRegistry,
  durableRegistryFactory = createDurableJobRegistry,
  recoveryStoreFactory = createJobRecoveryStore,
  contextReaderFactory = createJobRecoveryContextReader,
  receiptStoreFactory = createRoundcubeConfigOperationReceiptStore,
  evidenceInspectorFactory = createRoundcubeConfigEvidenceInspector,
  roundcubeConfigurationServiceFactory = createRoundcubeConfigurationService,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = recoverRunningRoundcubeConfig,
} = {}) {
  for (const dependency of [
    serverRegistryFactory,
    domainRegistryFactory,
    certificateRegistryFactory,
    applicationRegistryFactory,
    mailServiceIdentityRegistryFactory,
    roundcubeSecretRegistryFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    contextReaderFactory,
    receiptStoreFactory,
    evidenceInspectorFactory,
    roundcubeConfigurationServiceFactory,
    serviceStatus,
    recoverCommand,
  ]) {
    if (typeof dependency !== 'function') {
      throw new JobRecoveryRuntimeError(
        'job_recovery_runtime_dependencies_invalid',
        'Roundcube recovery runtime dependencies are invalid',
      );
    }
  }

  const paths = resolveRoundcubeRecoveryPaths({ env, packaged, cwd });
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
  const roundcubeSecretRegistry = await jobRecoveryRuntimeInternals.initRegistry(roundcubeSecretRegistryFactory({
    filePath: paths.roundcubeSecretStore,
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
  }), 'Roundcube secret');

  const configurationService = roundcubeConfigurationServiceFactory({
    mailServiceIdentityRegistry,
    roundcubeSecretRegistry,
  });
  if (!configurationService || typeof configurationService.materializeForServer !== 'function') {
    throw new JobRecoveryRuntimeError(
      'job_recovery_roundcube_configuration_invalid',
      'Roundcube recovery configuration provider is invalid',
    );
  }
  const receiptStore = receiptStoreFactory();
  if (!receiptStore || typeof receiptStore.read !== 'function') {
    throw new JobRecoveryRuntimeError(
      'job_recovery_roundcube_receipt_invalid',
      'Roundcube recovery receipt store is invalid',
    );
  }
  const evidenceInspector = evidenceInspectorFactory();
  if (!evidenceInspector || typeof evidenceInspector.inspect !== 'function') {
    throw new JobRecoveryRuntimeError(
      'job_recovery_roundcube_evidence_invalid',
      'Roundcube recovery host evidence provider is invalid',
    );
  }

  const result = await recoverCommand({
    serverId,
    jobId,
    jobRegistry,
    domainRegistry,
    certificateRegistry,
    applicationRegistry,
    serviceStatus,
    loadJobContext: (id) => contextReader.read(id),
    materializeConfiguration: (id, expected) => configurationService.materializeForServer(id, expected),
    readOperationReceipt: (receiptServerId, receiptJobId) => receiptStore.read(receiptServerId, receiptJobId),
    inspectActiveEvidence: (preview) => evidenceInspector.inspect(preview),
  });
  return Object.freeze({ ...result, statePaths: paths });
}

export const jobRunningRoundcubeConfigRecoveryRuntimeInternals = Object.freeze({
  resolveRoundcubeRecoveryPaths,
});
