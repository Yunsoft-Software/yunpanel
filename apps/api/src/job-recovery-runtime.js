import os from 'node:os';
import path from 'node:path';
import {
  createDatabaseManager,
  createNginxManager,
  createStaticDeploymentEvidenceInspector,
} from '@yunpanel/host-runtime';
import { createApplicationRegistry } from './application-registry.js';
import { createCertificateRegistry } from './certificate-registry.js';
import { createDatabaseDeletionReceiptStore } from './database-deletion-receipt.js';
import { createDomainRegistry } from './domain-registry.js';
import { createDurableJobRegistry } from './durable-job-registry.js';
import { createLocalHostOperations } from './local-host-operations.js';
import { createJobRecoveryContextReader } from './job-recovery-context.js';
import { createJobRecoveryStore } from './job-recovery-store.js';
import { reconcileTerminalRecovery } from './job-recovery-command.js';
import { recoverRunningDatabaseDelete } from './job-running-database-delete-recovery.js';
import { recoverRunningDatabaseCreate } from './job-running-database-recovery.js';
import { recoverRunningDomainStage } from './job-running-domain-recovery.js';
import { recoverRunningInspection } from './job-running-recovery.js';
import { recoverRunningStaticDeployment } from './job-running-static-recovery.js';
import { createJobRegistry } from './job-registry.js';
import {
  createMigrationServiceStatus,
  localMigrationCliInternals,
  resolveLocalMigrationPaths,
} from './local-migration-cli.js';
import { createServerRegistry } from './server-registry.js';

const PACKAGED_STATE_ROOT = localMigrationCliInternals.packagedStateRoot;

export class JobRecoveryRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRecoveryRuntimeError';
    this.code = code;
  }
}

function resolveRecoveryStorePath(value, fallback, { packaged, cwd, label }) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string' || /[\u0000\r\n]/.test(value)) {
    throw new JobRecoveryRuntimeError('invalid_job_recovery_state_path', `${label} recovery state path is invalid`);
  }
  if (packaged && !path.isAbsolute(value)) {
    throw new JobRecoveryRuntimeError('packaged_job_recovery_path_must_be_absolute', `Packaged ${label} recovery state path must be absolute`);
  }
  const resolved = path.resolve(cwd, value);
  if (packaged) {
    const allowedRoot = `${PACKAGED_STATE_ROOT}${path.sep}`;
    if (resolved !== PACKAGED_STATE_ROOT && !resolved.startsWith(allowedRoot)) {
      throw new JobRecoveryRuntimeError('packaged_job_recovery_path_outside_control_plane', `Packaged ${label} recovery state must stay under ${PACKAGED_STATE_ROOT}`);
    }
  }
  return resolved;
}

export function resolveJobRecoveryPaths({ env = process.env, packaged = false, cwd = process.cwd() } = {}) {
  const base = resolveLocalMigrationPaths({ env, packaged, cwd });
  const defaultRoot = packaged ? PACKAGED_STATE_ROOT : path.resolve(cwd, '.data');
  const domainStore = resolveRecoveryStorePath(
    env.YUNPANEL_DOMAIN_STORE,
    path.join(defaultRoot, 'domain-registry.json'),
    { packaged, cwd, label: 'domain' },
  );
  const certificateStore = resolveRecoveryStorePath(
    env.YUNPANEL_CERTIFICATE_STORE,
    path.join(defaultRoot, 'certificate-registry.json'),
    { packaged, cwd, label: 'certificate' },
  );
  const applicationStore = resolveRecoveryStorePath(
    env.YUNPANEL_APPLICATION_STORE,
    path.join(defaultRoot, 'application-registry.json'),
    { packaged, cwd, label: 'application' },
  );
  return Object.freeze({
    serverStore: base.serverStore,
    domainStore,
    jobStore: base.jobStore,
    recoveryStore: `${base.jobStore}.recovery.json`,
    certificateStore,
    applicationStore,
  });
}

async function initRegistry(registry, label) {
  if (!registry || typeof registry.init !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_registry_invalid', `${label} recovery registry is invalid`);
  }
  try {
    await registry.init();
  } catch {
    throw new JobRecoveryRuntimeError('job_recovery_registry_init_failed', `${label} recovery registry could not be initialized`);
  }
  return registry;
}

function createDurableRecoveryRegistry({ paths, jobRegistryFactory, durableRegistryFactory, recoveryStoreFactory }) {
  return durableRegistryFactory({
    filePath: paths.jobStore,
    registryFactory: jobRegistryFactory,
    recoveryStoreFactory,
  });
}

function createRecoveryContextReader({ paths, contextReaderFactory }) {
  let reader;
  try {
    reader = contextReaderFactory({ filePath: paths.jobStore });
  } catch {
    throw new JobRecoveryRuntimeError('job_recovery_context_reader_invalid', 'Recovery job context reader could not be created');
  }
  if (!reader || typeof reader.read !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_context_reader_invalid', 'Recovery job context reader is invalid');
  }
  return reader;
}

function normalizeRecoveryHostname(value) {
  const hostname = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!hostname || hostname.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname)) {
    throw new JobRecoveryRuntimeError('job_recovery_hostname_invalid', 'Recovery host name is invalid');
  }
  return hostname;
}

async function requireRecoveryServerHost({ serverRegistry, serverId, hostname }) {
  let server;
  try {
    server = await serverRegistry.getServer(serverId);
  } catch {
    throw new JobRecoveryRuntimeError('job_recovery_server_read_failed', 'Recovery server identity could not be read');
  }
  if (!server || server.id !== serverId) {
    throw new JobRecoveryRuntimeError('job_recovery_server_not_found', 'Recovery server identity was not found');
  }
  if (normalizeRecoveryHostname(server.hostname) !== normalizeRecoveryHostname(hostname)) {
    throw new JobRecoveryRuntimeError('job_recovery_server_hostname_mismatch', 'Recovery server identity does not match this host');
  }
  return server;
}

async function initResourceRegistries({
  paths,
  serverRegistry,
  domainRegistryFactory,
  certificateRegistryFactory,
  applicationRegistryFactory,
}) {
  const serverExists = async (id) => Boolean(await serverRegistry.getServer(id));
  const domainRegistry = await initRegistry(domainRegistryFactory({ filePath: paths.domainStore, serverExists }), 'Domain');
  const certificateRegistry = await initRegistry(certificateRegistryFactory({ filePath: paths.certificateStore }), 'Certificate');
  const applicationRegistry = await initRegistry(applicationRegistryFactory({ filePath: paths.applicationStore, serverExists }), 'Application');
  return { domainRegistry, certificateRegistry, applicationRegistry };
}

async function initHostScopedRecovery({
  paths,
  serverId,
  hostname,
  serverRegistryFactory,
  jobRegistryFactory,
  durableRegistryFactory,
  recoveryStoreFactory,
  contextReaderFactory,
}) {
  const serverRegistry = await initRegistry(serverRegistryFactory({ filePath: paths.serverStore }), 'Server');
  await requireRecoveryServerHost({ serverRegistry, serverId, hostname });
  const jobRegistry = createDurableRecoveryRegistry({ paths, jobRegistryFactory, durableRegistryFactory, recoveryStoreFactory });
  const contextReader = createRecoveryContextReader({ paths, contextReaderFactory });
  return { serverRegistry, jobRegistry, contextReader };
}

export async function runTerminalRecoveryFromStores({
  serverId,
  jobId,
  env = process.env,
  packaged = false,
  cwd = process.cwd(),
  serverRegistryFactory = createServerRegistry,
  domainRegistryFactory = createDomainRegistry,
  jobRegistryFactory = createJobRegistry,
  durableRegistryFactory = createDurableJobRegistry,
  recoveryStoreFactory = createJobRecoveryStore,
  certificateRegistryFactory = createCertificateRegistry,
  applicationRegistryFactory = createApplicationRegistry,
  serviceStatus = createMigrationServiceStatus(),
  reconcileCommand = reconcileTerminalRecovery,
} = {}) {
  for (const dependency of [
    serverRegistryFactory,
    domainRegistryFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    certificateRegistryFactory,
    applicationRegistryFactory,
    serviceStatus,
    reconcileCommand,
  ]) {
    if (typeof dependency !== 'function') {
      throw new JobRecoveryRuntimeError('job_recovery_runtime_dependencies_invalid', 'Recovery runtime dependencies are invalid');
    }
  }

  const paths = resolveJobRecoveryPaths({ env, packaged, cwd });
  const serverRegistry = await initRegistry(serverRegistryFactory({ filePath: paths.serverStore }), 'Server');
  const { domainRegistry, certificateRegistry, applicationRegistry } = await initResourceRegistries({
    paths,
    serverRegistry,
    domainRegistryFactory,
    certificateRegistryFactory,
    applicationRegistryFactory,
  });
  const jobRegistry = createDurableRecoveryRegistry({ paths, jobRegistryFactory, durableRegistryFactory, recoveryStoreFactory });

  const result = await reconcileCommand({
    serverId,
    jobId,
    jobRegistry,
    domainRegistry,
    certificateRegistry,
    applicationRegistry,
    serviceStatus,
  });
  return Object.freeze({ ...result, statePaths: paths });
}

export async function runRunningInspectionRecoveryFromStores({
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
  hostOperationsFactory = createLocalHostOperations,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = recoverRunningInspection,
} = {}) {
  for (const dependency of [
    serverRegistryFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    hostOperationsFactory,
    serviceStatus,
    recoverCommand,
  ]) {
    if (typeof dependency !== 'function') {
      throw new JobRecoveryRuntimeError('job_recovery_runtime_dependencies_invalid', 'Running recovery runtime dependencies are invalid');
    }
  }

  const paths = resolveJobRecoveryPaths({ env, packaged, cwd });
  const serverRegistry = await initRegistry(serverRegistryFactory({ filePath: paths.serverStore }), 'Server');
  await requireRecoveryServerHost({ serverRegistry, serverId, hostname });

  const jobRegistry = createDurableRecoveryRegistry({ paths, jobRegistryFactory, durableRegistryFactory, recoveryStoreFactory });
  const hostOperations = hostOperationsFactory();
  if (!hostOperations || typeof hostOperations.executeOperation !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_host_operations_invalid', 'Running recovery host operations are invalid');
  }

  const result = await recoverCommand({
    serverId,
    jobId,
    jobRegistry,
    serviceStatus,
    executeOperation: (operation, payload) => hostOperations.executeOperation(operation, payload),
  });
  return Object.freeze({ ...result, statePaths: paths });
}

export async function runRunningDomainStageRecoveryFromStores({
  serverId,
  jobId,
  hostname = os.hostname(),
  env = process.env,
  packaged = false,
  cwd = process.cwd(),
  serverRegistryFactory = createServerRegistry,
  domainRegistryFactory = createDomainRegistry,
  jobRegistryFactory = createJobRegistry,
  durableRegistryFactory = createDurableJobRegistry,
  recoveryStoreFactory = createJobRecoveryStore,
  certificateRegistryFactory = createCertificateRegistry,
  applicationRegistryFactory = createApplicationRegistry,
  contextReaderFactory = createJobRecoveryContextReader,
  nginxManagerFactory = createNginxManager,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = recoverRunningDomainStage,
} = {}) {
  for (const dependency of [
    serverRegistryFactory,
    domainRegistryFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    certificateRegistryFactory,
    applicationRegistryFactory,
    contextReaderFactory,
    nginxManagerFactory,
    serviceStatus,
    recoverCommand,
  ]) {
    if (typeof dependency !== 'function') {
      throw new JobRecoveryRuntimeError('job_recovery_runtime_dependencies_invalid', 'Domain recovery runtime dependencies are invalid');
    }
  }

  const paths = resolveJobRecoveryPaths({ env, packaged, cwd });
  const { serverRegistry, jobRegistry, contextReader } = await initHostScopedRecovery({
    paths,
    serverId,
    hostname,
    serverRegistryFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    contextReaderFactory,
  });
  const { domainRegistry, certificateRegistry, applicationRegistry } = await initResourceRegistries({
    paths,
    serverRegistry,
    domainRegistryFactory,
    certificateRegistryFactory,
    applicationRegistryFactory,
  });
  const nginxManager = nginxManagerFactory();
  if (!nginxManager || typeof nginxManager.inspectStagedDomain !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_nginx_evidence_invalid', 'Domain recovery Nginx evidence provider is invalid');
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
    inspectStageEvidence: (payload) => nginxManager.inspectStagedDomain(payload),
  });
  return Object.freeze({ ...result, statePaths: paths });
}

export async function runRunningStaticDeploymentRecoveryFromStores({
  serverId,
  jobId,
  hostname = os.hostname(),
  env = process.env,
  packaged = false,
  cwd = process.cwd(),
  serverRegistryFactory = createServerRegistry,
  domainRegistryFactory = createDomainRegistry,
  jobRegistryFactory = createJobRegistry,
  durableRegistryFactory = createDurableJobRegistry,
  recoveryStoreFactory = createJobRecoveryStore,
  certificateRegistryFactory = createCertificateRegistry,
  applicationRegistryFactory = createApplicationRegistry,
  contextReaderFactory = createJobRecoveryContextReader,
  evidenceInspectorFactory = createStaticDeploymentEvidenceInspector,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = recoverRunningStaticDeployment,
} = {}) {
  for (const dependency of [
    serverRegistryFactory,
    domainRegistryFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    certificateRegistryFactory,
    applicationRegistryFactory,
    contextReaderFactory,
    evidenceInspectorFactory,
    serviceStatus,
    recoverCommand,
  ]) {
    if (typeof dependency !== 'function') {
      throw new JobRecoveryRuntimeError('job_recovery_runtime_dependencies_invalid', 'Static recovery runtime dependencies are invalid');
    }
  }

  const paths = resolveJobRecoveryPaths({ env, packaged, cwd });
  const { serverRegistry, jobRegistry, contextReader } = await initHostScopedRecovery({
    paths,
    serverId,
    hostname,
    serverRegistryFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    contextReaderFactory,
  });
  const { domainRegistry, certificateRegistry, applicationRegistry } = await initResourceRegistries({
    paths,
    serverRegistry,
    domainRegistryFactory,
    certificateRegistryFactory,
    applicationRegistryFactory,
  });
  const evidenceInspector = evidenceInspectorFactory();
  if (!evidenceInspector || typeof evidenceInspector.inspect !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_static_evidence_invalid', 'Static recovery evidence provider is invalid');
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
    inspectDeploymentEvidence: (identity) => evidenceInspector.inspect(identity),
  });
  return Object.freeze({ ...result, statePaths: paths });
}

export async function runRunningDatabaseCreateRecoveryFromStores({
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
  databaseManagerFactory = createDatabaseManager,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = recoverRunningDatabaseCreate,
} = {}) {
  for (const dependency of [
    serverRegistryFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    contextReaderFactory,
    databaseManagerFactory,
    serviceStatus,
    recoverCommand,
  ]) {
    if (typeof dependency !== 'function') {
      throw new JobRecoveryRuntimeError('job_recovery_runtime_dependencies_invalid', 'Database recovery runtime dependencies are invalid');
    }
  }

  const paths = resolveJobRecoveryPaths({ env, packaged, cwd });
  const { jobRegistry, contextReader } = await initHostScopedRecovery({
    paths,
    serverId,
    hostname,
    serverRegistryFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    contextReaderFactory,
  });
  const databaseManager = databaseManagerFactory();
  if (!databaseManager || typeof databaseManager.inspect !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_database_evidence_invalid', 'Database recovery evidence provider is invalid');
  }

  const result = await recoverCommand({
    serverId,
    jobId,
    jobRegistry,
    serviceStatus,
    loadJobContext: (id) => contextReader.read(id),
    inspectDatabaseState: () => databaseManager.inspect(),
  });
  return Object.freeze({ ...result, statePaths: paths });
}

export async function runRunningDatabaseDeleteRecoveryFromStores({
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
  deletionReceiptStoreFactory = createDatabaseDeletionReceiptStore,
  databaseManagerFactory = createDatabaseManager,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = recoverRunningDatabaseDelete,
} = {}) {
  for (const dependency of [
    serverRegistryFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    contextReaderFactory,
    deletionReceiptStoreFactory,
    databaseManagerFactory,
    serviceStatus,
    recoverCommand,
  ]) {
    if (typeof dependency !== 'function') {
      throw new JobRecoveryRuntimeError('job_recovery_runtime_dependencies_invalid', 'Database deletion recovery runtime dependencies are invalid');
    }
  }

  const paths = resolveJobRecoveryPaths({ env, packaged, cwd });
  const { jobRegistry, contextReader } = await initHostScopedRecovery({
    paths,
    serverId,
    hostname,
    serverRegistryFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    contextReaderFactory,
  });
  const receiptStore = deletionReceiptStoreFactory();
  if (!receiptStore || typeof receiptStore.read !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_database_delete_receipt_invalid', 'Database deletion recovery receipt store is invalid');
  }
  const databaseManager = databaseManagerFactory();
  if (!databaseManager || typeof databaseManager.inspect !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_database_evidence_invalid', 'Database recovery evidence provider is invalid');
  }

  const result = await recoverCommand({
    serverId,
    jobId,
    jobRegistry,
    serviceStatus,
    loadJobContext: (id) => contextReader.read(id),
    readDeletionReceipt: (receiptServerId, receiptJobId) => receiptStore.read(receiptServerId, receiptJobId),
    inspectDatabaseState: () => databaseManager.inspect(),
  });
  return Object.freeze({ ...result, statePaths: paths });
}

export const jobRecoveryRuntimeInternals = Object.freeze({
  packagedStateRoot: PACKAGED_STATE_ROOT,
  resolveRecoveryStorePath,
  initRegistry,
  createDurableRecoveryRegistry,
  createRecoveryContextReader,
  normalizeRecoveryHostname,
  requireRecoveryServerHost,
  initResourceRegistries,
  initHostScopedRecovery,
});
