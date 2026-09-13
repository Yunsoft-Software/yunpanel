import os from 'node:os';
import path from 'node:path';
import { createDatabaseCredentialEvidenceInspector } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApplicationRegistry } from './application-registry.js';
import { createDatabaseBindingRegistry } from './database-binding-registry.js';
import { createDatabaseCredentialMaterializer } from './database-credential-materializer.js';
import { createDatabaseCredentialOperationReceiptStore } from './database-credential-operation-receipt.js';
import { createDatabaseCredentialRegistry } from './database-credential-registry.js';
import { createDockerWorkloadRegistry } from './docker-workload-registry.js';
import { createDurableJobRegistry } from './durable-job-registry.js';
import { createJobRecoveryContextReader } from './job-recovery-context.js';
import {
  JobRecoveryRuntimeError,
  jobRecoveryRuntimeInternals,
  resolveJobRecoveryPaths,
} from './job-recovery-runtime.js';
import { createJobRecoveryStore } from './job-recovery-store.js';
import { createJobRegistry } from './job-registry.js';
import { recoverRunningDatabaseCredential } from './job-running-database-credential-recovery.js';
import { createMigrationServiceStatus } from './local-migration-cli.js';
import { createServerRegistry } from './server-registry.js';
import { createWebsiteRegistry } from './website-registry.js';

function resolveDatabaseCredentialRecoveryPaths({ env, packaged, cwd }) {
  const base = resolveJobRecoveryPaths({ env, packaged, cwd });
  const defaultRoot = packaged
    ? jobRecoveryRuntimeInternals.packagedStateRoot
    : path.resolve(cwd, '.data');
  const websiteStore = jobRecoveryRuntimeInternals.resolveRecoveryStorePath(
    env.YUNPANEL_WEBSITE_STORE,
    path.join(defaultRoot, 'website-registry.json'),
    { packaged, cwd, label: 'website' },
  );
  const dockerWorkloadStore = jobRecoveryRuntimeInternals.resolveRecoveryStorePath(
    env.YUNPANEL_DOCKER_WORKLOAD_STORE,
    path.join(defaultRoot, 'docker-workload-registry.json'),
    { packaged, cwd, label: 'Docker workload' },
  );
  const databaseBindingStore = jobRecoveryRuntimeInternals.resolveRecoveryStorePath(
    env.YUNPANEL_DATABASE_BINDING_STORE,
    path.join(defaultRoot, 'database-binding-registry.json'),
    { packaged, cwd, label: 'database binding' },
  );
  const databaseCredentialStore = jobRecoveryRuntimeInternals.resolveRecoveryStorePath(
    env.YUNPANEL_DATABASE_CREDENTIAL_STORE,
    path.join(defaultRoot, 'database-credential-registry.json'),
    { packaged, cwd, label: 'database credential' },
  );
  return Object.freeze({
    ...base,
    websiteStore,
    dockerWorkloadStore,
    databaseBindingStore,
    databaseCredentialStore,
  });
}

export async function runRunningDatabaseCredentialRecoveryFromStores({
  serverId,
  jobId,
  hostname = os.hostname(),
  env = process.env,
  packaged = false,
  cwd = process.cwd(),
  serverRegistryFactory = createServerRegistry,
  applicationRegistryFactory = createApplicationRegistry,
  websiteRegistryFactory = createWebsiteRegistry,
  dockerWorkloadRegistryFactory = createDockerWorkloadRegistry,
  databaseBindingRegistryFactory = createDatabaseBindingRegistry,
  databaseCredentialRegistryFactory = createDatabaseCredentialRegistry,
  materializerFactory = createDatabaseCredentialMaterializer,
  jobRegistryFactory = createJobRegistry,
  durableRegistryFactory = createDurableJobRegistry,
  recoveryStoreFactory = createJobRecoveryStore,
  contextReaderFactory = createJobRecoveryContextReader,
  receiptStoreFactory = createDatabaseCredentialOperationReceiptStore,
  evidenceInspectorFactory = createDatabaseCredentialEvidenceInspector,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = recoverRunningDatabaseCredential,
} = {}) {
  for (const dependency of [
    serverRegistryFactory,
    applicationRegistryFactory,
    websiteRegistryFactory,
    dockerWorkloadRegistryFactory,
    databaseBindingRegistryFactory,
    databaseCredentialRegistryFactory,
    materializerFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    contextReaderFactory,
    receiptStoreFactory,
    evidenceInspectorFactory,
    serviceStatus,
    recoverCommand,
  ]) {
    if (typeof dependency !== 'function') {
      throw new JobRecoveryRuntimeError(
        'job_recovery_runtime_dependencies_invalid',
        'Database credential recovery runtime dependencies are invalid',
      );
    }
  }

  const paths = resolveDatabaseCredentialRecoveryPaths({ env, packaged, cwd });
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
  const applicationRegistry = await jobRecoveryRuntimeInternals.initRegistry(applicationRegistryFactory({
    filePath: paths.applicationStore,
    serverExists,
  }), 'Application');
  const dockerWorkloadRegistry = await jobRecoveryRuntimeInternals.initRegistry(dockerWorkloadRegistryFactory({
    filePath: paths.dockerWorkloadStore,
    serverExists,
  }), 'Docker workload');
  const websiteRegistry = await jobRecoveryRuntimeInternals.initRegistry(websiteRegistryFactory({
    filePath: paths.websiteStore,
    serverExists,
    getApplication: async (id) => applicationRegistry.getApplication(id),
    getDockerWorkload: async (id) => dockerWorkloadRegistry.getWorkload(id),
  }), 'Website');
  const databaseBindingRegistry = await jobRecoveryRuntimeInternals.initRegistry(databaseBindingRegistryFactory({
    filePath: paths.databaseBindingStore,
    serverExists,
    getWebsite: async (id) => websiteRegistry.getWebsite(id),
    getApplication: async (id) => applicationRegistry.getApplication(id),
  }), 'Database binding');
  const databaseCredentialRegistry = await jobRecoveryRuntimeInternals.initRegistry(databaseCredentialRegistryFactory({
    filePath: paths.databaseCredentialStore,
    masterKey: env.YUNPANEL_SECRET_MASTER_KEY,
    getBinding: async (id) => databaseBindingRegistry.getBinding(id),
  }), 'Database credential');

  const materializer = materializerFactory({ databaseBindingRegistry, databaseCredentialRegistry });
  if (!materializer || typeof materializer.materializePublic !== 'function') {
    throw new JobRecoveryRuntimeError(
      'job_recovery_database_credential_materializer_invalid',
      'Database credential recovery desired-state provider is invalid',
    );
  }
  const receiptStore = receiptStoreFactory();
  if (!receiptStore || typeof receiptStore.read !== 'function') {
    throw new JobRecoveryRuntimeError(
      'job_recovery_database_credential_receipt_invalid',
      'Database credential recovery receipt store is invalid',
    );
  }
  const evidenceInspector = evidenceInspectorFactory();
  if (!evidenceInspector || typeof evidenceInspector.inspectApplied !== 'function'
    || typeof evidenceInspector.inspectDeleted !== 'function') {
    throw new JobRecoveryRuntimeError(
      'job_recovery_database_credential_evidence_invalid',
      'Database credential recovery evidence provider is invalid',
    );
  }

  const result = await recoverCommand({
    serverId,
    jobId,
    jobRegistry,
    serviceStatus,
    loadJobContext: (id) => contextReader.read(id),
    readReceipt: (receiptServerId, receiptJobId) => receiptStore.read(receiptServerId, receiptJobId),
    materializeDesiredState: (payload, operation) => materializer.materializePublic(payload, operation),
    inspectLiveState: (operation, bundle) => operation === OPERATIONS.DATABASE_CREDENTIAL_APPLY
      ? evidenceInspector.inspectApplied(bundle)
      : evidenceInspector.inspectDeleted(bundle),
  });
  return Object.freeze({ ...result, statePaths: paths });
}

export const jobRunningDatabaseCredentialRecoveryRuntimeInternals = Object.freeze({
  resolveDatabaseCredentialRecoveryPaths,
});
