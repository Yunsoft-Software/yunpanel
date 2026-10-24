import os from 'node:os';
import { createAcmeManager, createNginxManager } from '@yunpanel/host-runtime';
import { reloadCertificateNginx } from './certificate-nginx-reload.js';
import { createMailServiceIdentityRegistry } from './mail-service-identity-registry.js';
import { createLocalHostOperations } from './local-host-operations.js';
import { reloadCertificateMail } from './certificate-mail-reload.js';
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
  nginxManagerFactory = createNginxManager,
  mailServiceIdentityRegistryFactory = createMailServiceIdentityRegistry,
  hostOperationsFactory = createLocalHostOperations,
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
    nginxManagerFactory,
    mailServiceIdentityRegistryFactory,
    hostOperationsFactory,
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
  const mailServiceIdentityRegistry = await jobRecoveryRuntimeInternals.initRegistry(mailServiceIdentityRegistryFactory({
    filePath: paths.mailServiceIdentityStore,
    getWebDomain: id => domainRegistry.getDomain(id), getCertificate: id => certificateRegistry.getCertificate(id),
  }), 'Mail service identity');
  const hostOperations = hostOperationsFactory();
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
    reloadCertificate: () => reloadCertificateNginx(nginxManagerFactory()),
    mailServiceIdentityRegistry,
    reloadMailCertificate: (result, identity) => reloadCertificateMail({
      mailServiceIdentityRegistry, certificateRegistry, domainRegistry, result,
      reload: value => hostOperations.reloadMailCertificate(value),
      serverId: identity.serverId, certificateId: identity.certificateId,
    }),
  });
  return Object.freeze({ ...result, statePaths: paths });
}
