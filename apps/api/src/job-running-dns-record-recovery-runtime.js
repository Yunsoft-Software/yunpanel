import os from 'node:os';
import path from 'node:path';
import { createCloudflareDnsManager } from '@yunpanel/host-runtime';
import { createDnsHostingRegistry } from './dns-hosting-registry.js';
import { createDnsProviderCredentialRegistry } from './dns-provider-credential-registry.js';
import { createDomainRegistry } from './domain-registry.js';
import { createDurableJobRegistry } from './durable-job-registry.js';
import { createJobRecoveryContextReader } from './job-recovery-context.js';
import { JobRecoveryRuntimeError, jobRecoveryRuntimeInternals, resolveJobRecoveryPaths } from './job-recovery-runtime.js';
import { createJobRecoveryStore } from './job-recovery-store.js';
import { recoverRunningDnsRecord } from './job-running-dns-record-recovery.js';
import { createJobRegistry } from './job-registry.js';
import { createMigrationServiceStatus } from './local-migration-cli.js';
import { createServerRegistry } from './server-registry.js';

function dnsPaths({ env, packaged, cwd, paths }) {
  const defaultRoot = packaged ? jobRecoveryRuntimeInternals.packagedStateRoot : path.resolve(cwd, '.data');
  return Object.freeze({
    dnsHostingStore: jobRecoveryRuntimeInternals.resolveRecoveryStorePath(
      env.YUNPANEL_DNS_HOSTING_STORE,
      path.join(defaultRoot, 'dns-hosting-registry.json'),
      { packaged, cwd, label: 'DNS hosting' },
    ),
    dnsCredentialStore: jobRecoveryRuntimeInternals.resolveRecoveryStorePath(
      env.YUNPANEL_DNS_CREDENTIAL_STORE,
      path.join(defaultRoot, 'dns-provider-credential-registry.json'),
      { packaged, cwd, label: 'DNS credential' },
    ),
    ...paths,
  });
}

export async function runRunningDnsRecordRecoveryFromStores({
  serverId,
  jobId,
  hostname = os.hostname(),
  env = process.env,
  packaged = false,
  cwd = process.cwd(),
  serverRegistryFactory = createServerRegistry,
  domainRegistryFactory = createDomainRegistry,
  dnsHostingRegistryFactory = createDnsHostingRegistry,
  dnsProviderCredentialRegistryFactory = createDnsProviderCredentialRegistry,
  jobRegistryFactory = createJobRegistry,
  durableRegistryFactory = createDurableJobRegistry,
  recoveryStoreFactory = createJobRecoveryStore,
  contextReaderFactory = createJobRecoveryContextReader,
  dnsManagerFactory = createCloudflareDnsManager,
  serviceStatus = createMigrationServiceStatus(),
  recoverCommand = recoverRunningDnsRecord,
} = {}) {
  for (const dependency of [
    serverRegistryFactory,
    domainRegistryFactory,
    dnsHostingRegistryFactory,
    dnsProviderCredentialRegistryFactory,
    jobRegistryFactory,
    durableRegistryFactory,
    recoveryStoreFactory,
    contextReaderFactory,
    dnsManagerFactory,
    serviceStatus,
    recoverCommand,
  ]) {
    if (typeof dependency !== 'function') {
      throw new JobRecoveryRuntimeError('job_recovery_runtime_dependencies_invalid', 'DNS record recovery runtime dependencies are invalid');
    }
  }

  const basePaths = resolveJobRecoveryPaths({ env, packaged, cwd });
  const paths = dnsPaths({ env, packaged, cwd, paths: basePaths });
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
  const dnsHostingRegistry = await jobRecoveryRuntimeInternals.initRegistry(
    dnsHostingRegistryFactory({
      filePath: paths.dnsHostingStore,
      getWebDomain: async (id) => domainRegistry.getDomain(id),
    }),
    'DNS hosting',
  );
  let dnsCredentialRegistry;
  try {
    dnsCredentialRegistry = dnsProviderCredentialRegistryFactory({
      filePath: paths.dnsCredentialStore,
      masterKey: env.YUNPANEL_SECRET_MASTER_KEY ?? null,
      getDnsZone: async (id) => dnsHostingRegistry.getZone(id),
    });
  } catch {
    throw new JobRecoveryRuntimeError('job_recovery_dns_credential_invalid', 'DNS recovery credential store could not be opened');
  }
  await jobRecoveryRuntimeInternals.initRegistry(dnsCredentialRegistry, 'DNS credential');
  const dnsManager = dnsManagerFactory();
  if (!dnsManager || typeof dnsManager.applyRecord !== 'function'
    || typeof dnsCredentialRegistry.materialize !== 'function') {
    throw new JobRecoveryRuntimeError('job_recovery_dns_adapter_invalid', 'DNS record recovery adapter is invalid');
  }

  const result = await recoverCommand({
    serverId,
    jobId,
    jobRegistry,
    serviceStatus,
    loadJobContext: (id) => contextReader.read(id),
    applyDnsRecord: async (payload) => dnsManager.applyRecord(payload, {
      dnsCredential: await dnsCredentialRegistry.materialize(payload.credentialId),
    }),
  });
  return Object.freeze({ ...result, statePaths: paths });
}

export const jobRunningDnsRecordRecoveryRuntimeInternals = Object.freeze({ dnsPaths });
