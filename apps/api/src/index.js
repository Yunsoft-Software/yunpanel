import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { inspectAllowlistedServices, inspectDocker, inspectNginx } from '@yunpanel/host-runtime';
import { createApp, API_VERSION } from './app.js';
import { createAuditedJobRegistry } from './audited-job-registry.js';
import { createAuthStore } from './auth-store.js';
import { createAuthenticatedApi } from './auth-http.js';
import { createApplicationEnvironmentRegistry } from './application-environment-registry.js';
import { createApplicationRegistry } from './application-registry.js';
import { createCertificateRegistry } from './certificate-registry.js';
import { startCertificateRenewalScheduler } from './certificate-renewal-scheduler.js';
import { startConfiguredLocalRuntime } from './configured-local-runtime.js';
import { createDomainRegistry } from './domain-registry.js';
import { createDurableJobRegistry } from './durable-job-registry.js';
import { createJobRegistry } from './job-registry.js';
import { prepareRootAuthStateOwnership } from './root-auth-state-migration.js';
import { createServerRegistry } from './server-registry.js';
import { createWebsiteMigrationLedger } from './website-migration-ledger.js';
import { createWebsiteMigrationPolicyStore } from './website-migration-policy.js';
import { createWebsiteRegistry } from './website-registry.js';

const host = process.env.YUNPANEL_API_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.YUNPANEL_API_PORT ?? '3001', 10);
const serverStorePath = process.env.YUNPANEL_SERVER_STORE ?? path.resolve('.data/server-registry.json');
const domainStorePath = process.env.YUNPANEL_DOMAIN_STORE ?? path.resolve('.data/domain-registry.json');
const jobStorePath = process.env.YUNPANEL_JOB_STORE ?? path.resolve('.data/job-registry.json');
const certificateStorePath = process.env.YUNPANEL_CERTIFICATE_STORE ?? path.resolve('.data/certificate-registry.json');
const applicationStorePath = process.env.YUNPANEL_APPLICATION_STORE ?? path.resolve('.data/application-registry.json');
const websiteStorePath = process.env.YUNPANEL_WEBSITE_STORE ?? path.resolve('.data/website-registry.json');
const websiteMigrationPolicyStorePath = process.env.YUNPANEL_WEBSITE_MIGRATION_POLICY_STORE ?? path.resolve('.data/website-migration-policy.json');
const websiteMigrationLedgerStorePath = process.env.YUNPANEL_WEBSITE_MIGRATION_LEDGER_STORE ?? path.resolve('.data/website-migration-ledger.json');
const applicationEnvironmentStorePath = process.env.YUNPANEL_APPLICATION_ENVIRONMENT_STORE ?? path.resolve('.data/application-environment-registry.json');
const authStorePath = process.env.YUNPANEL_AUTH_DB ?? path.join(path.dirname(serverStorePath), 'auth', 'auth.sqlite');
const certificateRenewalIntervalMs = Number.parseInt(process.env.YUNPANEL_CERTIFICATE_RENEWAL_INTERVAL_MS ?? `${6 * 60 * 60 * 1000}`, 10);
const certificateRenewBeforeMs = Number.parseInt(process.env.YUNPANEL_CERTIFICATE_RENEW_BEFORE_MS ?? `${30 * 24 * 60 * 60 * 1000}`, 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('YUNPANEL_API_PORT must be a valid TCP port');

function reportLocalExecutorFault(error) {
  const code = typeof error?.code === 'string' ? error.code : 'local_executor_fault';
  const phase = typeof error?.phase === 'string' ? error.phase : 'unknown';
  const jobId = typeof error?.jobId === 'string' ? error.jobId : 'none';
  console.error(`[yunpanel-api] local executor fault code=${code} phase=${phase} job=${jobId}`);
}

function reportAuditFault(metadata) {
  const phase = ['link', 'complete', 'cancel'].includes(metadata?.phase) ? metadata.phase : 'unknown';
  const jobId = typeof metadata?.jobId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(metadata.jobId) ? metadata.jobId : 'none';
  console.error(`[yunpanel-api] audit write failed phase=${phase} job=${jobId}`);
}

const registry = createServerRegistry({ filePath: serverStorePath });
await registry.init();
const durableJobRegistry = createDurableJobRegistry({
  filePath: jobStorePath,
  registryFactory: createJobRegistry,
  automaticReconciliation: true,
});
await durableJobRegistry.init();
const certificateRegistry = createCertificateRegistry({ filePath: certificateStorePath });
await certificateRegistry.init();
const applicationRegistry = createApplicationRegistry({
  filePath: applicationStorePath,
  serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
});
await applicationRegistry.init();
const websiteRegistry = createWebsiteRegistry({
  filePath: websiteStorePath,
  serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
  getApplication: async (applicationId) => applicationRegistry.getApplication(applicationId),
});
await websiteRegistry.init();
const websiteMigrationPolicy = createWebsiteMigrationPolicyStore({ filePath: websiteMigrationPolicyStorePath });
await websiteMigrationPolicy.init();
const migrationLedger = createWebsiteMigrationLedger({ filePath: websiteMigrationLedgerStorePath });
await migrationLedger.init();
const domainRegistry = createDomainRegistry({
  filePath: domainStorePath,
  serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
  getWebsite: async (websiteId) => websiteRegistry.getWebsite(websiteId),
  websiteBindingRequired: () => websiteMigrationPolicy.snapshot().websiteBindingRequired,
});
await domainRegistry.init();
const applicationEnvironmentRegistry = createApplicationEnvironmentRegistry({
  filePath: applicationEnvironmentStorePath,
  masterKey: process.env.YUNPANEL_SECRET_MASTER_KEY ?? null,
  applicationExists: async (applicationId) => Boolean(await applicationRegistry.getApplication(applicationId)),
});
await applicationEnvironmentRegistry.init();

await prepareRootAuthStateOwnership({ filePath: authStorePath });
const authStore = createAuthStore({ filePath: authStorePath });
const jobRegistry = createAuditedJobRegistry({
  registry: durableJobRegistry,
  audit: authStore.audit,
  onAuditError: reportAuditFault,
});
const listener = createAuthenticatedApi({
  store: authStore,
  publicOrigin: process.env.YUNPANEL_PUBLIC_ORIGIN ?? (process.env.NODE_ENV === 'development' ? 'http://127.0.0.1:5173' : undefined),
  development: process.env.NODE_ENV === 'development',
  createHandler: () => createApp({
    registry,
    domainRegistry,
    jobRegistry,
    certificateRegistry,
    applicationRegistry,
    websiteRegistry,
    websiteMigrationPolicy,
    migrationLedger,
    applicationEnvironmentRegistry,
  }),
});

const localRuntime = await startConfiguredLocalRuntime({
  env: process.env,
  hostname: os.hostname(),
  jobStorePath,
  runtimeVersion: API_VERSION,
  registry,
  jobRegistry,
  domainRegistry,
  certificateRegistry,
  applicationRegistry,
  applicationEnvironmentRegistry,
  inspectServices: inspectAllowlistedServices,
  inspectDocker,
  inspectNginx,
  onError: reportLocalExecutorFault,
});
const renewalScheduler = startCertificateRenewalScheduler({ certificateRegistry, jobRegistry, intervalMs: certificateRenewalIntervalMs, renewBeforeMs: certificateRenewBeforeMs });
const server = http.createServer({ headersTimeout: 15_000, requestTimeout: 30_000 }, listener);
server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'));
server.listen(port, host, () => {
  console.log(`[yunpanel-api] listening on http://${host}:${port}`);
  console.log(`[yunpanel-api] server store=${serverStorePath}`);
  console.log(`[yunpanel-api] domain store=${domainStorePath}`);
  console.log(`[yunpanel-api] job store=${jobStorePath}`);
  console.log(`[yunpanel-api] certificate store=${certificateStorePath}`);
  console.log(`[yunpanel-api] application store=${applicationStorePath}`);
  console.log(`[yunpanel-api] website store=${websiteStorePath}`);
  console.log(`[yunpanel-api] website migration policy store=${websiteMigrationPolicyStorePath}`);
  console.log(`[yunpanel-api] website migration ledger store=${websiteMigrationLedgerStorePath}`);
  console.log(`[yunpanel-api] application environment store=${applicationEnvironmentStorePath}`);
  console.log(`[yunpanel-api] secret store=${applicationEnvironmentRegistry.secretStoreConfigured ? 'configured' : 'not configured'}`);
  console.log(`[yunpanel-api] authentication=${authStore.configured() ? 'configured' : 'local setup required'}`);
  console.log(`[yunpanel-api] local execution=${localRuntime ? `enabled server=${localRuntime.serverId} operations=${localRuntime.operations.length}` : 'disabled'}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[yunpanel-api] received ${signal}, shutting down`);
  renewalScheduler.stop();
  const closePromise = new Promise((resolve) => {
    server.close((error) => resolve(error ?? null));
  });
  let runtimeStopFailed = false;
  if (localRuntime) {
    try { await localRuntime.stop(); }
    catch {
      runtimeStopFailed = true;
      console.error('[yunpanel-api] local runtime shutdown failed');
    }
  }
  const serverCloseError = await closePromise;
  authStore.close();
  if (serverCloseError || runtimeStopFailed) {
    console.error('[yunpanel-api] shutdown incomplete');
    process.exitCode = 1;
  }
}
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
