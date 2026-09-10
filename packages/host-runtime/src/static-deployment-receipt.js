import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 1;
const DEFAULT_ROOT = '/var/lib/yunpanel/recovery/static-deployments';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const RECEIPT_KEYS = Object.freeze([
  'version', 'recordedAt', 'applicationId', 'deploymentId', 'result',
]);
const RESULT_KEYS = Object.freeze([
  'deploymentId', 'releaseId', 'commitSha', 'previousReleaseId', 'artifactFiles', 'artifactBytes',
]);

export class StaticDeploymentReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StaticDeploymentReceiptError';
    this.code = code;
  }
}

function normalizeUuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new StaticDeploymentReceiptError('invalid_static_receipt_identity', `${label} is invalid`);
  }
  return value.toLowerCase();
}

function normalizeResult(value, deploymentId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !RESULT_KEYS.includes(key))) {
    throw new StaticDeploymentReceiptError('invalid_static_receipt_result', 'Static deployment receipt result is invalid');
  }
  const resultDeploymentId = normalizeUuid(value.deploymentId, 'deploymentId');
  const releaseId = normalizeUuid(value.releaseId, 'releaseId');
  if (resultDeploymentId !== deploymentId || releaseId !== deploymentId) {
    throw new StaticDeploymentReceiptError('invalid_static_receipt_result', 'Static deployment receipt result identity does not match');
  }
  const commitSha = typeof value.commitSha === 'string' && COMMIT_PATTERN.test(value.commitSha)
    ? value.commitSha.toLowerCase()
    : null;
  if (!commitSha) throw new StaticDeploymentReceiptError('invalid_static_receipt_result', 'Static deployment receipt commit is invalid');

  let previousReleaseId = null;
  if (value.previousReleaseId != null) {
    previousReleaseId = normalizeUuid(value.previousReleaseId, 'previousReleaseId');
    if (previousReleaseId === deploymentId) {
      throw new StaticDeploymentReceiptError('invalid_static_receipt_result', 'Static deployment receipt previous release is invalid');
    }
  }
  if (!Number.isSafeInteger(value.artifactFiles) || value.artifactFiles < 1
    || !Number.isSafeInteger(value.artifactBytes) || value.artifactBytes < 0) {
    throw new StaticDeploymentReceiptError('invalid_static_receipt_result', 'Static deployment receipt artifact metadata is invalid');
  }

  return {
    deploymentId,
    releaseId: deploymentId,
    commitSha,
    previousReleaseId,
    artifactFiles: value.artifactFiles,
    artifactBytes: value.artifactBytes,
  };
}

function normalizeReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== STORE_VERSION
    || Object.keys(value).some((key) => !RECEIPT_KEYS.includes(key))) {
    throw new StaticDeploymentReceiptError('invalid_static_receipt', 'Static deployment receipt is invalid');
  }
  const applicationId = normalizeUuid(value.applicationId, 'applicationId');
  const deploymentId = normalizeUuid(value.deploymentId, 'deploymentId');
  const recordedAt = typeof value.recordedAt === 'string' && Number.isFinite(Date.parse(value.recordedAt))
    ? value.recordedAt
    : null;
  if (!recordedAt) throw new StaticDeploymentReceiptError('invalid_static_receipt', 'Static deployment receipt timestamp is invalid');
  return {
    version: STORE_VERSION,
    recordedAt,
    applicationId,
    deploymentId,
    result: normalizeResult(value.result, deploymentId),
  };
}

export function createStaticDeploymentReceiptStore({
  root = DEFAULT_ROOT,
  now = () => Date.now(),
  chmodFn = chmod,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  writeFileFn = writeFile,
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new StaticDeploymentReceiptError('invalid_static_receipt_root', 'Static deployment receipt root must be absolute');
  }

  function receiptPath(applicationId, deploymentId) {
    const appId = normalizeUuid(applicationId, 'applicationId');
    const deployId = normalizeUuid(deploymentId, 'deploymentId');
    return path.join(root, appId, `${deployId}.json`);
  }

  async function write({ applicationId, deploymentId, result }) {
    const appId = normalizeUuid(applicationId, 'applicationId');
    const deployId = normalizeUuid(deploymentId, 'deploymentId');
    const receipt = normalizeReceipt({
      version: STORE_VERSION,
      recordedAt: new Date(now()).toISOString(),
      applicationId: appId,
      deploymentId: deployId,
      result,
    });
    const directory = path.join(root, appId);
    const target = receiptPath(appId, deployId);
    const temporary = `${target}.${process.pid}.tmp`;
    await mkdirFn(root, { recursive: true, mode: 0o700 });
    await chmodFn(root, 0o700);
    await mkdirFn(directory, { recursive: true, mode: 0o700 });
    await chmodFn(directory, 0o700);
    await writeFileFn(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await renameFn(temporary, target);
    return structuredClone(receipt);
  }

  async function read(applicationId, deploymentId) {
    const target = receiptPath(applicationId, deploymentId);
    let raw;
    try {
      raw = await readFileFn(target, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new StaticDeploymentReceiptError('static_receipt_read_failed', 'Static deployment receipt could not be read');
    }
    try {
      return normalizeReceipt(JSON.parse(raw));
    } catch (error) {
      if (error instanceof StaticDeploymentReceiptError) throw error;
      throw new StaticDeploymentReceiptError('invalid_static_receipt', 'Static deployment receipt is invalid');
    }
  }

  return Object.freeze({ write, read, receiptPath });
}

export const staticDeploymentReceiptInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  defaultRoot: DEFAULT_ROOT,
  normalizeUuid,
  normalizeResult,
  normalizeReceipt,
});
