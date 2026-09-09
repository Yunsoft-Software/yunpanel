import path from 'node:path';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class LocalRuntimeConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalRuntimeConfigError';
    this.code = code;
  }
}

function normalizeServerId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim())) {
    throw new LocalRuntimeConfigError('invalid_local_server_id', 'YUNPANEL_LOCAL_SERVER_ID must be an enrolled server UUID');
  }
  return value.trim().toLowerCase();
}

function normalizeHostname(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 253) {
    throw new LocalRuntimeConfigError('invalid_local_hostname', 'Operating-system hostname is invalid for local runtime binding');
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalized)) {
    throw new LocalRuntimeConfigError('invalid_local_hostname', 'Operating-system hostname is invalid for local runtime binding');
  }
  return normalized;
}

function resolveLockPath(jobStorePath) {
  if (typeof jobStorePath !== 'string' || !jobStorePath.trim()) {
    throw new LocalRuntimeConfigError('invalid_job_store_path', 'Job store path is required for the local executor lock');
  }
  return path.resolve(path.dirname(jobStorePath), 'local-executor.lock');
}

export function resolveLocalRuntimeConfig({ env = process.env, hostname, jobStorePath } = {}) {
  const configuredId = typeof env?.YUNPANEL_LOCAL_SERVER_ID === 'string' ? env.YUNPANEL_LOCAL_SERVER_ID.trim() : '';
  if (!configuredId) return Object.freeze({ enabled: false });
  return Object.freeze({
    enabled: true,
    serverId: normalizeServerId(configuredId),
    hostname: normalizeHostname(hostname),
    lockPath: resolveLockPath(jobStorePath),
  });
}

export const localRuntimeConfigInternals = Object.freeze({ normalizeServerId, normalizeHostname, resolveLockPath });
