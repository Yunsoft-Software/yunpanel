import { chmod, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { renderNetdataConfig, netdataTemplatePolicy } from '@yunpanel/config-templates';

export class NetdataManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NetdataManagerError';
    this.code = code;
  }
}

export function createNetdataManager({
  configPath = netdataTemplatePolicy.configPath,
  defaultPort = netdataTemplatePolicy.defaultPort,
  bindAddress = netdataTemplatePolicy.bindAddress,
  readFileFn = readFile,
  writeFileFn = writeFile,
  renameFn = rename,
  chmodFn = chmod,
  rmFn = rm,
  statFn = stat,
} = {}) {
  async function atomicWrite(targetPath, content, mode = 0o644) {
    const tempPath = `${targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFileFn(tempPath, content, { encoding: 'utf8', mode });
      await chmodFn(tempPath, mode);
      await renameFn(tempPath, targetPath);
    } catch (error) {
      try { await rmFn(tempPath, { force: true }); } catch {}
      throw error;
    }
  }

  async function configureLoopback({
    port = defaultPort,
    address = bindAddress,
    runAsUser = netdataTemplatePolicy.runAsUser,
  } = {}) {
    const content = renderNetdataConfig({ bindAddress: address, port, runAsUser });
    try {
      await atomicWrite(configPath, content, netdataTemplatePolicy.configMode);
      return Object.freeze({
        configured: true,
        configPath,
        bindAddress: address,
        port,
      });
    } catch (error) {
      throw new NetdataManagerError(
        'netdata_config_write_failed',
        `Failed to write Netdata configuration: ${error.message}`,
      );
    }
  }

  async function inspectConfiguration() {
    try {
      const stats = await statFn(configPath);
      if (!stats.isFile()) {
        return Object.freeze({ exists: false, isLoopbackOnly: false });
      }
      const content = await readFileFn(configPath, 'utf8');
      const bindMatch = content.match(/^\s*bind to\s*=\s*(.+)$/m);
      const portMatch = content.match(/^\s*default port\s*=\s*(\d+)$/m);
      const boundAddress = bindMatch ? bindMatch[1].trim() : null;
      const port = portMatch ? Number.parseInt(portMatch[1], 10) : defaultPort;
      const isLoopbackOnly = boundAddress === '127.0.0.1' || boundAddress === '::1';

      return Object.freeze({
        exists: true,
        bindAddress: boundAddress,
        port,
        isLoopbackOnly,
      });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return Object.freeze({ exists: false, isLoopbackOnly: false });
      }
      throw new NetdataManagerError(
        'netdata_inspect_failed',
        `Failed to inspect Netdata configuration: ${error.message}`,
      );
    }
  }

  return Object.freeze({
    configureLoopback,
    inspectConfiguration,
    configPath,
  });
}
