import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OPERATIONS } from '@yunpanel/protocol';

const STORE_VERSION = 1;
const DEFAULT_ROOT = '/var/lib/yunpanel/recovery/docker-volumes';
const ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const VOLUME_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const VOLUME_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PHASES = new Set(['intent', 'completed']);

export class DockerVolumeOperationReceiptError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'DockerVolumeOperationReceiptError';
    this.code = code;
    this.status = status;
  }
}

function sameIdentity(left, right) {
  return left.serverId === right.serverId
    && left.jobId === right.jobId
    && left.operation === right.operation
    && left.projectId === right.projectId
    && left.projectName === right.projectName
    && left.projectRevision === right.projectRevision
    && left.composeSha256 === right.composeSha256
    && left.volumeKey === right.volumeKey
    && left.volumeName === right.volumeName
    && left.volumeFingerprint === right.volumeFingerprint
    && left.previewDigest === right.previewDigest;
}

function normalize(value) {
  const fields = new Set([
    'version',
    'phase',
    'serverId',
    'jobId',
    'operation',
    'projectId',
    'projectName',
    'projectRevision',
    'composeSha256',
    'volumeKey',
    'volumeName',
    'volumeFingerprint',
    'previewDigest',
    'deleted',
    'sideEffects',
  ]);
  const phase = value?.phase;
  const expectedDeleted = phase === 'completed';
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((key) => !fields.has(key))
    || value.version !== STORE_VERSION
    || !PHASES.has(phase)
    || typeof value.serverId !== 'string' || !UUID_PATTERN.test(value.serverId)
    || typeof value.jobId !== 'string' || !ID_PATTERN.test(value.jobId)
    || value.operation !== OPERATIONS.DOCKER_VOLUME_DELETE
    || typeof value.projectId !== 'string' || !UUID_PATTERN.test(value.projectId)
    || typeof value.projectName !== 'string' || !PROJECT_NAME_PATTERN.test(value.projectName)
    || !Number.isSafeInteger(value.projectRevision) || value.projectRevision < 1
    || typeof value.composeSha256 !== 'string' || !SHA256_PATTERN.test(value.composeSha256)
    || typeof value.volumeKey !== 'string' || !VOLUME_KEY_PATTERN.test(value.volumeKey)
    || typeof value.volumeName !== 'string' || !VOLUME_NAME_PATTERN.test(value.volumeName)
    || value.volumeName !== `${value.projectName}_${value.volumeKey}`
    || typeof value.volumeFingerprint !== 'string' || !SHA256_PATTERN.test(value.volumeFingerprint)
    || typeof value.previewDigest !== 'string' || !SHA256_PATTERN.test(value.previewDigest)
    || value.deleted !== expectedDeleted
    || value.sideEffects !== expectedDeleted) {
    throw new DockerVolumeOperationReceiptError('docker_volume_receipt_invalid', 'Docker volume operation receipt is invalid');
  }
  return Object.freeze({ ...value });
}

export function createDockerVolumeOperationReceiptStore({ root = DEFAULT_ROOT } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new DockerVolumeOperationReceiptError('docker_volume_receipt_path_invalid', 'Docker volume receipt root must be absolute', 500);
  }

  function receiptPath(jobId) {
    if (typeof jobId !== 'string' || !ID_PATTERN.test(jobId)) {
      throw new DockerVolumeOperationReceiptError('docker_volume_receipt_identity_invalid', 'Docker volume receipt identity is invalid', 400);
    }
    return path.join(root, `${jobId}.json`);
  }

  async function init() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const details = await lstat(root);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new DockerVolumeOperationReceiptError('docker_volume_receipt_path_invalid', 'Docker volume receipt root is unsafe', 500);
    }
    await chmod(root, 0o700);
  }

  async function writeAtomic(jobId, receipt) {
    const target = receiptPath(jobId);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await chmod(target, 0o600);
    return receipt;
  }

  async function read(jobId) {
    await init();
    const target = receiptPath(jobId);
    try {
      const details = await lstat(target);
      if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o777) !== 0o600 || details.size > 64 * 1024) {
        throw new DockerVolumeOperationReceiptError('docker_volume_receipt_invalid', 'Docker volume operation receipt file is invalid');
      }
      return normalize(JSON.parse(await readFile(target, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof DockerVolumeOperationReceiptError) throw error;
      throw new DockerVolumeOperationReceiptError('docker_volume_receipt_invalid', 'Docker volume operation receipt could not be read');
    }
  }

  // Persists durable pre-delete intent before invoking `docker volume rm`.
  // Refuses blind replay if a prior intent already exists for this job.
  async function writeIntent({ serverId, jobId, operation, intent } = {}) {
    await init();
    const receipt = normalize({
      version: STORE_VERSION,
      phase: 'intent',
      serverId,
      jobId,
      operation,
      projectId: intent?.projectId,
      projectName: intent?.projectName,
      projectRevision: intent?.projectRevision,
      composeSha256: intent?.composeSha256,
      volumeKey: intent?.volumeKey,
      volumeName: intent?.volumeName,
      volumeFingerprint: intent?.volumeFingerprint,
      previewDigest: intent?.previewDigest,
      deleted: false,
      sideEffects: false,
    });
    const existing = await read(jobId);
    if (existing) {
      if (!sameIdentity(existing, receipt)) {
        throw new DockerVolumeOperationReceiptError('docker_volume_receipt_conflict', 'Docker volume receipt identity is already used for different evidence', 409);
      }
      if (existing.phase === 'completed') {
        throw new DockerVolumeOperationReceiptError('docker_volume_delete_already_completed', 'Docker volume deletion receipt is already completed for this job', 409);
      }
      throw new DockerVolumeOperationReceiptError(
        'docker_volume_delete_recovery_required',
        'A prior Docker volume deletion intent was interrupted before verification; inspect before retrying',
        409,
      );
    }
    return writeAtomic(jobId, receipt);
  }

  // Promotes an exact matching pre-delete intent (or fresh write) to completed after absence verification.
  async function writeCompleted({ serverId, jobId, operation, result } = {}) {
    await init();
    const receipt = normalize({
      version: STORE_VERSION,
      phase: 'completed',
      serverId,
      jobId,
      operation,
      projectId: result?.projectId,
      projectName: result?.projectName,
      projectRevision: result?.projectRevision,
      composeSha256: result?.composeSha256,
      volumeKey: result?.volumeKey,
      volumeName: result?.volumeName,
      volumeFingerprint: result?.volumeFingerprint,
      previewDigest: result?.previewDigest,
      deleted: result?.deleted,
      sideEffects: result?.sideEffects,
    });
    const existing = await read(jobId);
    if (existing) {
      if (!sameIdentity(existing, receipt)) {
        throw new DockerVolumeOperationReceiptError('docker_volume_receipt_conflict', 'Docker volume receipt identity is already used for different evidence', 409);
      }
      if (existing.phase === 'completed') {
        return existing;
      }
    }
    return writeAtomic(jobId, receipt);
  }

  return Object.freeze({
    init,
    read,
    writeIntent,
    writeCompleted,
    write: writeCompleted,
  });
}

export const dockerVolumeOperationReceiptInternals = Object.freeze({
  defaultRoot: DEFAULT_ROOT,
  normalize,
  sameIdentity,
});
