import { inspectHostInventory } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';
import { createDatabaseDeletionReceiptStore } from './database-deletion-receipt.js';
import { createDomainActivationReceiptStore } from './domain-activation-receipt.js';
import { createLocalHostOperations } from './local-host-operations.js';
import { resolveLocalRuntimeConfig } from './local-runtime-config.js';
import { startLocalRuntime } from './local-runtime.js';
import { createManagedServiceMutationReceiptStore } from './managed-service-mutation-receipt.js';

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
  createDomainActivationReceipts = createDomainActivationReceiptStore,
  createManagedServiceReceipts = createManagedServiceMutationReceiptStore,
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
    || typeof createDomainActivationReceipts !== 'function'
    || typeof createManagedServiceReceipts !== 'function'
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
  const domainActivationReceipts = createDomainActivationReceipts();
  if (!domainActivationReceipts || typeof domainActivationReceipts.write !== 'function') {
    throw new ConfiguredLocalRuntimeError('local_domain_activation_receipts_invalid', 'Local runtime domain activation receipt store is invalid');
  }
  const managedServiceReceipts = createManagedServiceReceipts();
  if (!managedServiceReceipts || typeof managedServiceReceipts.write !== 'function') {
    throw new ConfiguredLocalRuntimeError('local_managed_service_receipts_invalid', 'Local runtime managed service receipt store is invalid');
  }

  const recordExecutionEvidence = async ({ serverId, jobId, operation, payload, result }) => {
    if (operation === OPERATIONS.DATABASE_DELETE) {
      await databaseDeletionReceipts.write({
        serverId,
        jobId,
        databaseName: payload?.name,
        result,
      });
      return;
    }

    if (operation === OPERATIONS.DOMAIN_ACTIVATE) {
      if (!result || result.active !== true || result.checksum !== payload?.checksum
        || typeof result.configName !== 'string' || !result.configName) {
        throw new Error('Domain activation result is not safe recovery evidence');
      }
      await domainActivationReceipts.write({
        serverId,
        jobId,
        primaryDomain: payload.primaryDomain,
        checksum: payload.checksum,
      });
      return;
    }

    if (operation === OPERATIONS.SYSTEM_SERVICE_INSTALL) {
      if (!result || result.id !== payload?.serviceId || result.installed !== true || result.active !== true
        || typeof result.changed !== 'boolean') {
        throw new Error('Managed service install result is not safe recovery evidence');
      }
      await managedServiceReceipts.write({
        serverId,
        jobId,
        operation,
        serviceId: payload.serviceId,
        changed: result.changed,
      });
      return;
    }

    if (operation === OPERATIONS.SYSTEM_SERVICE_CONTROL && payload?.action === 'restart') {
      if (!result || result.id !== payload.serviceId || result.action !== 'restart'
        || result.installed !== true || result.active !== true) {
        throw new Error('Managed service restart result is not safe recovery evidence');
      }
      await managedServiceReceipts.write({
        serverId,
        jobId,
        operation,
        serviceId: payload.serviceId,
        action: 'restart',
      });
    }
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
