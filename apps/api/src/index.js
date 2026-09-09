import path from 'node:path';
import http from 'node:http';
import { createApp } from './app.js';
import { createAuthStore } from './auth-store.js';
import { createAuthenticatedApi } from './auth-http.js';
import { createApplicationEnvironmentRegistry } from './application-environment-registry.js';
import { createApplicationRegistry } from './application-registry.js';
import { createCertificateRegistry } from './certificate-registry.js';
import { startCertificateRenewalScheduler } from './certificate-renewal-scheduler.js';
import { createDomainRegistry } from './domain-registry.js';
import { createJobRegistry } from './job-registry.js';
import { createServerRegistry } from './server-registry.js';

const host = process.env.YUNPANEL_API_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.YUNPANEL_API_PORT ?? '3001', 10);
const serverStorePath = process.env.YUNPANEL_SERVER_STORE ?? path.resolve('.data/server-registry.json');
const domainStorePath = process.env.YUNPANEL_DOMAIN_STORE ?? path.resolve('.data/domain-registry.json');
const jobStorePath = process.env.YUNPANEL_JOB_STORE ?? path.resolve('.data/job-registry.json');
const certificateStorePath = process.env.YUNPANEL_CERTIFICATE_STORE ?? path.resolve('.data/certificate-registry.json');
const applicationStorePath = process.env.YUNPANEL_APPLICATION_STORE ?? path.resolve('.data/application-registry.json');
const applicationEnvironmentStorePath = process.env.YUNPANEL_APPLICATION_ENVIRONMENT_STORE ?? path.resolve('.data/application-environment-registry.json');
const certificateRenewalIntervalMs = Number.parseInt(process.env.YUNPANEL_CERTIFICATE_RENEWAL_INTERVAL_MS ?? `${6 * 60 * 60 * 1000}`, 10);
const certificateRenewBeforeMs = Number.parseInt(process.env.YUNPANEL_CERTIFICATE_RENEW_BEFORE_MS ?? `${30 * 24 * 60 * 60 * 1000}`, 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('YUNPANEL_API_PORT must be a valid TCP port');

const registry = createServerRegistry({ filePath: serverStorePath });
await registry.init();
const domainRegistry = createDomainRegistry({ filePath: domainStorePath, serverExists: async (serverId) => Boolean(await registry.getServer(serverId)) });
await domainRegistry.init();
const jobRegistry = createJobRegistry({ filePath: jobStorePath });
await jobRegistry.init();
const certificateRegistry = createCertificateRegistry({ filePath: certificateStorePath });
await certificateRegistry.init();
const applicationRegistry = createApplicationRegistry({ filePath: applicationStorePath, serverExists: async (serverId) => Boolean(await registry.getServer(serverId)) });
await applicationRegistry.init();
const applicationEnvironmentRegistry = createApplicationEnvironmentRegistry({
  filePath: applicationEnvironmentStorePath,
  masterKey: process.env.YUNPANEL_SECRET_MASTER_KEY ?? null,
  applicationExists: async (applicationId) => Boolean(await applicationRegistry.getApplication(applicationId)),
});
await applicationEnvironmentRegistry.init();

const authStore = createAuthStore({ filePath: process.env.YUNPANEL_AUTH_DB ?? path.join(path.dirname(serverStorePath), 'auth', 'auth.sqlite') });
const listener = createAuthenticatedApi({
  store: authStore,
  publicOrigin: process.env.YUNPANEL_PUBLIC_ORIGIN ?? (process.env.NODE_ENV === 'development' ? 'http://127.0.0.1:5173' : undefined),
  development: process.env.NODE_ENV === 'development',
  createHandler: ({ adminToken }) => createApp({ registry, domainRegistry, jobRegistry, certificateRegistry, applicationRegistry, applicationEnvironmentRegistry, adminToken }),
});
const renewalScheduler = startCertificateRenewalScheduler({ certificateRegistry, jobRegistry, intervalMs: certificateRenewalIntervalMs, renewBeforeMs: certificateRenewBeforeMs });
const server = http.createServer({ headersTimeout: 15_000, requestTimeout: 30_000 }, listener);
// No terminal/WebSocket endpoint is enabled yet. Do not bypass HTTP auth with a raw upgrade listener.
server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'));
server.listen(port, host, () => {
  console.log(`[yunpanel-api] listening on http://${host}:${port}`);
  console.log(`[yunpanel-api] server store=${serverStorePath}`);
  console.log(`[yunpanel-api] domain store=${domainStorePath}`);
  console.log(`[yunpanel-api] job store=${jobStorePath}`);
  console.log(`[yunpanel-api] certificate store=${certificateStorePath}`);
  console.log(`[yunpanel-api] application store=${applicationStorePath}`);
  console.log(`[yunpanel-api] application environment store=${applicationEnvironmentStorePath}`);
  console.log(`[yunpanel-api] secret store=${applicationEnvironmentRegistry.secretStoreConfigured ? 'configured' : 'not configured'}`);
  console.log(`[yunpanel-api] authentication=${authStore.configured() ? 'configured' : 'local setup required'}`);
});
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[yunpanel-api] received ${signal}, shutting down`);
  renewalScheduler.stop();
  server.close((error) => {
    authStore.close();
    if (error) { console.error('[yunpanel-api] shutdown failed', error); process.exitCode = 1; }
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
