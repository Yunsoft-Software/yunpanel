import { inspectHostInventory } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';
import { createDatabaseDeletionReceiptStore } from './database-deletion-receipt.js';
import { createLocalHostOperations } from './local-host-operations.js';
import { resolveLocalRuntimeConfig } from './local-runtime-config.js';
import { startLocalRuntime } from './local-runtime.js';

export class ConfiguredLocalRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConfiguredLocalRuntimeError';
    this.code = code;
  }
}

export async function startConfiguredLocalRuntime({
  env = process.env,
  hostname,
  jobStorePath,
  runtimeVersion,
  registry,
  jobRegistry,
  domainRegistry,
  certificateRegistry,
  applicationRegistry,
  applicationEnvironmentRegistry,
  createOperations = createLocalHostOperations,
  createDatabaseDeletionReceipts = createDatabaseDeletionReceiptStore,
  inspectInventory = inspectHostInventory,
  inspectServices = null,
  inspectDocker = null,
  inspectNginx = null,
  startRuntime = startLocalRuntime,
  onError = () => {},
} = {}) {
  const config = resolveLocalRuntimeConfig({ env, hostname, jobStorePath });
  if (!config.enabled) return null;
  if (!applicationEnvironmentRegistry || typeof applicationEnvironmentRegistry.materialize !== 'function') {
    throw new ConfiguredLocalRuntimeError('local_environment_registry_invalid', 'Local runtime requires the application environment registry');
  }
  if (typeof createOperations !== 'function'
    || typeof createDatabaseDeletionReceipts !== 'function'
    || typeof inspectInventory !== 'function'
    || (inspectServices !== null && typeof inspectServices !== 'function')
    || (inspectDocker !== null && typeof inspectDocker !== 'function')
    || (inspectNginx !== null && typeof inspectNginx !== 'function')
    || typeof startRuntime !== 'function'
    || typeof onError !== 'function') {
    throw new ConfiguredLocalRuntimeError('local_runtime_startup_adapter_invalid', 'Local runtime startup adapters are invalid');
  }

  const hostOperations = createOperations({
    loadApplicationEnvironment: (applicationId) => applicationEnvironmentRegistry.materialize(applicationId),
  });
  const databaseDeletionReceipts = createDatabaseDeletionReceipts();
  if (!databaseDeletionReceipts || typeof databaseDeletionReceipts.write !== 'function') {
    throw new ConfiguredLocalRuntimeError('local_database_deletion_receipts_invalid', 'Local runtime database deletion receipt store is invalid');
  }

  const recordExecutionEvidence = async ({ serverId, jobId, operation, payload, result }) => {
    if (operation !== OPERATIONS.DATABASE_DELETE) return;
    await databaseDeletionReceipts.write({
      serverId,
      jobId,
      databaseName: payload?.name,
      result,
    });
  };

  const snapshotProvider = async () => {
    const [baseInventory, services, docker, nginx] = await Promise.all([
      inspectInventory({ mode: 'local' }),
      inspectServices ? inspectServices() : null,
      inspectDocker ? inspectDocker() : null,
      inspectNginx ? inspectNginx() : null,
    ]);
    let inventory = baseInventory;
    if (inspectDocker) inventory = { ...inventory, docker };
    if (inspectNginx) inventory = { ...inventory, nginx };
    return inspectServices ? { inventory, services } : { inventory };
  };

  return startRuntime({
    serverId: config.serverId,
    hostname: config.hostname,
    runtimeVersion,
    lockPath: config.lockPath,
    registry,
    jobRegistry,
    domainRegistry,
    certificateRegistry,
    applicationRegistry,
    hostOperations,
    snapshotProvider,
    recordExecutionEvidence,
    onError,
  });
}