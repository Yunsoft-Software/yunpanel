import os from 'node:os';
import path from 'node:path';
import { createNodeStatusInspector } from '@yunpanel/host-runtime';
import { createApplicationRegistry } from './application-registry.js';
import { createDurableJobRegistry } from './durable-job-registry.js';
import { createJobRecoveryContextReader } from './job-recovery-context.js';
import { JobRecoveryRuntimeError, jobRecoveryRuntimeInternals, resolveJobRecoveryPaths } from './job-recovery-runtime.js';
import { createJobRecoveryStore } from './job-recovery-store.js';
import { createJobRegistry } from './job-registry.js';
import { recoverRunningNodeRestart } from './job-running-node-restart-recovery.js';
import { createMigrationServiceStatus } from './local-migration-cli.js';
import { createNodeRestartReceiptStore } from './node-restart-receipt.js';
import { createServerRegistry } from './server-registry.js';
import { createWebsiteRegistry } from './website-registry.js';
import { createDomainRegistry } from './domain-registry.js';
import { createApplicationEnvironmentRegistry } from './application-environment-registry.js';
import { createSiteMutationLock } from './site-mutation-lock.js';
import { createLocalPassengerRestartOperation } from './local-passenger-restart-operation.js';

async function createPassengerInspection({ paths, env, packaged, cwd, applicationRegistry, serverRegistry }) {
  const stateRoot = path.dirname(paths.serverStore);
  const resolve = (value, name) => jobRecoveryRuntimeInternals.resolveRecoveryStorePath(value,
    path.join(stateRoot, name), { packaged, cwd, label: 'Passenger' });
  const serverExists = async id => Boolean(await serverRegistry.getServer(id));
  const websiteRegistry = await jobRecoveryRuntimeInternals.initRegistry(createWebsiteRegistry({
    filePath: resolve(env.YUNPANEL_WEBSITE_STORE, 'website-registry.json'), serverExists,
    getApplication: id => applicationRegistry.getApplication(id),
  }), 'Website');
  const domainRegistry = await jobRecoveryRuntimeInternals.initRegistry(createDomainRegistry({
    filePath: paths.domainStore, serverExists, getWebsite: id => websiteRegistry.getWebsite(id),
  }), 'Domain');
  const applicationEnvironmentRegistry = await jobRecoveryRuntimeInternals.initRegistry(createApplicationEnvironmentRegistry({
    filePath: resolve(env.YUNPANEL_APPLICATION_ENVIRONMENT_STORE, 'application-environment-registry.json'),
    masterKey: env.YUNPANEL_SECRET_MASTER_KEY ?? null,
    applicationExists: async id => Boolean(await applicationRegistry.getApplication(id)),
  }), 'Application environment');
  return createLocalPassengerRestartOperation({ applicationRegistry, websiteRegistry, domainRegistry,
    applicationEnvironmentRegistry, siteMutationLock: createSiteMutationLock({ root: path.join(stateRoot, 'locks', 'site-mutations') }) });
}

export async function runRunningNodeRestartRecoveryFromStores({
  serverId,
  jobId,
  hostname = os.hostname(),
  env = process.env,
  packaged = false,
  cwd = process.cwd(),
  serverRegistryFactory = createServerRegistry,
  applicationRegistryFactory = createApplicationRegistry,
  jobRegistryFactory = createJobRegistry,
  durableRegistryFactory = createDurableJobRegistry,
  recoveryStoreFactory = createJobRecoveryStore,
  contextReaderFactory = createJobRecoveryContextReader,
  receiptStoreFactory = createNodeRestartReceiptStore,
  statusInspectorFactory = createNodeStatusInspector,
  passengerInspectionFactory = createPassengerInspection,
  allowAppliedStateRecoveryJobId = null,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = recoverRunningNodeRestart,
} = {}) {
  for (const dependency of [serverRegistryFactory, applicationRegistryFactory, jobRegistryFactory, durableRegistryFactory,
    recoveryStoreFactory, contextReaderFactory, receiptStoreFactory, statusInspectorFactory, passengerInspectionFactory, serviceStatus, recoverCommand]) {
    if (typeof dependency !== 'function') {
      throw new JobRecoveryRuntimeError('job_recovery_runtime_dependencies_invalid', 'Node restart recovery runtime dependencies are invalid');
    }
  }

  const paths = resolveJobRecoveryPaths({ env, packaged, cwd });
  const { serverRegistry, jobRegistry, contextReader } = await jobRecoveryRuntimeInternals.initHostScopedRecovery({
    paths, serverId, hostname, serverRegistryFactory, jobRegistryFactory, durableRegistryFactory, recoveryStoreFactory, contextReaderFactory,
  });
  const serverExists = async (id) => Boolean(await serverRegistry.getServer(id));
  const applicationRegistry = await jobRecoveryRuntimeInternals.initRegistry(
    applicationRegistryFactory({ filePath: paths.applicationStore, serverExists }),
    'Application',
  );
  const receiptStore = receiptStoreFactory();
  if (!receiptStore || typeof receiptStore.read !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_node_restart_receipt_invalid', 'Node restart recovery receipt store is invalid');
  }
  const statusInspector = statusInspectorFactory();
  if (!statusInspector || typeof statusInspector.inspectNodeStatus !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_node_restart_status_invalid', 'Node restart recovery status inspector is invalid');
  }

  let passengerInspection;

  const result = await recoverCommand({
    serverId,
    jobId,
    jobRegistry,
    applicationRegistry,
    serviceStatus,
    loadJobContext: (id) => contextReader.read(id),
    readRestartReceipt: (receiptServerId, receiptJobId) => receiptStore.read(receiptServerId, receiptJobId),
    inspectNodeStatus: (intent) => statusInspector.inspectNodeStatus(intent),
    inspectPassengerState: async (payload, execution) => {
      passengerInspection ??= await passengerInspectionFactory({ paths, env, packaged, cwd, applicationRegistry, serverRegistry });
      if (typeof passengerInspection?.inspectRecovery !== 'function') {
        throw new JobRecoveryRuntimeError('job_recovery_passenger_inspection_invalid', 'Passenger recovery inspection is unavailable');
      }
      return passengerInspection.inspectRecovery(payload, execution);
    },
    writeRestartReceipt: typeof receiptStore.write === 'function' ? input => receiptStore.write(input) : null,
    allowAppliedStateRecoveryJobId,
  });
  return Object.freeze({ ...result, statePaths: paths });
}
