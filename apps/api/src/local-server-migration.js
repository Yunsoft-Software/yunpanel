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

function validateDependencies({ registry, jobRegistry, serviceStatus, create = false }) {
  const requiredRegistryMethods = create
    ? ['createLocalServer']
    : ['getServer', 'bindLocalServer', 'releaseLocalServer'];
  if (!registry || requiredRegistryMethods.some((method) => typeof registry[method] !== 'function')) {
    throw new LocalServerMigrationError('local_migration_registry_invalid', 'Local server migration requires the server registry');
  }
  if (!jobRegistry || typeof jobRegistry.listJobs !== 'function') {
    throw new LocalServerMigrationError('local_migration_jobs_invalid', 'Local server migration requires the job registry');
  }
  if (jobRegistry.recovery !== undefined && typeof jobRegistry.recovery !== 'function') {
    throw new LocalServerMigrationError('local_migration_jobs_invalid', 'Job registry recovery inspection is invalid');
  }
  if (typeof serviceStatus !== 'function') {
    throw new LocalServerMigrationError('local_migration_service_status_invalid', 'Local server migration requires service status inspection');
  }
}

function inspectRecovery(jobRegistry) {
  if (typeof jobRegistry.recovery !== 'function') return [];
  let recovery;
  try {
    recovery = jobRegistry.recovery();
  } catch {
    throw new LocalServerMigrationError('local_migration_recovery_invalid', 'Durable job recovery state could not be inspected');
  }
  if (recovery == null) return [];
  if (!recovery || typeof recovery !== 'object' || !Array.isArray(recovery.jobs)) {
    throw new LocalServerMigrationError('local_migration_recovery_invalid', 'Durable job recovery state is invalid');
  }
  if (recovery.jobs.some((job) => !job || typeof job !== 'object' || typeof job.jobId !== 'string' || typeof job.serverId !== 'string')) {
    throw new LocalServerMigrationError('local_migration_recovery_invalid', 'Durable job recovery state is invalid');
  }
  return recovery.jobs.map((job) => ({ jobId: job.jobId, serverId: job.serverId }));
}

function inspectServiceStates(units) {
  const states = units?.states;
  if (!states || typeof states !== 'object' || Array.isArray(states)
    || typeof states.api !== 'string' || typeof states.agent !== 'string') return null;
  return Object.freeze({ api: states.api, agent: states.agent });
}

async function inspectConsumersAndJobs({ jobRegistry, serviceStatus, serverId = null }) {
  const [jobs, units] = await Promise.all([
    jobRegistry.listJobs(serverId ? { serverId } : {}),
    serviceStatus(),
  ]);
  if (!Array.isArray(jobs)) throw new LocalServerMigrationError('local_migration_jobs_invalid', 'Job registry returned an invalid result');
  if (!units || typeof units !== 'object' || Array.isArray(units)) {
    throw new LocalServerMigrationError('local_migration_service_status_invalid', 'Service status inspection returned an invalid result');
  }
  const recoveryJobs = inspectRecovery(jobRegistry)
    .filter((job) => !serverId || job.serverId === serverId);
  return {
    activeJobs: jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job?.status)),
    recoveryJobs,
    apiActive: units.apiActive === true,
    agentActive: units.agentActive === true,
    serviceStates: inspectServiceStates(units),
  };
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

  const runtimeState = await inspectConsumersAndJobs({ jobRegistry, serviceStatus, serverId: normalizedId });
  return {
    serverId: normalizedId,
    hostname: normalizedHostname,
    server,
    ...runtimeState,
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
  if (preflight.recoveryJobs.length > 0) {
    throw new LocalServerMigrationError('local_migration_recovery_pending', 'Durable job recovery must be resolved before changing local server ownership');
  }
}

function isSnapshotObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertPostMigrationHealthy(preflight) {
  const { server } = preflight;
  if (server.executionMode !== 'local') {
    throw new LocalServerMigrationError('local_validation_not_bound', 'Server is not assigned to the local runtime');
  }
  if (typeof server.localBoundAt !== 'string' || !Number.isFinite(Date.parse(server.localBoundAt))) {
    throw new LocalServerMigrationError('local_validation_binding_invalid', 'Local runtime binding metadata is incomplete');
  }
  if (!preflight.serviceStates || preflight.serviceStates.api !== 'active') {
    throw new LocalServerMigrationError('local_validation_api_not_active', 'yunpanel-api.service must be active after local migration');
  }
  if (preflight.serviceStates.agent !== 'inactive') {
    throw new LocalServerMigrationError('local_validation_agent_not_inactive', 'yun-agent.service must be inactive after local migration');
  }
  if (preflight.activeJobs.length > 0) {
    throw new LocalServerMigrationError('local_validation_jobs_active', 'Post-migration validation requires an idle local queue');
  }
  if (preflight.recoveryJobs.length > 0) {
    throw new LocalServerMigrationError('local_validation_recovery_pending', 'Post-migration validation requires clear durable recovery state');
  }
  if (server.connectivity !== 'online' || typeof server.lastSeenAt !== 'string' || !Number.isFinite(Date.parse(server.lastSeenAt))) {
    throw new LocalServerMigrationError('local_validation_snapshot_stale', 'Local runtime snapshot is missing or stale');
  }
  if (typeof server.localRuntimeVersion !== 'string' || server.localRuntimeVersion.length < 1 || server.localRuntimeVersion.length > 40
    || /[\u0000-\u001f\u007f]/.test(server.localRuntimeVersion)) {
    throw new LocalServerMigrationError('local_validation_runtime_version_invalid', 'Local runtime version snapshot is missing or invalid');
  }
  if (!isSnapshotObject(server.inventory)
    || normalizeHostname(server.inventory.hostname) !== preflight.hostname
    || server.inventory.mode !== 'local') {
    throw new LocalServerMigrationError('local_validation_inventory_invalid', 'Local host inventory snapshot does not match this runtime');
  }
  if (!isSnapshotObject(server.services)) {
    throw new LocalServerMigrationError('local_validation_services_invalid', 'Local service snapshot is missing or invalid');
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
    recoveryJobCount: preflight.recoveryJobs.length,
  });
}

export async function validateLocalServerRuntime(input = {}) {
  const preflight = await inspectPreflight(input);
  assertPostMigrationHealthy(preflight);
  return Object.freeze({
    validated: true,
    serverId: preflight.serverId,
    hostname: preflight.hostname,
    executionMode: preflight.server.executionMode,
    localBoundAt: preflight.server.localBoundAt,
    connectivity: preflight.server.connectivity,
    lastSeenAt: preflight.server.lastSeenAt,
    localRuntimeVersion: preflight.server.localRuntimeVersion,
    apiState: preflight.serviceStates.api,
    agentState: preflight.serviceStates.agent,
    activeJobCount: preflight.activeJobs.length,
    recoveryJobCount: preflight.recoveryJobs.length,
    inventoryPresent: true,
    servicesPresent: true,
  });
}

export async function createLocalServerForRuntime({ hostname, displayName = null, registry, jobRegistry, serviceStatus } = {}) {
  validateDependencies({ registry, jobRegistry, serviceStatus, create: true });
  const normalizedHostname = normalizeHostname(hostname);
  const runtimeState = await inspectConsumersAndJobs({ jobRegistry, serviceStatus });
  assertMutationSafe(runtimeState);
  return registry.createLocalServer({ hostname: normalizedHostname, displayName });
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

export const localServerMigrationInternals = Object.freeze({
  normalizeServerId,
  normalizeHostname,
  inspectRecovery,
  inspectServiceStates,
  inspectConsumersAndJobs,
  assertMutationSafe,
  assertPostMigrationHealthy,
});
