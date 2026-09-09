import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  readFileFn = readFile,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
} = {}) {
  async function atomicReplace(targetPath, content) {
    const temporaryPath = `${targetPath}.${process.pid}.tmp`;
    await rmFn(temporaryPath, { force: true }).catch(() => {});
    try {
      await writeFileFn(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
      await renameFn(temporaryPath, targetPath);
    } finally {
      await rmFn(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async function writeEnvironment({ applicationId, runtime, environment = {} }) {
    let content;
    try {
      content = renderNodeEnvironmentFile({ applicationId, runtime, environment });
    } catch {
      throw new NodeEnvironmentWriteError('invalid_node_environment', 'Node application environment is invalid');
    }

    const targetPath = path.join(envRoot, `${applicationId}.env`);
    let previousContent = null;
    let previousExists = false;

    try {
      await mkdirFn(envRoot, { recursive: true, mode: 0o700 });
      try {
        previousContent = await readFileFn(targetPath, 'utf8');
        previousExists = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw new NodeEnvironmentWriteError('node_environment_snapshot_failed', 'Existing Node environment file could not be read safely');
        }
      }
      await atomicReplace(targetPath, content);
    } catch (error) {
      if (error instanceof NodeEnvironmentWriteError) throw error;
      throw new NodeEnvironmentWriteError('node_environment_write_failed', 'Node environment file could not be written');
    }

    let finished = false;
    async function restore() {
      if (finished) return;
      try {
        if (previousExists) await atomicReplace(targetPath, previousContent);
        else await rmFn(targetPath, { force: true });
        finished = true;
        previousContent = null;
      } catch {
        throw new NodeEnvironmentWriteError('node_environment_restore_failed', 'Previous Node environment file could not be restored');
      }
    }

    function commit() {
      finished = true;
      previousContent = null;
    }

    return {
      path: targetPath,
      bytes: Buffer.byteLength(content),
      previousExists,
      restore,
      commit,
    };
  }

  return { writeEnvironment };
}

export const nodeEnvironmentWriter = createNodeEnvironmentWriter();
