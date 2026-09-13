import path from 'node:path';
import { createDockerComposeObserver, createDockerComposeValidator } from '@yunpanel/host-runtime';
import { DOCKER_COMPOSE_OPERATIONS } from '@yunpanel/protocol';
import { createDockerComposeEnvironmentRegistry } from './docker-compose-environment-registry.js';
import { createDockerComposeMaterializer } from './docker-compose-materializer.js';
import { createDockerComposeOperationReceiptStore } from './docker-compose-operation-receipt.js';
import { createDockerComposeOperationsService } from './docker-compose-operations.js';
import { createDockerComposeProjectRegistry } from './docker-compose-project-registry.js';
import { createDockerComposeRecoveryService } from './docker-compose-recovery.js';
import { createDockerRegistryCredentialRegistry } from './docker-registry-credential-registry.js';
import { createLocalDockerComposeOperation } from './local-docker-compose-operation.js';

const DOCKER_OPERATION_SET = new Set(DOCKER_COMPOSE_OPERATIONS);

export class DockerComposeRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DockerComposeRuntimeError';
    this.code = code;
  }
}

function storePaths(env) {
  return Object.freeze({
    projects: env.YUNPANEL_DOCKER_COMPOSE_PROJECT_STORE
      ?? path.resolve('.data/docker-compose-project-registry.json'),
    environments: env.YUNPANEL_DOCKER_COMPOSE_ENVIRONMENT_STORE
      ?? path.resolve('.data/docker-compose-environment-registry.json'),
    credentials: env.YUNPANEL_DOCKER_REGISTRY_CREDENTIAL_STORE
      ?? path.resolve('.data/docker-registry-credential-registry.json'),
  });
}

function assertServerRegistry(serverRegistry) {
  if (!serverRegistry || typeof serverRegistry.getServer !== 'function') {
    throw new DockerComposeRuntimeError(
      'docker_compose_runtime_dependencies_invalid',
      'Docker Compose runtime dependencies are invalid',
    );
  }
}

function assertProjectRegistry(projectRegistry) {
  if (!projectRegistry || typeof projectRegistry.init !== 'function'
    || typeof projectRegistry.getProject !== 'function'
    || typeof projectRegistry.createProject !== 'function'
    || typeof projectRegistry.updateProject !== 'function'
    || typeof projectRegistry.listProjects !== 'function'
    || typeof projectRegistry.materializeProject !== 'function') {
    throw new DockerComposeRuntimeError(
      'docker_compose_project_registry_invalid',
      'Docker Compose project registry dependency is invalid',
    );
  }
}

export function createDockerComposeProjectRegistryBootstrap({
  env = process.env,
  serverRegistry,
} = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new DockerComposeRuntimeError(
      'docker_compose_runtime_dependencies_invalid',
      'Docker Compose runtime dependencies are invalid',
    );
  }
  assertServerRegistry(serverRegistry);
  const paths = storePaths(env);
  const projectRegistry = createDockerComposeProjectRegistry({
    filePath: paths.projects,
    masterKey: env.YUNPANEL_SECRET_MASTER_KEY,
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  return Object.freeze({ paths, projectRegistry });
}

function extendLocalOperations(baseOperations, localOperation) {
  if (!baseOperations || !Array.isArray(baseOperations.operations)
    || typeof baseOperations.supports !== 'function' || typeof baseOperations.executeOperation !== 'function'
    || !localOperation || typeof localOperation.execute !== 'function') {
    throw new DockerComposeRuntimeError(
      'docker_compose_local_operations_invalid',
      'Docker Compose local operation dependencies are invalid',
    );
  }
  const operations = Object.freeze([...new Set([...baseOperations.operations, ...DOCKER_COMPOSE_OPERATIONS])]);
  return Object.freeze({
    operations,
    supports(operation) {
      return DOCKER_OPERATION_SET.has(operation) || baseOperations.supports(operation);
    },
    async executeOperation(operation, payload = {}, execution = null) {
      if (DOCKER_OPERATION_SET.has(operation)) return localOperation.execute(operation, payload, execution);
      return baseOperations.executeOperation(operation, payload, execution);
    },
  });
}

export async function createDockerComposeRuntime({
  env = process.env,
  serverRegistry,
  jobRegistry,
  projectRegistry: providedProjectRegistry = null,
  projectBackupLocked = async () => false,
  validateDockerCompose = createDockerComposeValidator(),
  observer = createDockerComposeObserver(),
  receiptStore = createDockerComposeOperationReceiptStore(),
} = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env)
    || !serverRegistry || typeof serverRegistry.getServer !== 'function'
    || !jobRegistry || typeof jobRegistry.enqueue !== 'function' || typeof jobRegistry.listJobs !== 'function'
    || typeof jobRegistry.recovery !== 'function' || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.complete !== 'function' || typeof jobRegistry.beginReconciliation !== 'function'
    || typeof jobRegistry.acknowledgeReconciliation !== 'function'
    || typeof projectBackupLocked !== 'function'
    || typeof validateDockerCompose !== 'function'
    || !observer || typeof observer.inspect !== 'function' || typeof observer.logs !== 'function'
    || !receiptStore || typeof receiptStore.read !== 'function' || typeof receiptStore.write !== 'function') {
    throw new DockerComposeRuntimeError(
      'docker_compose_runtime_dependencies_invalid',
      'Docker Compose runtime dependencies are invalid',
    );
  }

  const paths = storePaths(env);
  let projectRegistry = providedProjectRegistry;
  if (projectRegistry === null) {
    ({ projectRegistry } = createDockerComposeProjectRegistryBootstrap({ env, serverRegistry }));
  } else {
    assertProjectRegistry(projectRegistry);
  }
  await projectRegistry.init();

  const projectExists = async (projectId) => Boolean(await projectRegistry.getProject(projectId));
  const environmentRegistry = createDockerComposeEnvironmentRegistry({
    filePath: paths.environments,
    masterKey: env.YUNPANEL_SECRET_MASTER_KEY,
    projectExists,
  });
  await environmentRegistry.init();

  const credentialRegistry = createDockerRegistryCredentialRegistry({
    filePath: paths.credentials,
    masterKey: env.YUNPANEL_SECRET_MASTER_KEY,
    projectExists,
  });
  await credentialRegistry.init();

  const operationsService = createDockerComposeOperationsService({
    projectRegistry,
    environmentRegistry,
    credentialRegistry,
    jobRegistry,
    projectBackupLocked,
  });
  const materialize = createDockerComposeMaterializer({
    projectRegistry,
    environmentRegistry,
    credentialRegistry,
    validateDockerCompose,
  });
  const localOperation = createLocalDockerComposeOperation({ materialize, receiptStore });
  const recoveryService = createDockerComposeRecoveryService({
    jobRegistry,
    receiptStore,
    reconcileCompletedJob: async () => ({ reconciled: true, error: null }),
  });
  const recovery = await recoveryService.recover();

  return Object.freeze({
    paths,
    projectRegistry,
    environmentRegistry,
    credentialRegistry,
    operationsService,
    validateDockerCompose,
    observer,
    materialize,
    receiptStore,
    localOperation,
    recoveryService,
    recovery,
    extendLocalOperations(baseOperations) {
      return extendLocalOperations(baseOperations, localOperation);
    },
  });
}

export const dockerComposeRuntimeInternals = Object.freeze({
  storePaths,
  extendLocalOperations,
  operations: Object.freeze([...DOCKER_COMPOSE_OPERATIONS]),
});
