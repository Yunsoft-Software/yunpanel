import { randomBytes } from 'node:crypto';
import { lstat, readlink, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { normalizePythonRollbackSpec } from '@yunpanel/shared';
import { createPythonSiteManager } from './python-site-manager.js';

const APP_ROOT = '/var/lib/yunpanel/apps';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PythonRollbackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PythonRollbackError';
    this.code = code;
  }
}

function isNotFound(error) {
  return error?.code === 'ENOENT';
}

function parseCurrentRelease(linkTarget) {
  if (typeof linkTarget !== 'string') return null;
  const match = linkTarget.match(/^releases\/([0-9a-f-]{36})$/i);
  return match && UUID_PATTERN.test(match[1]) ? match[1].toLowerCase() : null;
}

export function createPythonRollbackManager({
  appRoot = APP_ROOT,
  pythonSiteManager = createPythonSiteManager(),
  lstatFn = lstat,
  readlinkFn = readlink,
  renameFn = rename,
  rmFn = rm,
  symlinkFn = symlink,
} = {}) {
  const rollbackLocks = new Map();

  async function removeIfPresent(targetPath) {
    try {
      await rmFn(targetPath, { force: true });
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }

  async function switchCurrentLink(appDir, currentLink, targetReleaseId) {
    const tempLink = path.join(appDir, `current.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      await symlinkFn(`releases/${targetReleaseId}`, tempLink);
      await renameFn(tempLink, currentLink);
    } catch (error) {
      try {
        await removeIfPresent(tempLink);
      } catch {
        // Preserve original symlink/rename error.
      }
      throw error;
    }
  }

  async function rollbackPython(spec) {
    const {
      environment = null,
      environmentRevision: _environmentRevision,
      ...rawSpec
    } = spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : {};

    const normalized = normalizePythonRollbackSpec(rawSpec);
    const applicationId = normalized.applicationId;
    const targetReleaseId = normalized.releaseId;
    const currentReleaseId = normalized.currentReleaseId;

    if (targetReleaseId === currentReleaseId) {
      throw new PythonRollbackError('rollback_target_current', 'Requested rollback release is already active');
    }

    if (rollbackLocks.has(applicationId)) {
      throw new PythonRollbackError('application_job_conflict', 'Python rollback is already in progress');
    }
    rollbackLocks.set(applicationId, true);

    try {
      const appDir = path.join(appRoot, applicationId);
      const targetReleasePath = path.join(appDir, 'releases', targetReleaseId);
      const currentLink = path.join(appDir, 'current');

      let stats;
      try {
        stats = await lstatFn(targetReleasePath);
      } catch (error) {
        if (isNotFound(error)) {
          throw new PythonRollbackError('target_release_not_found', 'Target rollback release does not exist');
        }
        throw error;
      }
      if (!stats.isDirectory() || stats.isSymbolicLink?.()) {
        throw new PythonRollbackError('target_release_not_found', 'Target rollback release is not a real directory');
      }

      let observedCurrent = null;
      try {
        observedCurrent = parseCurrentRelease(await readlinkFn(currentLink));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      if (observedCurrent !== currentReleaseId) {
        throw new PythonRollbackError('python_rollback_release_drift', 'Managed Python current release does not match control-plane state');
      }

      await switchCurrentLink(appDir, currentLink, targetReleaseId);

      let restartResult;
      try {
        restartResult = await pythonSiteManager.restart({
          applicationId,
          releaseId: targetReleaseId,
          runtime: normalized.runtime,
          ...(environment && typeof environment === 'object' && !Array.isArray(environment) ? { environment } : {}),
        });
        if (!restartResult?.active || !restartResult?.healthy) {
          throw new Error('Python rollback target did not become healthy');
        }
      } catch (error) {
        try {
          await switchCurrentLink(appDir, currentLink, currentReleaseId);
          await pythonSiteManager.restart({
            applicationId,
            releaseId: currentReleaseId,
            runtime: normalized.runtime,
          });
        } catch {
          // Best-effort restore before surfacing rollback failure.
        }
        throw new PythonRollbackError('python_rollback_failed', `Failed to activate rollback release: ${error.message}`);
      }

      return Object.freeze({
        releaseId: targetReleaseId,
        previousReleaseId: currentReleaseId,
        serviceName: restartResult.serviceName,
        socketPath: restartResult.socketPath,
        port: normalized.runtime.port ?? null,
        healthPath: normalized.runtime.healthPath,
        active: true,
        healthy: true,
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
