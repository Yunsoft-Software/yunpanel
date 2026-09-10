import { lstat, readlink } from 'node:fs/promises';
import path from 'node:path';
import { createStaticDeploymentReceiptStore } from './static-deployment-receipt.js';

const DEFAULT_WEB_ROOT = '/var/www/yunpanel/apps';

export class StaticDeploymentEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StaticDeploymentEvidenceError';
    this.code = code;
  }
}

export function createStaticDeploymentEvidenceInspector({
  webRoot = DEFAULT_WEB_ROOT,
  receiptStore = createStaticDeploymentReceiptStore(),
  lstatFn = lstat,
  readlinkFn = readlink,
} = {}) {
  if (typeof webRoot !== 'string' || !path.isAbsolute(webRoot)) {
    throw new StaticDeploymentEvidenceError('invalid_static_evidence_root', 'Static deployment evidence web root must be absolute');
  }
  if (!receiptStore || typeof receiptStore.read !== 'function') {
    throw new StaticDeploymentEvidenceError('invalid_static_evidence_receipts', 'Static deployment evidence requires the receipt store');
  }

  async function inspect({ applicationId, deploymentId } = {}) {
    let receipt;
    try {
      receipt = await receiptStore.read(applicationId, deploymentId);
    } catch {
      throw new StaticDeploymentEvidenceError('static_deployment_evidence_read_failed', 'Static deployment recovery receipt could not be verified');
    }
    if (!receipt) return { satisfied: false, result: null };

    const applicationRoot = path.join(webRoot, receipt.applicationId);
    const currentPath = path.join(applicationRoot, 'current');
    const releasePath = path.join(applicationRoot, 'releases', receipt.deploymentId);
    let currentTarget;
    try {
      currentTarget = await readlinkFn(currentPath);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EINVAL') return { satisfied: false, result: null };
      throw new StaticDeploymentEvidenceError('static_deployment_evidence_read_failed', 'Static deployment current release could not be verified');
    }
    if (currentTarget !== path.join('releases', receipt.deploymentId)) {
      return { satisfied: false, result: null };
    }

    let releaseInfo;
    try {
      releaseInfo = await lstatFn(releasePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return { satisfied: false, result: null };
      throw new StaticDeploymentEvidenceError('static_deployment_evidence_read_failed', 'Static deployment release could not be verified');
    }
    if (!releaseInfo?.isDirectory?.() || releaseInfo.isSymbolicLink?.()) {
      return { satisfied: false, result: null };
    }

    return { satisfied: true, result: structuredClone(receipt.result) };
  }

  return Object.freeze({ inspect });
}

export const staticDeploymentEvidenceInternals = Object.freeze({
  defaultWebRoot: DEFAULT_WEB_ROOT,
});
