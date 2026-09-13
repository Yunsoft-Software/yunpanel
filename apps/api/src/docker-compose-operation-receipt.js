import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OPERATIONS } from '@yunpanel/protocol';

const STORE_VERSION = 1;
const DEFAULT_ROOT = '/var/lib/yunpanel/recovery/docker-compose';
const ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OPERATIONS = new Map([
  [OPERATIONS.DOCKER_COMPOSE_BUILD, ['build', null]],
  [OPERATIONS.DOCKER_COMPOSE_PULL, ['pull', null]],
  [OPERATIONS.DOCKER_COMPOSE_START, ['start', 'running']],
  [OPERATIONS.DOCKER_COMPOSE_STOP, ['stop', 'stopped']],
  [OPERATIONS.DOCKER_COMPOSE_RESTART, ['restart', 'running']],
]);

export class DockerComposeOperationReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DockerComposeOperationReceiptError';
    this.code = code;
  }
}

function normalize(value) {
  const fields = new Set([
    'version', 'serverId', 'jobId', 'operation', 'projectId', 'projectRevision',
    'environmentRevision', 'composeSha256', 'action', 'runtimeState', 'executed', 'sideEffects',
  ]);
  const expected = OPERATIONS.get(value?.operation);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((key) => !fields.has(key))
    || value.version !== STORE_VERSION
    || typeof value.serverId !== 'string' || !UUID_PATTERN.test(value.serverId)
    || typeof value.jobId !== 'string' || !ID_PATTERN.test(value.jobId)
    || !expected || value.action !== expected[0] || value.runtimeState !== expected[1]
    || typeof value.projectId !== 'string' || !UUID_PATTERN.test(value.projectId)
    || !Number.isSafeInteger(value.projectRevision) || value.projectRevision < 1
    || !Number.isSafeInteger(value.environmentRevision) || value.environmentRevision < 0
    || typeof value.composeSha256 !== 'string' || !SHA256_PATTERN.test(value.composeSha256)
    || value.executed !== true || value.sideEffects !== true) {
    throw new DockerComposeOperationReceiptError('docker_compose_receipt_invalid', 'Docker Compose operation receipt is invalid');
  }
  return Object.freeze({ ...value });
}

export function createDockerComposeOperationReceiptStore({ root = DEFAULT_ROOT } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new DockerComposeOperationReceiptError('docker_compose_receipt_path_invalid', 'Docker Compose receipt root must be absolute');
  }

  function receiptPath(jobId) {
    if (typeof jobId !== 'string' || !ID_PATTERN.test(jobId)) {
      throw new DockerComposeOperationReceiptError('docker_compose_receipt_identity_invalid', 'Docker Compose receipt identity is invalid');
    }
    return path.join(root, `${jobId}.json`);
  }

  async function init() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const details = await lstat(root);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new DockerComposeOperationReceiptError('docker_compose_receipt_path_invalid', 'Docker Compose receipt root is unsafe');
    }
    await chmod(root, 0o700);
  }

  async function read(jobId) {
    await init();
    const target = receiptPath(jobId);
    try {
      const details = await lstat(target);
      if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o777) !== 0o600 || details.size > 64 * 1024) {
        throw new DockerComposeOperationReceiptError('docker_compose_receipt_invalid', 'Docker Compose operation receipt file is invalid');
      }
      return normalize(JSON.parse(await readFile(target, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof DockerComposeOperationReceiptError) throw error;
      throw new DockerComposeOperationReceiptError('docker_compose_receipt_invalid', 'Docker Compose operation receipt could not be read');
    }
  }

  async function write({ serverId, jobId, operation, result } = {}) {
    await init();
    const receipt = normalize({
      version: STORE_VERSION,
      serverId,
      jobId,
      operation,
      projectId: result?.projectId,
      projectRevision: result?.projectRevision,
      environmentRevision: result?.environmentRevision,
      composeSha256: result?.composeSha256,
      action: result?.action,
      runtimeState: result?.runtimeState ?? null,
      executed: result?.executed,
      sideEffects: result?.sideEffects,
    });
    const existing = await read(jobId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(receipt)) {
        throw new DockerComposeOperationReceiptError('docker_compose_receipt_conflict', 'Docker Compose receipt identity is already used for different evidence');
      }
      return existing;
    }
    const target = receiptPath(jobId);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await chmod(target, 0o600);
    return receipt;
  }

  return Object.freeze({ init, read, write });
}

export const dockerComposeOperationReceiptInternals = Object.freeze({
  defaultRoot: DEFAULT_ROOT,
  operations: OPERATIONS,
  normalize,
});
