import { lstat, mkdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';

const WEB_ROOT = '/var/www/yunpanel/apps';

export class StaticRollbackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StaticRollbackError';
    this.code = code;
  }
}

function parseCurrentRelease(linkTarget) {
  if (typeof linkTarget !== 'string') return null;
  const match = linkTarget.match(/^releases\/([0-9a-f-]{36})$/i);
  if (!match) return null;
  try {
    return assertUuid(match[1], 'current release');
  } catch {
    return null;
  }
}

export function createStaticRollbackManager({
  webRoot = WEB_ROOT,
  lstatFn = lstat,
  mkdirFn = mkdir,
  readlinkFn = readlink,
  renameFn = rename,
  rmFn = rm,
  symlinkFn = symlink,
} = {}) {
  async function rollbackStatic({ applicationId, releaseId }) {
    let appId;
    let targetReleaseId;
    try {
      appId = assertUuid(applicationId, 'applicationId');
      targetReleaseId = assertUuid(releaseId, 'releaseId');
    } catch {
      throw new StaticRollbackError('invalid_rollback_target', 'Static rollback target is invalid');
    }

    const appRoot = path.join(webRoot, appId);
    const releasesRoot = path.join(appRoot, 'releases');
    const targetPath = path.join(releasesRoot, targetReleaseId);
    const currentPath = path.join(appRoot, 'current');
    const temporaryPath = path.join(appRoot, `.rollback-${targetReleaseId}`);

    let targetInfo;
    try {
      targetInfo = await lstatFn(targetPath);
    } catch {
      throw new StaticRollbackError('rollback_release_missing', 'Rollback release does not exist on the managed server');
    }
    if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
      throw new StaticRollbackError('rollback_release_invalid', 'Rollback release must be a real directory');
    }

    let previousReleaseId = null;
    try {
      previousReleaseId = parseCurrentRelease(await readlinkFn(currentPath));
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'EINVAL') throw error;
    }

    if (previousReleaseId === targetReleaseId) {
      throw new StaticRollbackError('rollback_target_current', 'Requested rollback release is already active');
    }

    await mkdirFn(appRoot, { recursive: true, mode: 0o755 });
    await rmFn(temporaryPath, { force: true });
    await symlinkFn(path.join('releases', targetReleaseId), temporaryPath);
    await renameFn(temporaryPath, currentPath);

    return {
      releaseId: targetReleaseId,
      previousReleaseId,
      active: true,
    };
  }

  return { rollbackStatic };
}

export const staticRollbackManager = createStaticRollbackManager();
