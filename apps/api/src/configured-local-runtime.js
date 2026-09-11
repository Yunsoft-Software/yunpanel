import { inspectHostInventory } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';
import { createCertificateOperationReceiptStore } from './certificate-operation-receipt.js';
import { createDatabaseDeletionReceiptStore } from './database-deletion-receipt.js';
import { createDomainActivationReceiptStore } from './domain-activation-receipt.js';
import { createLocalHostOperations } from './local-host-operations.js';
import { resolveLocalRuntimeConfig } from './local-runtime-config.js';
import { startLocalRuntime } from './local-runtime.js';
import { createManagedServiceMutationReceiptStore } from './managed-service-mutation-receipt.js';
import { createNodeDeploymentReceiptStore } from './node-deployment-receipt.js';
import { createNodeRestartReceiptStore } from './node-restart-receipt.js';
import { createNodeRollbackReceiptStore } from './node-rollback-receipt.js';
import { createSystemUpgradeReceiptStore } from './system-upgrade-receipt.js';

export class ConfiguredLocalRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConfiguredLocalRuntimeError';
    this.code = code;
  }
}

function exactStringArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((value, index) => typeof value === 'string' && value === right[index]);
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
  dnsProviderCredentialRegistry = null,
  jobLogStore = null,
  createOperations = createLocalHostOperations,
  createCertificateOperationReceipts = createCertificateOperationReceiptStore,
  createDatabaseDeletionReceipts = createDatabaseDeletionReceiptStore,
  createDomainActivationReceipts = createDomainActivationReceiptStore,
  createManagedServiceReceipts = createManagedServiceMutationReceiptStore,
  createNodeDeploymentReceipts = createNodeDeploymentReceiptStore,
  createNodeRestartReceipts = createNodeRestartReceiptStore,
  createNodeRollbackReceipts = createNodeRollbackReceiptStore,
  createSystemUpgradeReceipts = createSystemUpgradeReceiptStore,
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
    || typeof createCertificateOperationReceipts !== 'function'
    || typeof createDatabaseDeletionReceipts !== 'function'
    || typeof createDomainActivationReceipts !== 'function'
    || typeof createManagedServiceReceipts !== 'function'
    || typeof createNodeDeploymentReceipts !== 'function'
    || typeof createNodeRestartReceipts !== 'function'
    || typeof createNodeRollbackReceipts !== 'function'
    || typeof createSystemUpgradeReceipts !== 'function'
    || typeof inspectInventory !== 'function'
    || (inspectServices !== null && typeof inspectServices !== 'function')
    || (inspectDocker !== null && typeof inspectDocker !== 'function')
    || (inspectNginx !== null && typeof inspectNginx !== 'function')
    || typeof startRuntime !== 'function'
    || typeof onError !== 'function') {
    throw new ConfiguredLocalRuntimeError('local_runtime_startup_adapter_invalid', 'Local runtime startup adapters are invalid');
  }

  const hostOperations = createOperations({
    loadApplicationEnvironment: (applicationId, expectedRevision) => applicationEnvironmentRegistry.materialize(applicationId, {
      expectedRevision,
    }),
    loadDeploymentCredential: typeof applicationEnvironmentRegistry.materializeDeploymentCredential === 'function'
      ? (applicationId) => applicationEnvironmentRegistry.materializeDeploymentCredential(applicationId)
      : async () => null,
    loadDnsProviderCredential: dnsProviderCredentialRegistry && typeof dnsProviderCredentialRegistry.materialize === 'function'
      ? (credentialId) => dnsProviderCredentialRegistry.materialize(credentialId)
      : null,
    jobLogStore,
  });
  const certificateOperationReceipts = createCertificateOperationReceipts();
  if (!certificateOperationReceipts || typeof certificateOperationReceipts.write !== 'function') {
    throw new ConfiguredLocalRuntimeError('local_certificate_operation_receipts_invalid', 'Local runtime certificate operation receipt store is invalid');
  }
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
  const nodeDeploymentReceipts = createNodeDeploymentReceipts();
  if (!nodeDeploymentReceipts || typeof nodeDeploymentReceipts.write !== 'function') {
    throw new ConfiguredLocalRuntimeError('local_node_deployment_receipts_invalid', 'Local runtime Node deployment receipt store is invalid');
  }
  const nodeRestartReceipts = createNodeRestartReceipts();
  if (!nodeRestartReceipts || typeof nodeRestartReceipts.write !== 'function') {
    throw new ConfiguredLocalRuntimeError('local_node_restart_receipts_invalid', 'Local runtime Node restart receipt store is invalid');
  }
  const nodeRollbackReceipts = createNodeRollbackReceipts();
  if (!nodeRollbackReceipts || typeof nodeRollbackReceipts.write !== 'function') {
    throw new ConfiguredLocalRuntimeError('local_node_rollback_receipts_invalid', 'Local runtime Node rollback receipt store is invalid');
  }
  const systemUpgradeReceipts = createSystemUpgradeReceipts();
  if (!systemUpgradeReceipts || typeof systemUpgradeReceipts.write !== 'function') {
    throw new ConfiguredLocalRuntimeError('local_system_upgrade_receipts_invalid', 'Local runtime system upgrade receipt store is invalid');
  }

  const recordExecutionEvidence = async ({ serverId, jobId, operation, resourceType, resourceId, payload, result }) => {
    if (operation === OPERATIONS.SSL_ISSUE) {
      if (resourceType !== 'certificate' || typeof resourceId !== 'string' || !resourceId
        || !Array.isArray(payload?.domains) || payload.domains.length < 1
        || result?.certName !== payload.domains[0] || !exactStringArray(result.domains, payload.domains)
        || typeof payload.staging !== 'boolean' || result.staging !== payload.staging
        || result.status !== (payload.staging ? 'validated' : 'issued')) {
        throw new Error('Certificate issue result is not safe recovery evidence');
      }
      await certificateOperationReceipts.write({
        serverId,
        jobId,
        certificateId: resourceId,
        operation,
        result,
      });
      return;
    }

    if (operation === OPERATIONS.SSL_RENEW) {
      if (resourceType !== 'certificate' || typeof resourceId !== 'string' || !resourceId
        || typeof payload?.certName !== 'string' || !payload.certName
        || typeof payload.dryRun !== 'boolean' || result?.certName !== payload.certName
        || result.dryRun !== payload.dryRun || result.status !== (payload.dryRun ? 'validated' : 'renewed')) {
        throw new Error('Certificate renewal result is not safe recovery evidence');
      }
      await certificateOperationReceipts.write({
        serverId,
        jobId,
        certificateId: resourceId,
        operation,
        result,
      });
      return;
    }

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

    if (operation === OPERATIONS.APP_NODE_DEPLOY) {
      if (!result || result.healthy !== true || result.deploymentId !== jobId || result.releaseId !== jobId
        || result.port !== payload?.runtime?.port || result.healthPath !== payload?.runtime?.healthPath
        || typeof result.commitSha !== 'string' || typeof payload?.applicationId !== 'string') {
        throw new Error('Node deployment result is not safe recovery evidence');
      }
      await nodeDeploymentReceipts.write({
        serverId,
        jobId,
        applicationId: payload.applicationId,
        result,
      });
      return;
    }

    if (operation === OPERATIONS.APP_NODE_RESTART) {
      if (!result || result.restarted !== true || result.healthy !== true
        || result.releaseId !== payload?.releaseId || result.port !== payload?.runtime?.port
        || result.healthPath !== payload?.runtime?.healthPath || typeof payload?.applicationId !== 'string') {
        throw new Error('Node restart result is not safe recovery evidence');
      }
      await nodeRestartReceipts.write({
        serverId,
        jobId,
        applicationId: payload.applicationId,
        result,
      });
      return;
    }

    if (operation === OPERATIONS.APP_NODE_ROLLBACK) {
      if (!result || result.active !== true || result.healthy !== true
        || result.releaseId !== payload?.releaseId || result.previousReleaseId !== payload?.currentReleaseId
        || result.port !== payload?.runtime?.port || result.healthPath !== payload?.runtime?.healthPath
        || typeof payload?.applicationId !== 'string') {
        throw new Error('Node rollback result is not safe recovery evidence');
      }
      await nodeRollbackReceipts.write({
        serverId,
        jobId,
        applicationId: payload.applicationId,
        result,
      });
      return;
    }

    if (operation === OPERATIONS.SYSTEM_UPGRADE) {
      if (!result || result.packageName !== 'yunpanel' || result.installed !== true
        || typeof result.installedVersion !== 'string' || typeof result.previousVersion !== 'string'
        || typeof result.updateAvailable !== 'boolean' || typeof result.upgraded !== 'boolean'
        || typeof result.restartScheduled !== 'boolean') {
        throw new Error('System upgrade result is not safe recovery evidence');
      }
      await systemUpgradeReceipts.write({ serverId, jobId, result });
      return;
    }

    if (operation === OPERATIONS.SYSTEM_SERVICE_INSTALL) {
      const unitlessRoundcube = payload?.serviceId === 'roundcube';
      if (!result || result.id !== payload?.serviceId || result.installed !== true
        || (unitlessRoundcube ? result.active !== false || !Array.isArray(result.units) || result.units.length !== 0 : result.active !== true)
        || typeof result.changed !== 'boolean') {
        throw new Error('Managed service install result is not safe recovery evidence');
      }
      await managedServiceReceipts.write({
        serverId,
        jobId,
        operation,
        serviceId: payload.serviceId,
        changed: result.changed,
        state: result,
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
        state: result,
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
    applicationEnvironmentRegistry,
    hostOperations,
    snapshotProvider,
    recordExecutionEvidence,
    onError,
  });
}
