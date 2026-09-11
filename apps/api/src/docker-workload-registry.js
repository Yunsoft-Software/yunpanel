import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid, normalizeProxyHost } from '@yunpanel/shared';

const STORE_VERSION = 1;
const MANAGEMENT_MODE = 'external';
const WORKLOAD_STATES = new Set(['unverified', 'running', 'stopped', 'degraded']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9_:-]{0,119}$/;

export class DockerWorkloadRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DockerWorkloadRegistryError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch { throw new DockerWorkloadRegistryError(`invalid_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`, `${field} must be a UUID`); }
}

function workloadName(value) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new DockerWorkloadRegistryError('invalid_docker_workload_name', 'Docker workload name must be a printable string up to 120 characters');
  }
  return value.trim();
}

function proxyTarget(value) {
  const allowed = new Set(['host', 'port', 'websocket']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== allowed.size || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new DockerWorkloadRegistryError('invalid_docker_proxy_target', 'Docker proxy target must contain host, port and websocket');
  }
  let host;
  try { host = normalizeProxyHost(value.host); }
  catch { throw new DockerWorkloadRegistryError('invalid_docker_proxy_host', 'Docker proxy host must be a loopback host'); }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new DockerWorkloadRegistryError('invalid_docker_proxy_host', 'Docker proxy host must be a loopback host');
  }
  if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) {
    throw new DockerWorkloadRegistryError('invalid_docker_proxy_port', 'Docker proxy port must be between 1024 and 65535');
  }
  if (typeof value.websocket !== 'boolean') {
    throw new DockerWorkloadRegistryError('invalid_docker_proxy_websocket', 'Docker proxy websocket must be a boolean');
  }
  return Object.freeze({ host, port: value.port, websocket: value.websocket });
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new DockerWorkloadRegistryError('docker_workload_state_invalid', 'Docker workload timestamp is invalid', 409);
  }
  return new Date(value).toISOString();
}

function errorCode(value, state) {
  if (state === 'degraded') {
    if (typeof value !== 'string' || !ERROR_CODE_PATTERN.test(value)) {
      throw new DockerWorkloadRegistryError('invalid_docker_error_code', 'Degraded Docker state requires a bounded authored error code');
    }
    return value;
  }
  if (value !== null && value !== undefined) {
    throw new DockerWorkloadRegistryError('invalid_docker_error_code', 'Only degraded Docker state accepts an error code');
  }
  return null;
}

function publicWorkload(workload) {
  return Object.freeze({ ...workload, proxyTarget: Object.freeze({ ...workload.proxyTarget }) });
}

function validatePersisted(value) {
  const fields = new Set([
    'id', 'serverId', 'name', 'managementMode', 'state', 'proxyTarget', 'revision',
    'lastObservedAt', 'lastErrorCode', 'createdAt', 'updatedAt',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((key) => !fields.has(key))
    || value.managementMode !== MANAGEMENT_MODE || !WORKLOAD_STATES.has(value.state)
    || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new DockerWorkloadRegistryError('docker_workload_state_invalid', 'Docker workload state is invalid', 409);
  }
  const lastObservedAt = value.lastObservedAt === null ? null : timestamp(value.lastObservedAt);
  if ((value.state === 'unverified') !== (lastObservedAt === null)) {
    throw new DockerWorkloadRegistryError('docker_workload_state_invalid', 'Docker workload observation state is inconsistent', 409);
  }
  return {
    id: uuid(value.id, 'dockerWorkloadId'),
    serverId: uuid(value.serverId, 'serverId'),
    name: workloadName(value.name),
    managementMode: MANAGEMENT_MODE,
    state: value.state,
    proxyTarget: proxyTarget(value.proxyTarget),
    revision: value.revision,
    lastObservedAt,
    lastErrorCode: errorCode(value.lastErrorCode, value.state),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  };
}

function sameTarget(left, right) {
  return left.host === right.host && left.port === right.port && left.websocket === right.websocket;
}

export function createDockerWorkloadRegistry({
  filePath = null,
  now = () => Date.now(),
  serverExists = async () => true,
} = {}) {
  if (typeof now !== 'function' || typeof serverExists !== 'function') {
    throw new DockerWorkloadRegistryError('docker_workload_dependencies_invalid', 'Docker workload registry dependencies are invalid', 503);
  }
  let state = { version: STORE_VERSION, workloads: [] };
  let initialized = false;
  let writeChain = Promise.resolve();

  async function persist() {
    if (!filePath) return;
    const snapshot = JSON.stringify(state, null, 2);
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, filePath);
    });
    return writeChain;
  }

  async function requireServer(serverId, { persisted = false } = {}) {
    const id = uuid(serverId, 'serverId');
    let exists;
    try { exists = await serverExists(id); }
    catch { throw new DockerWorkloadRegistryError('docker_server_reference_unavailable', 'Docker workload server reference could not be verified', 503); }
    if (!exists) throw new DockerWorkloadRegistryError('docker_server_not_found', 'Docker workload server does not exist', persisted ? 409 : 404);
    return id;
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.workloads)
          || Object.keys(parsed).length !== 2 || Object.keys(parsed).some((key) => !['version', 'workloads'].includes(key))) {
          throw new DockerWorkloadRegistryError('docker_workload_state_invalid', 'Docker workload store is invalid', 409);
        }
        const workloads = parsed.workloads.map(validatePersisted);
        const ids = new Set();
        const endpoints = new Set();
        for (const workload of workloads) {
          const endpoint = `${workload.serverId}:${workload.proxyTarget.host}:${workload.proxyTarget.port}`;
          if (ids.has(workload.id) || endpoints.has(endpoint)) {
            throw new DockerWorkloadRegistryError('docker_workload_state_invalid', 'Docker workload identities and endpoints must be unique', 409);
          }
          ids.add(workload.id);
          endpoints.add(endpoint);
          await requireServer(workload.serverId, { persisted: true });
        }
        state = { version: STORE_VERSION, workloads };
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  async function createWorkload({ workloadId = null, serverId, name, managementMode, proxyTarget: target } = {}) {
    await ensureInitialized();
    if (managementMode !== MANAGEMENT_MODE) {
      throw new DockerWorkloadRegistryError('docker_management_mode_unsupported', 'Only explicit external Docker workload tracking is implemented', 409);
    }
    const id = workloadId === null ? randomUUID() : uuid(workloadId, 'dockerWorkloadId');
    const normalizedServerId = await requireServer(serverId);
    const normalizedName = workloadName(name);
    const normalizedTarget = proxyTarget(target);
    const existing = state.workloads.find((workload) => workload.id === id) ?? null;
    if (existing) {
      if (workloadId === null || existing.serverId !== normalizedServerId || existing.name !== normalizedName
        || existing.managementMode !== MANAGEMENT_MODE || !sameTarget(existing.proxyTarget, normalizedTarget)
        || existing.revision !== 1 || existing.state !== 'unverified') {
        throw new DockerWorkloadRegistryError('docker_workload_identity_conflict', 'Docker workload identity conflicts with existing state', 409);
      }
      return publicWorkload(existing);
    }
    if (state.workloads.some((workload) => workload.serverId === normalizedServerId
      && workload.proxyTarget.host === normalizedTarget.host && workload.proxyTarget.port === normalizedTarget.port)) {
      throw new DockerWorkloadRegistryError('docker_proxy_endpoint_conflict', 'Docker workload proxy endpoint is already tracked', 409);
    }
    const current = new Date(now()).toISOString();
    const workload = {
      id,
      serverId: normalizedServerId,
      name: normalizedName,
      managementMode: MANAGEMENT_MODE,
      state: 'unverified',
      proxyTarget: normalizedTarget,
      revision: 1,
      lastObservedAt: null,
      lastErrorCode: null,
      createdAt: current,
      updatedAt: current,
    };
    state.workloads.push(workload);
    await persist();
    return publicWorkload(workload);
  }

  async function recordObservation(workloadId, { expectedRevision, state: nextState, errorCode: requestedErrorCode = null } = {}) {
    await ensureInitialized();
    const id = uuid(workloadId, 'dockerWorkloadId');
    const workload = state.workloads.find((candidate) => candidate.id === id);
    if (!workload) throw new DockerWorkloadRegistryError('docker_workload_not_found', 'Docker workload was not found', 404);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new DockerWorkloadRegistryError('invalid_docker_workload_revision', 'A positive expected revision is required');
    }
    if (workload.revision !== expectedRevision) {
      throw new DockerWorkloadRegistryError('docker_workload_revision_conflict', 'Docker workload changed before observation', 409);
    }
    if (!WORKLOAD_STATES.has(nextState) || nextState === 'unverified') {
      throw new DockerWorkloadRegistryError('invalid_docker_workload_state', 'Observed Docker workload state must be running, stopped or degraded');
    }
    const current = new Date(now()).toISOString();
    workload.state = nextState;
    workload.revision += 1;
    workload.lastObservedAt = current;
    workload.lastErrorCode = errorCode(requestedErrorCode, nextState);
    workload.updatedAt = current;
    await persist();
    return publicWorkload(workload);
  }

  async function getWorkload(workloadId) {
    await ensureInitialized();
    const id = uuid(workloadId, 'dockerWorkloadId');
    const workload = state.workloads.find((candidate) => candidate.id === id);
    return workload ? publicWorkload(workload) : null;
  }

  async function listWorkloads({ serverId = null } = {}) {
    await ensureInitialized();
    const normalizedServerId = serverId === null ? null : uuid(serverId, 'serverId');
    return state.workloads
      .filter((workload) => normalizedServerId === null || workload.serverId === normalizedServerId)
      .map(publicWorkload);
  }

  return Object.freeze({ init, createWorkload, recordObservation, getWorkload, listWorkloads });
}

export const dockerWorkloadRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  managementMode: MANAGEMENT_MODE,
  proxyTarget,
  validatePersisted,
});
