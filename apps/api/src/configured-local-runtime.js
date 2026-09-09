import { createLocalHostOperations } from './local-host-operations.js';
import { resolveLocalRuntimeConfig } from './local-runtime-config.js';
import { startLocalRuntime } from './local-runtime.js';

export class ConfiguredLocalRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConfiguredLocalRuntimeError';
    this.code = code;
  }
}

export async function startConfiguredLocalRuntime({
  env = process.env,
  hostname,
  jobStorePath,
  runtimeVersion,
  registry,
  jobRegistry,
  domainRegistry,
  certificateRegistry,
  applicationRegistry,
  applicationEnvironmentRegistry,
  createOperations = createLocalHostOperations,
  startRuntime = startLocalRuntime,
  onError = () => {},
} = {}) {
  const config = resolveLocalRuntimeConfig({ env, hostname, jobStorePath });
  if (!config.enabled) return null;
  if (!applicationEnvironmentRegistry || typeof applicationEnvironmentRegistry.materialize !== 'function') {
    throw new ConfiguredLocalRuntimeError('local_environment_registry_invalid', 'Local runtime requires the application environment registry');
  }
  if (typeof createOperations !== 'function' || typeof startRuntime !== 'function' || typeof onError !== 'function') {
    throw new ConfiguredLocalRuntimeError('local_runtime_startup_adapter_invalid', 'Local runtime startup adapters are invalid');
  }

  const hostOperations = createOperations({
    loadApplicationEnvironment: (applicationId) => applicationEnvironmentRegistry.materialize(applicationId),
  });

  return startRuntime({
    serverId: config.serverId,
    hostname: config.hostname,
    runtimeVersion,
    lockPath: config.lockPath,
    registry,
    jobRegistry,
    domainRegistry,
    certificateRegistry,
    applicationRegistry,
    hostOperations,
    onError,
  });
}
