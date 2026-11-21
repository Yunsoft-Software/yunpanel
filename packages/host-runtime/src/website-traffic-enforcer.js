import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  YUNPANEL_TRAFFIC_CONF_PATH,
  YUNPANEL_TRAFFIC_LOG_FORMAT,
  YUNPANEL_TRAFFIC_LOG_PATH,
  nginxConfigFileName,
  renderNginxTrafficAccountingConfig,
} from '@yunpanel/config-templates';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ACCESS_LOG_LINE_RE = /^\s*access_log\s+(\/[A-Za-z0-9._/-]+\.access\.log)\s*;/gm;

export class WebsiteTrafficEnforcerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebsiteTrafficEnforcerError';
    this.code = code;
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function isSafeLogInsideDir(logPath, allowedLogDir) {
  if (typeof logPath !== 'string' || typeof allowedLogDir !== 'string') return false;
  const normalizedLog = path.posix.normalize(logPath);
  const normalizedDir = path.posix.normalize(allowedLogDir).replace(/\/+$/, '');
  if (normalizedLog !== logPath || logPath.includes('/../') || logPath.endsWith('/..')) return false;
  return normalizedLog.startsWith(`${normalizedDir}/`) && path.posix.dirname(normalizedLog) === normalizedDir;
}

/**
 * Pure read-only discovery over ALREADY-APPLIED managed Nginx vhost files (`yunpanel-<domain>.conf`).
 * Never reads or activates `desired`/`staged` state, never mutates any vhost file, and never touches
 * manual, panel, or mail server blocks.
 */
export async function discoverAppliedTrafficVhosts({
  domains = [],
  sitesDir = '/etc/nginx/sites-enabled',
  allowedLogDir = '/var/log/nginx',
  lstatFn = lstat,
  readFileFn = readFile,
} = {}) {
  if (!Array.isArray(domains) || typeof sitesDir !== 'string' || !sitesDir) {
    return Object.freeze({ dedicatedWebsiteIds: Object.freeze([]), legacySources: Object.freeze([]), vhosts: Object.freeze([]) });
  }

  const dedicatedWebsiteIds = new Set();
  const vhosts = [];
  const logOwnerMap = new Map();
  const ambiguousLogs = new Set();

  for (const domain of domains) {
    if (!domain || typeof domain !== 'object' || Array.isArray(domain)) continue;
    if (domain.applied === false) continue;
    const state = domain.state ?? domain.status ?? null;
    if (state !== 'active') continue;
    if (typeof domain.websiteId !== 'string' || !UUID_RE.test(domain.websiteId.trim())) continue;
    const websiteId = domain.websiteId.trim().toLowerCase();

    let configName;
    try {
      configName = `yunpanel-${nginxConfigFileName(domain.primaryDomain)}`;
    } catch {
      continue;
    }
    const activePath = path.join(sitesDir, configName);
    let st;
    try {
      st = await lstatFn(activePath);
    } catch {
      continue;
    }
    if (!st.isFile() || st.isSymbolicLink()) continue;

    let content;
    try {
      content = await readFileFn(activePath, 'utf8');
    } catch {
      continue;
    }

    const usesDedicatedTrafficLog = content.includes(YUNPANEL_TRAFFIC_LOG_FORMAT);
    const trafficGuardReady = content.includes('$yunpanel_traffic_blocked');
    if (usesDedicatedTrafficLog) {
      dedicatedWebsiteIds.add(websiteId);
      vhosts.push(Object.freeze({
        websiteId,
        primaryDomain: domain.primaryDomain,
        configName,
        mode: 'dedicated_traffic_log',
        includesStaticAssets: true,
        trafficGuardReady,
        logPath: null,
      }));
      continue;
    }

    const matchedLogs = new Set();
    SAFE_ACCESS_LOG_LINE_RE.lastIndex = 0;
    let match = SAFE_ACCESS_LOG_LINE_RE.exec(content);
    while (match) {
      const candidate = match[1];
      if (isSafeLogInsideDir(candidate, allowedLogDir)) {
        matchedLogs.add(candidate);
      }
      match = SAFE_ACCESS_LOG_LINE_RE.exec(content);
    }
    if (matchedLogs.size !== 1) continue;
    const [legacyLogPath] = [...matchedLogs];
    const existingOwner = logOwnerMap.get(legacyLogPath);
    if (existingOwner && existingOwner !== websiteId) {
      ambiguousLogs.add(legacyLogPath);
      continue;
    }
    logOwnerMap.set(legacyLogPath, websiteId);
    vhosts.push(Object.freeze({
      websiteId,
      primaryDomain: domain.primaryDomain,
      configName,
      mode: 'legacy_applied_access_log',
      includesStaticAssets: false,
      trafficGuardReady: false,
      logPath: legacyLogPath,
    }));
  }

  const legacySources = [];
  for (const [legacyLogPath, websiteId] of logOwnerMap.entries()) {
    if (ambiguousLogs.has(legacyLogPath)) continue;
    legacySources.push(Object.freeze({
      websiteId,
      logPath: legacyLogPath,
      includesStaticAssets: false,
      trafficGuardReady: false,
    }));
  }
  legacySources.sort((left, right) => left.logPath.localeCompare(right.logPath));

  return Object.freeze({
    dedicatedWebsiteIds: Object.freeze([...dedicatedWebsiteIds].sort((a, b) => a.localeCompare(b))),
    legacySources: Object.freeze(legacySources),
    vhosts: Object.freeze(vhosts.filter((entry) => !entry.logPath || !ambiguousLogs.has(entry.logPath))),
  });
}

function execFileSafe(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export function createWebsiteTrafficEnforcer({
  configPath = YUNPANEL_TRAFFIC_CONF_PATH,
  trafficLogPath = YUNPANEL_TRAFFIC_LOG_PATH,
  sitesDir = null,
  verifyActiveConfigFile = sitesDir !== null,
  nginxManager = null,
  withNginxLock = null,
  nginxPath = '/usr/sbin/nginx',
  systemctlPath = '/usr/bin/systemctl',
  execFn = execFileSafe,
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  writeFileFn = writeFile,
  renameFn = rename,
  rmFn = rm,
} = {}) {
  let reconcileChain = Promise.resolve();
  const lockFn = typeof withNginxLock === 'function'
    ? withNginxLock
    : (typeof nginxManager?.withConfigLock === 'function' ? (task) => nginxManager.withConfigLock(task) : null);

  async function atomicWrite(targetPath, content, mode = 0o644) {
    const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFileFn(tmpPath, content, { encoding: 'utf8', mode });
      await renameFn(tmpPath, targetPath);
    } catch (error) {
      await rmFn(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function restoreBackup(previousContent) {
    if (previousContent === null) {
      await rmFn(configPath, { force: true });
      return;
    }
    await atomicWrite(configPath, previousContent, 0o644);
  }

  async function filterAppliedDomains(domains) {
    if (!Array.isArray(domains)) {
      throw new WebsiteTrafficEnforcerError('invalid_domains', 'domains must be an array');
    }
    const active = [];
    for (const domain of domains) {
      if (!domain || typeof domain !== 'object' || Array.isArray(domain)) continue;
      if (domain.applied === false) continue;
      const state = domain.state ?? domain.status ?? null;
      if (state !== 'active') continue;
      if (!domain.websiteId) continue;

      if (sitesDir && verifyActiveConfigFile !== false) {
        let configName;
        try {
          configName = `yunpanel-${nginxConfigFileName(domain.primaryDomain)}`;
        } catch {
          continue;
        }
        try {
          const st = await lstatFn(path.join(sitesDir, configName));
          if (!st.isFile() || st.isSymbolicLink()) continue;
        } catch {
          continue;
        }
      }
      active.push(domain);
    }
    return active;
  }

  async function reconcileCriticalSection({ domains = [], blockedWebsiteIds = [] } = {}) {
    const appliedDomains = await filterAppliedDomains(domains);
    const rendered = renderNginxTrafficAccountingConfig({
      domains: appliedDomains,
      blockedWebsiteIds,
      trafficLogPath,
      configPath,
      requireApplied: true,
    });

    let previousContent = null;
    try {
      previousContent = await readFileFn(rendered.path, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new WebsiteTrafficEnforcerError(
          'nginx_traffic_config_unreadable',
          'Mevcut Nginx trafik yapılandırması okunamadı.',
        );
      }
    }

    if (previousContent !== null && sha256(previousContent) === rendered.sha256 && previousContent === rendered.content) {
      return Object.freeze({
        changed: false,
        reloaded: false,
        path: rendered.path,
        sha256: rendered.sha256,
        trackedHostCount: rendered.trackedHostCount,
        trackedWebsiteIds: rendered.trackedWebsiteIds,
        blockedWebsiteIds: rendered.blockedWebsiteIds,
      });
    }

    await mkdirFn(path.dirname(rendered.path), { recursive: true, mode: 0o755 });
    await atomicWrite(rendered.path, rendered.content, 0o644);

    try {
      await execFn(nginxPath, ['-t']);
    } catch {
      await restoreBackup(previousContent).catch(() => {});
      throw new WebsiteTrafficEnforcerError(
        'nginx_traffic_config_validation_failed',
        'Nginx trafik yapılandırması doğrulanamadı; önceki yapılandırma geri yüklendi.',
      );
    }

    let reloaded = false;
    try {
      await execFn(systemctlPath, ['reload', 'nginx']);
      reloaded = true;
    } catch {
      try {
        await execFn(nginxPath, ['-s', 'reload']);
        reloaded = true;
      } catch {
        await restoreBackup(previousContent).catch(() => {});
        throw new WebsiteTrafficEnforcerError(
          'nginx_traffic_reload_failed',
          'Nginx trafik yapılandırması uygulanırken yeniden yükleme başarısız oldu; önceki yapılandırma geri yüklendi.',
        );
      }
    }

    return Object.freeze({
      changed: true,
      reloaded,
      path: rendered.path,
      sha256: rendered.sha256,
      trackedHostCount: rendered.trackedHostCount,
      trackedWebsiteIds: rendered.trackedWebsiteIds,
      blockedWebsiteIds: rendered.blockedWebsiteIds,
    });
  }

  function reconcile(input) {
    const execute = () => (lockFn ? lockFn(() => reconcileCriticalSection(input)) : reconcileCriticalSection(input));
    const run = reconcileChain.then(execute);
    reconcileChain = run.catch(() => {});
    return run;
  }

  return Object.freeze({ reconcile });
}
