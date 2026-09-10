import { lstat, readlink } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';

const WEB_ROOT = '/var/www/yunpanel/apps';

export class StaticRollbackEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StaticRollbackEvidenceError';
    this.code = code;
  }
}

function normalizeIdentity({ applicationId, releaseId, currentReleaseId }) {
  try {
    const appId = assertUuid(applicationId, 'applicationId');
    const targetReleaseId = assertUuid(releaseId, 'releaseId');
    const previousReleaseId = assertUuid(currentReleaseId, 'currentReleaseId');
    if (targetReleaseId === previousReleaseId) throw new Error('same release');
    return { applicationId: appId, releaseId: targetReleaseId, previousReleaseId };
  } catch {
    throw new StaticRollbackEvidenceError('static_rollback_evidence_identity_invalid', 'Static rollback recovery identity is invalid');
  }
}

async function realDirectory(lstatFn, filePath) {
  try {
    const info = await lstatFn(filePath);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw new StaticRollbackEvidenceError('static_rollback_evidence_read_failed', 'Static rollback recovery evidence could not be inspected');
  }
}

export function createStaticRollbackEvidenceInspector({
  webRoot = WEB_ROOT,
  lstatFn = lstat,
  readlinkFn = readlink,
} = {}) {
  if (typeof webRoot !== 'string' || !path.isAbsolute(webRoot)
    || typeof lstatFn !== 'function' || typeof readlinkFn !== 'function') {
    throw new StaticRollbackEvidenceError('static_rollback_evidence_dependencies_invalid', 'Static rollback evidence inspector configuration is invalid');
  }

  async function inspect(input) {
    const identity = normalizeIdentity(input ?? {});
    const appRoot = path.join(webRoot, identity.applicationId);
    const releasesRoot = path.join(appRoot, 'releases');
    const targetPath = path.join(releasesRoot, identity.releaseId);
    const previousPath = path.join(releasesRoot, identity.previousReleaseId);

    if (!(await realDirectory(lstatFn, targetPath)) || !(await realDirectory(lstatFn, previousPath))) {
      return Object.freeze({ satisfied: false, result: null });
    }

    let current;
    try {
      current = await readlinkFn(path.join(appRoot, 'current'));
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EINVAL') {
        return Object.freeze({ satisfied: false, result: null });
      }
      throw new StaticRollbackEvidenceError('static_rollback_evidence_read_failed', 'Static rollback recovery evidence could not be inspected');
    }

    if (current !== path.join('releases', identity.releaseId)) {
      return Object.freeze({ satisfied: false, result: null });
    }

    return Object.freeze({
      satisfied: true,
      result: Object.freeze({
        releaseId: identity.releaseId,
        previousReleaseId: identity.previousReleaseId,
        active: true,
      }),
    });
  }

  return Object.freeze({ inspect });
}

export const staticRollbackEvidenceInternals = Object.freeze({
  webRoot: WEB_ROOT,
  normalizeIdentity,
  realDirectory,
});
