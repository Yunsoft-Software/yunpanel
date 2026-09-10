import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { checkLocalApiHealth, LocalApiHealthError } from './local-api-health.js';
import { createDurableJobRegistry } from './durable-job-registry.js';
import { createJobRegistry } from './job-registry.js';
import {
  bindLocalServerForRuntime,
  createLocalServerForRuntime,
  inspectLocalServerMigration,
  releaseLocalServerFromRuntime,
  validateLocalServerRuntime,
} from './local-server-migration.js';
import { createServerRegistry } from './server-registry.js';

const execFileAsync = promisify(execFile);
const SYSTEMCTL = '/usr/bin/systemctl';
const PACKAGED_STATE_ROOT = '/var/lib/yunpanel/control-plane';
const PANEL_UNITS = Object.freeze({
  api: 'yunpanel-api.service',
  agent: 'yun-agent.service',
});
const STOPPED_STATES = new Set(['inactive', 'failed']);
const KNOWN_STATES = new Set(['active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading', 'maintenance']);

export class LocalMigrationCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalMigrationCliError';
    this.code = code;
  }
}

export function createMigrationJobRegistry({ filePath } = {}) {
  return createDurableJobRegistry({ filePath, registryFactory: createJobRegistry });
}

function resolveStorePath(value, fallback, { packaged, cwd }) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string' || /[\u0000\r\n]/.test(value)) {
    throw new LocalMigrationCliError('invalid_migration_state_path', 'Migration state path is invalid');
  }
  if (packaged && !path.isAbsolute(value)) {
    throw new LocalMigrationCliError('packaged_state_path_must_be_absolute', 'Packaged migration state paths must be absolute');
  }
  return path.resolve(cwd, value);
}

export function resolveLocalMigrationPaths({ env = process.env, packaged = false, cwd = process.cwd() } = {}) {
  const defaultRoot = packaged ? PACKAGED_STATE_ROOT : path.resolve(cwd, '.data');
  const serverStore = resolveStorePath(env.YUNPANEL_SERVER_STORE, path.join(defaultRoot, 'server-registry.json'), { packaged, cwd });
  const jobStore = resolveStorePath(env.YUNPANEL_JOB_STORE, path.join(defaultRoot, 'job-registry.json'), { packaged, cwd });
  if (packaged) {
    const allowedRoot = `${PACKAGED_STATE_ROOT}${path.sep}`;
    for (const [label, value] of [['server', serverStore], ['job', jobStore]]) {
      if (value !== PACKAGED_STATE_ROOT && !value.startsWith(allowedRoot)) {
        throw new LocalMigrationCliError('packaged_state_path_outside_control_plane', `Packaged ${label} state must stay under ${PACKAGED_STATE_ROOT}`);
      }
    }
  }
  return Object.freeze({ serverStore, jobStore });
}

async function inspectUnitState(unit, run) {
  let stdout;
  try {
    ({ stdout } = await run(SYSTEMCTL, ['show', unit, '--property=ActiveState', '--value', '--no-pager'], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 16 * 1024,
    }));
  } catch {
    throw new LocalMigrationCliError('migration_service_status_unavailable', `Could not inspect ${unit}`);
  }
  const state = String(stdout ?? '').trim();
  if (!KNOWN_STATES.has(state)) {
    throw new LocalMigrationCliError('migration_service_status_invalid', `Unexpected systemd state for ${unit}`);
  }
  return { unit, state, active: !STOPPED_STATES.has(state) };
}

export function createMigrationServiceStatus({
  run = (file, args, options) => execFileAsync(file, args, options),
} = {}) {
  if (typeof run !== 'function') throw new LocalMigrationCliError('invalid_migration_runner', 'Migration service runner is invalid');
  return async () => {
    const [api, agent] = await Promise.all([
      inspectUnitState(PANEL_UNITS.api, run),
      inspectUnitState(PANEL_UNITS.agent, run),
    ]);
    return { apiActive: api.active, agentActive: agent.active, states: { api: api.state, agent: agent.state } };
  };
}

function requireAction(action) {
  if (!['status', 'validate', 'create', 'bind', 'release'].includes(action)) {
    throw new LocalMigrationCliError('invalid_migration_action', 'Migration action must be status, validate, create, bind or release');
  }
  return action;
}

function normalizeHealthResult(result) {
  if (!result || result.healthy !== true || result.statusCode !== 200
    || typeof result.host !== 'string' || !Number.isInteger(result.port)) {
    throw new LocalMigrationCliError('local_validation_api_health_invalid', 'Local API health probe returned an invalid acknowledgement');
  }
  return Object.freeze({ healthy: true, statusCode: 200 });
}

export async function runLocalMigrationCommand({
  action,
  serverId,
  hostname,
  displayName = null,
  confirm = false,
  env = process.env,
  packaged = false,
  cwd = process.cwd(),
  registryFactory = createServerRegistry,
  jobRegistryFactory = createMigrationJobRegistry,
  serviceStatus = createMigrationServiceStatus(),
  apiHealthCheck = checkLocalApiHealth,
} = {}) {
  const safeAction = requireAction(action);
  if (!['status', 'validate'].includes(safeAction) && confirm !== true) {
    throw new LocalMigrationCliError('migration_confirmation_required', `Use --confirm to ${safeAction} local runtime ownership`);
  }
  if (typeof registryFactory !== 'function' || typeof jobRegistryFactory !== 'function' || typeof serviceStatus !== 'function'
    || typeof apiHealthCheck !== 'function') {
    throw new LocalMigrationCliError('invalid_migration_dependencies', 'Migration command dependencies are invalid');
  }
  const paths = resolveLocalMigrationPaths({ env, packaged, cwd });
  const registry = registryFactory({ filePath: paths.serverStore });
  const jobRegistry = jobRegistryFactory({ filePath: paths.jobStore });
  const input = { serverId, hostname, displayName, registry, jobRegistry, serviceStatus };

  if (safeAction === 'status') {
    const status = await inspectLocalServerMigration(input);
    return Object.freeze({ action: safeAction, ...status, statePaths: paths });
  }
  if (safeAction === 'validate') {
    const validation = await validateLocalServerRuntime(input);
    let apiHealth;
    try {
      apiHealth = normalizeHealthResult(await apiHealthCheck({ env }));
    } catch (error) {
      if (error instanceof LocalApiHealthError || error instanceof LocalMigrationCliError) throw error;
      throw new LocalMigrationCliError('local_validation_api_health_failed', 'Local API health validation could not be completed');
    }
    return Object.freeze({ action: safeAction, ...validation, apiHealth, statePaths: paths });
  }

  let server;
  if (safeAction === 'create') server = await createLocalServerForRuntime(input);
  else if (safeAction === 'bind') server = await bindLocalServerForRuntime(input);
  else server = await releaseLocalServerFromRuntime(input);

  return Object.freeze({
    action: safeAction,
    serverId: server.id,
    hostname: server.hostname,
    executionMode: server.executionMode,
    localBoundAt: server.localBoundAt ?? null,
    statePaths: paths,
  });
}

export const localMigrationCliInternals = Object.freeze({
  systemctlPath: SYSTEMCTL,
  packagedStateRoot: PACKAGED_STATE_ROOT,
  panelUnits: PANEL_UNITS,
  inspectUnitState,
  normalizeHealthResult,
});
