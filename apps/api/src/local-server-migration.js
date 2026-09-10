const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_JOB_STATUSES = new Set(['queued', 'running']);

export class LocalServerMigrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalServerMigrationError';
    this.code = code;
  }
}

function normalizeServerId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim())) {
    throw new LocalServerMigrationError('invalid_local_server_id', 'Local server id must be an enrolled server UUID');
  }
  return value.trim().toLowerCase();
}

function normalizeHostname(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 253) {
    throw new LocalServerMigrationError('invalid_local_hostname', 'Local server hostname is invalid');
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalized)) {
    throw new LocalServerMigrationError('invalid_local_hostname', 'Local server hostname is invalid');
  }
  return normalized;
}

function validateDependencies({ registry, jobRegistry, serviceStatus }) {
  if (!registry || typeof registry.getServer !== 'function' || typeof registry.bindLocalServer !== 'function' || typeof registry.releaseLocalServer !== 'function') {
    throw new LocalServerMigrationError('local_migration_registry_invalid', 'Local server migration requires the server registry');
  }
  if (!jobRegistry || typeof jobRegistry.listJobs !== 'function') {
    throw new LocalServerMigrationError('local_migration_jobs_invalid', 'Local server migration requires the job registry');
  }
  if (typeof serviceStatus !== 'function') {
    throw new LocalServerMigrationError('local_migration_service_status_invalid', 'Local server migration requires service status inspection');
  }
}

async function inspectPreflight({ serverId, hostname, registry, jobRegistry, serviceStatus }) {
  validateDependencies({ registry, jobRegistry, serviceStatus });
  const normalizedId = normalizeServerId(serverId);
  const normalizedHostname = normalizeHostname(hostname);
  const server = await registry.getServer(normalizedId);
  if (!server) throw new LocalServerMigrationError('local_server_not_found', 'Configured server record was not found');
  if (String(server.hostname ?? '').toLowerCase() !== normalizedHostname) {
    throw new LocalServerMigrationError('local_server_hostname_mismatch', 'Server registry hostname does not match this host');
  }

  const [jobs, units] = await Promise.all([
    jobRegistry.listJobs({ serverId: normalizedId }),
    serviceStatus(),
  ]);
  if (!Array.isArray(jobs)) throw new LocalServerMigrationError('local_migration_jobs_invalid', 'Job registry returned an invalid result');
  if (!units || typeof units !== 'object' || Array.isArray(units)) {
    throw new LocalServerMigrationError('local_migration_service_status_invalid', 'Service status inspection returned an invalid result');
  }

  const activeJobs = jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job?.status));
  return {
    serverId: normalizedId,
    hostname: normalizedHostname,
    server,
    activeJobs,
    apiActive: units.apiActive === true,
    agentActive: units.agentActive === true,
  };
}

function assertMutationSafe(preflight) {
  if (preflight.apiActive) {
    throw new LocalServerMigrationError('local_migration_api_active', 'Stop yunpanel-api.service before changing local server ownership');
  }
  if (preflight.agentActive) {
    throw new LocalServerMigrationError('local_migration_agent_active', 'Stop yun-agent.service before changing local server ownership');
  }
  if (preflight.activeJobs.length > 0) {
    throw new LocalServerMigrationError('local_migration_jobs_active', 'Queued or running jobs must be drained or cancelled before changing local server ownership');
  }
}

export async function inspectLocalServerMigration(input = {}) {
  const preflight = await inspectPreflight(input);
  return Object.freeze({
    serverId: preflight.serverId,
    hostname: preflight.hostname,
    executionMode: preflight.server.executionMode,
    localBoundAt: preflight.server.localBoundAt ?? null,
    apiActive: preflight.apiActive,
    agentActive: preflight.agentActive,
    activeJobCount: preflight.activeJobs.length,
  });
}

export async function bindLocalServerForRuntime(input = {}) {
  const preflight = await inspectPreflight(input);
  assertMutationSafe(preflight);
  if (preflight.server.executionMode === 'local') return preflight.server;
  return input.registry.bindLocalServer({ serverId: preflight.serverId, hostname: preflight.hostname });
}

export async function releaseLocalServerFromRuntime(input = {}) {
  const preflight = await inspectPreflight(input);
  assertMutationSafe(preflight);
  if (preflight.server.executionMode !== 'local') {
    throw new LocalServerMigrationError('local_server_not_bound', 'Server is not assigned to the local runtime');
  }
  return input.registry.releaseLocalServer({ serverId: preflight.serverId, hostname: preflight.hostname });
}

export const localServerMigrationInternals = Object.freeze({ normalizeServerId, normalizeHostname, assertMutationSafe });
