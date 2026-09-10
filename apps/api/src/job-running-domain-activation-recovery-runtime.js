import os from 'node:os';
import { createNginxManager } from '@yunpanel/host-runtime';
import { createApplicationRegistry } from './application-registry.js';
import { createCertificateRegistry } from './certificate-registry.js';
import { createDomainActivationReceiptStore } from './domain-activation-receipt.js';
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
import { recoverRunningDomainActivation } from './job-running-domain-activation-recovery.js';
import { createMigrationServiceStatus } from './local-migration-cli.js';
import { createServerRegistry } from './server-registry.js';

export async function runRunningDomainActivationRecoveryFromStores({
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
  jobRegistryFactory = createJobRegistry,
  durableRegistryFactory = createDurableJobRegistry,
  recoveryStoreFactory = createJobRecoveryStore,
  contextReaderFactory = createJobRecoveryContextReader,
  receiptStoreFactory = createDomainActivationReceiptStore,
  nginxManagerFactory = createNginxManager,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = recoverRunningDomainActivation,
} = {}) {
  for (const dependency of [
    serverRegistryFactory,
    domainRegistryFactory,
    certificateRegistryFactory,
    applicationRegistryFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    contextReaderFactory,
    receiptStoreFactory,
    nginxManagerFactory,
    serviceStatus,
    recoverCommand,
  ]) {
    if (typeof dependency !== 'function') {
      throw new JobRecoveryRuntimeError('job_recovery_runtime_dependencies_invalid', 'Domain activation recovery runtime dependencies are invalid');
    }
  }

  const paths = resolveJobRecoveryPaths({ env, packaged, cwd });
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
  const receiptStore = receiptStoreFactory();
  if (!receiptStore || typeof receiptStore.read !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_domain_activation_receipt_invalid', 'Domain activation recovery receipt store is invalid');
  }
  const nginxManager = nginxManagerFactory();
  if (!nginxManager || typeof nginxManager.inspectActiveDomain !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_domain_activation_evidence_invalid', 'Domain activation recovery Nginx evidence provider is invalid');
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
    readActivationReceipt: (receiptServerId, receiptJobId) => receiptStore.read(receiptServerId, receiptJobId),
    inspectActiveEvidence: (intent) => nginxManager.inspectActiveDomain(intent),
  });
  return Object.freeze({ ...result, statePaths: paths });
}
