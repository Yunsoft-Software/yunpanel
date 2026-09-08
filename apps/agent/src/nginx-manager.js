import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  nginxConfigFileName,
  renderProxySiteConfig,
  renderStaticSiteConfig,
} from '@yunpanel/config-templates';

const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

export class NginxManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NginxManagerError';
    this.code = code;
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function execFileSafe(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) return reject(error);
      return resolve(stdout);
    });
  });
}

function configNameForDomain(primaryDomain) {
  return `yunpanel-${nginxConfigFileName(primaryDomain)}`;
}

function renderDomainConfig(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new NginxManagerError('invalid_domain_spec', 'Domain spec must be an object');
  }

  const common = {
    primaryDomain: spec.primaryDomain,
    aliases: spec.aliases ?? [],
  };

  if (spec.targetType === 'static') {
    return renderStaticSiteConfig({
      ...common,
      root: spec.target?.root,
      spaFallback: spec.target?.spaFallback !== false,
    });
  }

  if (spec.targetType === 'proxy') {
    return renderProxySiteConfig({
      ...common,
      upstreamHost: spec.target?.upstreamHost ?? '127.0.0.1',
      upstreamPort: spec.target?.upstreamPort,
      websocket: spec.target?.websocket !== false,
    });
  }

  throw new NginxManagerError('invalid_target_type', 'Domain targetType must be static or proxy');
}

export function createNginxManager({
  stagingDir = '/var/lib/yunpanel/staging/nginx',
  sitesDir = '/etc/nginx/sites-enabled',
  nginxPath = '/usr/sbin/nginx',
  systemctlPath = '/usr/bin/systemctl',
  mkdirFn = mkdir,
  readFileFn = readFile,
  writeFileFn = writeFile,
  renameFn = rename,
  rmFn = rm,
  execFn = execFileSafe,
} = {}) {
  let activationChain = Promise.resolve();

  async function atomicWrite(targetPath, content, mode) {
    const temporaryPath = `${targetPath}.${process.pid}.tmp`;
    await writeFileFn(temporaryPath, content, { encoding: 'utf8', mode });
    await renameFn(temporaryPath, targetPath);
  }

  async function stageDomain(spec) {
    const config = renderDomainConfig(spec);
    const configName = configNameForDomain(spec.primaryDomain);
    const stagePath = path.join(stagingDir, configName);

    await mkdirFn(stagingDir, { recursive: true, mode: 0o750 });
    await atomicWrite(stagePath, config, 0o640);

    return {
      configName,
      checksum: sha256(config),
      bytes: Buffer.byteLength(config),
    };
  }

  async function restoreActive(activePath, previousContent) {
    if (previousContent == null) {
      await rmFn(activePath, { force: true });
      return;
    }
    await atomicWrite(activePath, previousContent, 0o644);
  }

  async function activateNow({ primaryDomain, checksum }) {
    if (typeof checksum !== 'string' || !CHECKSUM_PATTERN.test(checksum)) {
      throw new NginxManagerError('invalid_checksum', 'A SHA-256 staging checksum is required');
    }

    const configName = configNameForDomain(primaryDomain);
    const stagePath = path.join(stagingDir, configName);
    const activePath = path.join(sitesDir, configName);

    let candidate;
    try {
      candidate = await readFileFn(stagePath, 'utf8');
    } catch {
      throw new NginxManagerError('staged_config_missing', 'Staged Nginx configuration was not found');
    }

    if (sha256(candidate) !== checksum) {
      throw new NginxManagerError('staged_config_changed', 'Staged Nginx configuration checksum does not match');
    }

    let previousContent = null;
    try {
      previousContent = await readFileFn(activePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    await mkdirFn(sitesDir, { recursive: true, mode: 0o755 });
    await atomicWrite(activePath, candidate, 0o644);

    try {
      await execFn(nginxPath, ['-t']);
    } catch {
      await restoreActive(activePath, previousContent);
      throw new NginxManagerError('nginx_config_invalid', 'Nginx rejected the staged configuration');
    }

    try {
      await execFn(systemctlPath, ['reload', 'nginx']);
    } catch {
      await restoreActive(activePath, previousContent);
      try {
        await execFn(nginxPath, ['-t']);
        await execFn(systemctlPath, ['reload', 'nginx']);
      } catch {
        throw new NginxManagerError('nginx_rollback_failed', 'Nginx reload failed and rollback could not be confirmed');
      }
      throw new NginxManagerError('nginx_reload_failed', 'Nginx reload failed and the previous configuration was restored');
    }

    return {
      configName,
      checksum,
      active: true,
    };
  }

  function activateDomain(input) {
    const run = activationChain.catch(() => {}).then(() => activateNow(input));
    activationChain = run;
    return run;
  }

  return {
    stageDomain,
    activateDomain,
  };
}

export const nginxManager = createNginxManager();
