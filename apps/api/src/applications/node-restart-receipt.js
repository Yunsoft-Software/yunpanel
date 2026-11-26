import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 1;
const DEFAULT_ROOT = '/var/lib/yunpanel/recovery/node-restarts';
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SERVICE_PATTERN = /^yunpanel-node-[a-f0-9]{16}\.service$/;
const RECEIPT_KEYS = new Set(['version', 'recordedAt', 'serverId', 'jobId', 'applicationId', 'releaseId', 'serviceName', 'port', 'healthPath']);
const PASSENGER_KEYS = new Set(['version', 'recordedAt', 'serverId', 'jobId', 'applicationId', 'releaseId', 'runtimeAdapter', 'environmentRevision', 'port', 'healthPath']);

export class NodeRestartReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NodeRestartReceiptError';
    this.code = code;
  }
}

function uuid(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new NodeRestartReceiptError('node_restart_receipt_identity_invalid', `${label} identity is invalid`);
  }
  return value.toLowerCase();
}

function normalize(value) {
  const passenger = value?.version === 2 && value.runtimeAdapter === 'passenger';
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !(passenger ? PASSENGER_KEYS : RECEIPT_KEYS).has(key))
    || (!passenger && value.version !== STORE_VERSION)
    || typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt))
    || typeof value.serverId !== 'string' || !SERVER_ID_PATTERN.test(value.serverId)
    || (passenger ? value.port !== null || !Number.isSafeInteger(value.environmentRevision) || value.environmentRevision < 0
      : typeof value.serviceName !== 'string' || !SERVICE_PATTERN.test(value.serviceName)
        || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535)
    || typeof value.healthPath !== 'string' || !value.healthPath.startsWith('/') || value.healthPath.length > 2048
    || /[\u0000\r\n]/.test(value.healthPath)) {
    throw new NodeRestartReceiptError('node_restart_receipt_invalid', 'Node restart receipt metadata is invalid');
  }
  return Object.freeze({
    version: passenger ? 2 : STORE_VERSION,
    recordedAt: value.recordedAt,
    serverId: value.serverId,
    jobId: uuid(value.jobId, 'job'),
    applicationId: uuid(value.applicationId, 'application'),
    releaseId: uuid(value.releaseId, 'release'),
    ...(passenger ? {runtimeAdapter:'passenger',environmentRevision:value.environmentRevision} : {serviceName:value.serviceName}),
    port: value.port,
    healthPath: value.healthPath,
  });
}

export function createNodeRestartReceiptStore({ root = DEFAULT_ROOT, now = () => Date.now() } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof now !== 'function') {
    throw new NodeRestartReceiptError('node_restart_receipt_dependencies_invalid', 'Node restart receipt store configuration is invalid');
  }

  function receiptPath(serverId, jobId) {
    if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)) {
      throw new NodeRestartReceiptError('node_restart_receipt_identity_invalid', 'Server identity is invalid');
    }
    return path.join(root, serverId, `${uuid(jobId, 'job')}.json`);
  }

  async function write({ serverId, jobId, applicationId, result }) {
    if (!result || result.healthy !== true || result.restarted !== true) {
      throw new NodeRestartReceiptError('node_restart_receipt_result_invalid', 'Node restart result is not safe recovery evidence');
    }
    const passenger = result.runtimeAdapter === 'passenger';
    if (passenger && result.applicationId !== applicationId) throw new NodeRestartReceiptError('node_restart_receipt_result_invalid', 'Passenger application identity does not match restart evidence');
    const receipt = normalize({
      version: passenger ? 2 : STORE_VERSION,
      recordedAt: new Date(now()).toISOString(),
      serverId,
      jobId,
      applicationId,
      releaseId: result.releaseId,
      ...(passenger ? {runtimeAdapter:'passenger',environmentRevision:result.environmentRevision} : {serviceName:result.serviceName}),
      port: result.port,
      healthPath: result.healthPath,
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
      throw new NodeRestartReceiptError('node_restart_receipt_read_failed', 'Node restart receipt could not be read');
    }
    return normalize(parsed);
  }

  return Object.freeze({ write, read, receiptPath });
}

export const nodeRestartReceiptInternals = Object.freeze({ storeVersion: STORE_VERSION, defaultRoot: DEFAULT_ROOT, normalize });
