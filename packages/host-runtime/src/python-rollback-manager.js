import { randomBytes } from 'node:crypto';
import { lstat, readlink, rename, symlink } from 'node:fs/promises';
import path from 'node:path';
import { normalizePythonRollbackSpec } from '@yunpanel/shared';
import { createPythonSiteManager } from './python-site-manager.js';

const APP_ROOT = '/var/lib/yunpanel/apps';

export class PythonRollbackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PythonRollbackError';
    this.code = code;
  }
}

export function createPythonRollbackManager({
  appRoot = APP_ROOT,
  pythonSiteManager = createPythonSiteManager(),
  lstatFn = lstat,
  readlinkFn = readlink,
  renameFn = rename,
  symlinkFn = symlink,
} = {}) {
  const rollbackLocks = new Map();

  async function rollbackPython(spec) {
    const normalized = normalizePythonRollbackSpec(spec);
    const applicationId = normalized.applicationId;
    const targetReleaseId = normalized.releaseId;

    if (rollbackLocks.has(applicationId)) {
      throw new PythonRollbackError('application_job_conflict', 'Python rollback is already in progress');
    }
    rollbackLocks.set(applicationId, true);

    try {
      const appDir = path.join(appRoot, applicationId);
      const targetReleasePath = path.join(appDir, 'releases', targetReleaseId);
      const currentLink = path.join(appDir, 'current');

      try {
        const stats = await lstatFn(targetReleasePath);
        if (!stats.isDirectory()) {
          throw new Error('not a directory');
        }
      } catch {
        throw new PythonRollbackError('target_release_not_found', 'Target rollback release does not exist');
      }

      // Atomic switch of current symlink
      const tempLink = path.join(appDir, `current.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
      await symlinkFn(`releases/${targetReleaseId}`, tempLink);
      await renameFn(tempLink, currentLink);

      // Restart service
      const restartResult = await pythonSiteManager.restart({
        applicationId,
        releaseId: targetReleaseId,
      });

      return Object.freeze({
        releaseId: targetReleaseId,
        serviceName: restartResult.serviceName,
        socketPath: restartResult.socketPath,
        active: restartResult.active,
        healthy: restartResult.healthy,
        rolledBack: true,
      });
    } finally {
      rollbackLocks.delete(applicationId);
    }
  }

  return Object.freeze({
    rollbackPython,
  });
}
