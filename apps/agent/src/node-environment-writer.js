import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderNodeEnvironmentFile } from '@yunpanel/config-templates';

const ENV_ROOT = '/etc/yunpanel/apps';

export class NodeEnvironmentWriteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NodeEnvironmentWriteError';
    this.code = code;
  }
}

export function createNodeEnvironmentWriter({
  envRoot = ENV_ROOT,
  mkdirFn = mkdir,
  renameFn = rename,
  writeFileFn = writeFile,
} = {}) {
  async function writeEnvironment({ applicationId, runtime, environment = {} }) {
    let content;
    try {
      content = renderNodeEnvironmentFile({ applicationId, runtime, environment });
    } catch {
      throw new NodeEnvironmentWriteError('invalid_node_environment', 'Node application environment is invalid');
    }

    const targetPath = path.join(envRoot, `${applicationId}.env`);
    const temporaryPath = `${targetPath}.${process.pid}.tmp`;
    try {
      await mkdirFn(envRoot, { recursive: true, mode: 0o700 });
      await writeFileFn(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
      await renameFn(temporaryPath, targetPath);
    } catch {
      throw new NodeEnvironmentWriteError('node_environment_write_failed', 'Node environment file could not be written');
    }
    return { path: targetPath, bytes: Buffer.byteLength(content) };
  }

  return { writeEnvironment };
}

export const nodeEnvironmentWriter = createNodeEnvironmentWriter();
