import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OPERATIONS } from '@yunpanel/protocol';

const STORE_VERSION = 1;
const DEFAULT_ROOT = '/var/lib/yunpanel/recovery/python-operations';
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const SERVICE_PATTERN = /^yunpanel-python-[a-f0-9]{16}\.service$/;
const PYTHON_RECEIPT_OPERATIONS = new Set([OPERATIONS.APP_PYTHON_DEPLOY, OPERATIONS.APP_PYTHON_ROLLBACK, OPERATIONS.APP_PYTHON_RESTART]);
const RECEIPT_KEYS = new Set([
  'version', 'recordedAt', 'serverId', 'jobId', 'operation', 'applicationId', 'releaseId', 'previousReleaseId',
  'commitSha', 'serviceName', 'socketPath', 'port', 'healthPath',
]);

export class PythonOperationReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PythonOperationReceiptError';
    this.code = code;
  }
}

function invalid() {
  return new PythonOperationReceiptError('python_operation_receipt_invalid', 'Python operation receipt metadata is invalid');
}

function uuid(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw invalid();
  return value.toLowerCase();
}

function nullableUuid(value) {
  return value == null ? null : uuid(value);
}

function nullablePath(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 2048 || /[\u0000\r\n]/.test(value)) throw invalid();
  return value;
}

function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !RECEIPT_KEYS.has(key))
    || value.version !== STORE_VERSION
    || typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt))
    || typeof value.serverId !== 'string' || !SERVER_ID_PATTERN.test(value.serverId)
    || !PYTHON_RECEIPT_OPERATIONS.has(value.operation)
    || typeof value.serviceName !== 'string' || !SERVICE_PATTERN.test(value.serviceName)
    || (value.port != null && (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535))) {
    throw invalid();
  }
  const jobId = uuid(value.jobId);
  const releaseId = uuid(value.releaseId);
  const previousReleaseId = nullableUuid(value.previousReleaseId);
  const commitSha = value.commitSha == null ? null : value.commitSha;
  if (commitSha !== null && (typeof commitSha !== 'string' || !COMMIT_PATTERN.test(commitSha))) throw invalid();
  if (value.operation === OPERATIONS.APP_PYTHON_DEPLOY && (releaseId !== jobId || commitSha === null)) throw invalid();
  if (value.operation === OPERATIONS.APP_PYTHON_ROLLBACK && (previousReleaseId === null || previousReleaseId === releaseId)) throw invalid();
  return Object.freeze({
    version: STORE_VERSION,
    recordedAt: value.recordedAt,
    serverId: value.serverId,
    jobId,
    operation: value.operation,
    applicationId: uuid(value.applicationId),
    releaseId,
    previousReleaseId,
    commitSha: commitSha?.toLowerCase() ?? null,
    serviceName: value.serviceName,
    socketPath: nullablePath(value.socketPath),
    port: value.port ?? null,
    healthPath: nullablePath(value.healthPath),
  });
}

/**
 * Private, secret-free evidence that a Python deploy, rollback or restart
 * finished healthy on the host. Operator recovery reads it while the API is
 * stopped; it never replaces the durable job result.
 */
export function createPythonOperationReceiptStore({ root = DEFAULT_ROOT, now = () => Date.now() } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof now !== 'function') {
    throw new PythonOperationReceiptError('python_operation_receipt_dependencies_invalid', 'Python operation receipt store configuration is invalid');
  }

  function receiptPath(serverId, jobId) {
    if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)) {
      throw new PythonOperationReceiptError('python_operation_receipt_identity_invalid', 'Server identity is invalid');
    }
    let id;
    try { id = uuid(jobId); }
    catch { throw new PythonOperationReceiptError('python_operation_receipt_identity_invalid', 'Job identity is invalid'); }
    return path.join(root, serverId, `${id}.json`);
  }

  async function write({ serverId, jobId, operation, applicationId, result }) {
    if (!result || result.healthy !== true) {
      throw new PythonOperationReceiptError('python_operation_receipt_result_invalid', 'Python operation result is not safe recovery evidence');
    }
    const receipt = normalize({
      version: STORE_VERSION,
      recordedAt: new Date(now()).toISOString(),
      serverId,
      jobId,
      operation,
      applicationId,
      releaseId: result.releaseId,
      previousReleaseId: result.previousReleaseId ?? null,
      commitSha: result.commitSha ?? null,
      serviceName: result.serviceName,
      socketPath: result.socketPath ?? null,
      port: result.port ?? null,
      healthPath: result.healthPath ?? null,
    });
    const directory = path.join(root, receipt.serverId);
    const target = receiptPath(receipt.serverId, receipt.jobId);
    const temporary = `${target}.${process.pid}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await chmod(directory, 0o700);
    await writeFile(temporary, JSON.stringify(receipt), { encoding: 'utf8', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await chmod(target, 0o600);
    return receipt;
  }

  async function read(serverId, jobId) {
    const target = receiptPath(serverId, jobId);
    let parsed;
    try {
      parsed = JSON.parse(await readFile(target, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new PythonOperationReceiptError('python_operation_receipt_read_failed', 'Python operation receipt could not be read');
    }
    return normalize(parsed);
  }

  return Object.freeze({ write, read, receiptPath });
}

export const pythonOperationReceiptInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  defaultRoot: DEFAULT_ROOT,
  operations: PYTHON_RECEIPT_OPERATIONS,
  normalize,
});
