import os from 'node:os';
import { createAcmeManager } from '@yunpanel/host-runtime';
import { createCertificateOperationReceiptStore } from './certificate-operation-receipt.js';
import { createCertificateRegistry } from './certificate-registry.js';
import { createDomainRegistry } from './domain-registry.js';
import { createDurableJobRegistry } from './durable-job-registry.js';
import { createJobRecoveryContextReader } from './job-recovery-context.js';
import { JobRecoveryRuntimeError, jobRecoveryRuntimeInternals, resolveJobRecoveryPaths } from './job-recovery-runtime.js';
import { createJobRecoveryStore } from './job-recovery-store.js';
import { recoverRunningCertificateOperation } from './job-running-certificate-recovery.js';
import { createJobRegistry } from './job-registry.js';
import { createMigrationServiceStatus } from './local-migration-cli.js';
import { createServerRegistry } from './server-registry.js';

export async function runRunningCertificateRecoveryFromStores({
  serverId,
  jobId,
  hostname = os.hostname(),
  env = process.env,
  packaged = false,
  cwd = process.cwd(),
  serverRegistryFactory = createServerRegistry,
  domainRegistryFactory = createDomainRegistry,
  certificateRegistryFactory = createCertificateRegistry,
  jobRegistryFactory = createJobRegistry,
  durableRegistryFactory = createDurableJobRegistry,
  recoveryStoreFactory = createJobRecoveryStore,
  contextReaderFactory = createJobRecoveryContextReader,
  receiptStoreFactory = createCertificateOperationReceiptStore,
  acmeManagerFactory = createAcmeManager,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = recoverRunningCertificateOperation,
} = {}) {
  for (const dependency of [
    serverRegistryFactory,
    domainRegistryFactory,
    certificateRegistryFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    contextReaderFactory,
    receiptStoreFactory,
    acmeManagerFactory,
    serviceStatus,
    recoverCommand,
  ]) {
    if (typeof dependency !== 'function') {
      throw new JobRecoveryRuntimeError('job_recovery_runtime_dependencies_invalid', 'Certificate recovery runtime dependencies are invalid');
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

  const serverExists = async (id) => Boolean(await serverRegistry.getServer(id));
  const domainRegistry = await jobRecoveryRuntimeInternals.initRegistry(
    domainRegistryFactory({ filePath: paths.domainStore, serverExists }),
    'Domain',
  );
  const certificateRegistry = await jobRecoveryRuntimeInternals.initRegistry(
    certificateRegistryFactory({ filePath: paths.certificateStore }),
    'Certificate',
  );

  const receiptStore = receiptStoreFactory();
  if (!receiptStore || typeof receiptStore.read !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_certificate_receipt_invalid', 'Certificate recovery receipt store is invalid');
  }
  const acmeManager = acmeManagerFactory();
  if (!acmeManager || typeof acmeManager.inspectCertificate !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_certificate_evidence_invalid', 'Certificate recovery X.509 inspector is invalid');
  }

  const result = await recoverCommand({
    serverId,
    jobId,
    jobRegistry,
    domainRegistry,
    certificateRegistry,
    serviceStatus,
    loadJobContext: (id) => contextReader.read(id),
    readCertificateReceipt: (receiptServerId, receiptJobId) => receiptStore.read(receiptServerId, receiptJobId),
    inspectCertificate: (certName) => acmeManager.inspectCertificate(certName),
  });
  return Object.freeze({ ...result, statePaths: paths });
}
