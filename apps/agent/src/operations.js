import { access, readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import { OPERATIONS } from '@yunpanel/protocol';
import { acmeManager } from './acme-manager.js';
import { inspectDocker } from './docker-inspector.js';
import { inspectNginx } from './nginx-inspector.js';
import { nginxManager } from './nginx-manager.js';
import { staticDeploymentManager } from './static-deployment-manager.js';
import { staticRollbackManager } from './static-rollback-manager.js';
import { inspectAllowlistedServices } from './systemd-inspector.js';

const CAPABILITIES = Object.freeze({
  systemd: ['/usr/bin/systemctl', '/bin/systemctl'],
  nginx: ['/usr/sbin/nginx', '/usr/bin/nginx'],
  apache: ['/usr/sbin/apache2', '/usr/sbin/httpd'],
  passenger: ['/usr/bin/passenger-config', '/usr/local/bin/passenger-config'],
  docker: ['/usr/bin/docker', '/usr/local/bin/docker'],
  dockerCompose: [
    '/usr/libexec/docker/cli-plugins/docker-compose',
    '/usr/lib/docker/cli-plugins/docker-compose',
    '/usr/local/lib/docker/cli-plugins/docker-compose',
  ],
  mysql: ['/usr/bin/mysql'],
  mariadb: ['/usr/bin/mariadb'],
  postfix: ['/usr/sbin/postfix'],
  dovecot: ['/usr/sbin/dovecot'],
  rspamd: ['/usr/bin/rspamc', '/usr/sbin/rspamd'],
  roundcube: ['/usr/share/roundcube', '/var/lib/roundcube'],
  certbot: ['/usr/bin/certbot', '/usr/local/bin/certbot'],
});

function parseOsRelease(content) {
  const values = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex < 1) continue;
    const key = trimmed.slice(0, separatorIndex);
    let value = trimmed.slice(separatorIndex + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return {
    id: values.ID ?? os.platform(),
    name: values.NAME ?? values.ID ?? os.platform(),
    prettyName: values.PRETTY_NAME ?? values.NAME ?? values.ID ?? os.platform(),
    version: values.VERSION_ID ?? null,
    codename: values.VERSION_CODENAME ?? values.UBUNTU_CODENAME ?? null,
  };
}

async function readOperatingSystem() {
  try {
    return parseOsRelease(await readFile('/etc/os-release', 'utf8'));
  } catch {
    return { id: os.platform(), name: os.platform(), prettyName: os.platform(), version: null, codename: null };
  }
}

function snapshotCpuTimes() {
  return os.cpus().map((cpu) => ({ idle: cpu.times.idle, total: Object.values(cpu.times).reduce((sum, value) => sum + value, 0) }));
}

async function sampleCpuUsage(sampleMs = 100) {
  const before = snapshotCpuTimes();
  await new Promise((resolve) => setTimeout(resolve, sampleMs));
  const after = snapshotCpuTimes();
  let idleDelta = 0;
  let totalDelta = 0;
  for (let index = 0; index < Math.min(before.length, after.length); index += 1) {
    idleDelta += after[index].idle - before[index].idle;
    totalDelta += after[index].total - before[index].total;
  }
  if (totalDelta <= 0) return null;
  return Number((((totalDelta - idleDelta) / totalDelta) * 100).toFixed(2));
}

async function inspectRootFilesystem() {
  try {
    const stats = await statfs('/');
    const totalBytes = stats.bsize * stats.blocks;
    const availableBytes = stats.bsize * stats.bavail;
    return { mount: '/', totalBytes, availableBytes, usedBytes: Math.max(0, totalBytes - availableBytes) };
  } catch {
    return null;
  }
}

async function findExistingPath(paths) {
  for (const candidate of paths) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known safe path.
    }
  }
  return null;
}

async function detectCapabilities() {
  const entries = await Promise.all(Object.entries(CAPABILITIES).map(async ([name, paths]) => {
    const detectedPath = await findExistingPath(paths);
    return [name, { installed: Boolean(detectedPath), path: detectedPath }];
  }));
  return Object.fromEntries(entries);
}

function getNetworkAddresses() {
  const addresses = [];
  for (const [interfaceName, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || (entry.family !== 'IPv4' && entry.family !== 'IPv6')) continue;
      addresses.push({ interface: interfaceName, family: entry.family, address: entry.address });
    }
  }
  return addresses;
}

async function inspectServer() {
  const cpus = os.cpus();
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const [operatingSystem, cpuUsagePercent, filesystem, capabilities] = await Promise.all([
    readOperatingSystem(), sampleCpuUsage(), inspectRootFilesystem(), detectCapabilities(),
  ]);

  return {
    hostname: os.hostname(),
    operatingSystem,
    kernel: { platform: os.platform(), release: os.release(), architecture: os.arch() },
    uptimeSeconds: Math.floor(os.uptime()),
    loadAverage: os.loadavg(),
    cpu: { count: cpus.length, model: cpus[0]?.model ?? 'unknown', usagePercent: cpuUsagePercent },
    memory: { totalBytes: totalMemory, freeBytes: freeMemory, usedBytes: Math.max(0, totalMemory - freeMemory) },
    filesystem,
    network: getNetworkAddresses(),
    runtimes: { node: { installed: true, version: process.version, executable: process.execPath } },
    capabilities,
    mode: process.env.YUN_AGENT_MODE ?? 'protected',
  };
}

export const operationHandlers = Object.freeze({
  [OPERATIONS.SERVER_INSPECT]: inspectServer,
  [OPERATIONS.SERVER_SERVICES]: inspectAllowlistedServices,
  [OPERATIONS.SERVER_DOCKER]: inspectDocker,
  [OPERATIONS.SERVER_NGINX]: inspectNginx,
  [OPERATIONS.DOMAIN_STAGE]: (payload) => nginxManager.stageDomain(payload),
  [OPERATIONS.DOMAIN_ACTIVATE]: (payload) => nginxManager.activateDomain(payload),
  [OPERATIONS.SSL_ISSUE]: (payload) => acmeManager.issueCertificate(payload),
  [OPERATIONS.SSL_RENEW]: (payload) => acmeManager.renewCertificate(payload),
  [OPERATIONS.APP_STATIC_DEPLOY]: (payload) => staticDeploymentManager.deployStatic(payload),
  [OPERATIONS.APP_STATIC_ROLLBACK]: (payload) => staticRollbackManager.rollbackStatic(payload),
});

export async function executeOperation(operation, payload) {
  const handler = operationHandlers[operation];
  if (!handler) {
    const error = new Error('Operation handler is not available');
    error.code = 'operation_unavailable';
    throw error;
  }
  return handler(payload);
}

export const inventoryInternals = Object.freeze({ parseOsRelease, sampleCpuUsage, inspectRootFilesystem, detectCapabilities });
