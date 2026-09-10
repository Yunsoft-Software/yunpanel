import path from 'node:path';
import { createApplicationRegistry } from './application-registry.js';
import { createCertificateRegistry } from './certificate-registry.js';
import { createDomainRegistry } from './domain-registry.js';
import { createDurableJobRegistry } from './durable-job-registry.js';
import { createLocalHostOperations } from './local-host-operations.js';
import { createJobRecoveryStore } from './job-recovery-store.js';
import { reconcileTerminalRecovery } from './job-recovery-command.js';
import { recoverRunningInspection } from './job-running-recovery.js';
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
  const serverExists = async (id) => Boolean(await serverRegistry.getServer(id));
  const domainRegistry = await initRegistry(domainRegistryFactory({ filePath: paths.domainStore, serverExists }), 'Domain');
  const certificateRegistry = await initRegistry(certificateRegistryFactory({ filePath: paths.certificateStore }), 'Certificate');
  const applicationRegistry = await initRegistry(applicationRegistryFactory({ filePath: paths.applicationStore, serverExists }), 'Application');
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
  let server;
  try {
    server = await serverRegistry.getServer(serverId);
  } catch {
    throw new JobRecoveryRuntimeError('job_recovery_server_read_failed', 'Recovery server identity could not be read');
  }
  if (!server || server.id !== serverId) {
    throw new JobRecoveryRuntimeError('job_recovery_server_not_found', 'Recovery server identity was not found');
  }

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

export const jobRecoveryRuntimeInternals = Object.freeze({
  packagedStateRoot: PACKAGED_STATE_ROOT,
  resolveRecoveryStorePath,
  initRegistry,
  createDurableRecoveryRegistry,
});
