const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STEP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;

export class WebsiteProvisioningJobAuthorizationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteProvisioningJobAuthorizationError';
    this.code = code;
    this.status = status;
  }
}

export function normalizeWebsiteProvisioningJobAuthorization(value, { optional = false } = {}) {
  if ((value === null || value === undefined) && optional) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.kind !== 'website_provisioning' || value.version !== 1
    || typeof value.operationId !== 'string' || !UUID_PATTERN.test(value.operationId)
    || typeof value.websiteId !== 'string' || !UUID_PATTERN.test(value.websiteId)
    || typeof value.stepId !== 'string' || !STEP_ID_PATTERN.test(value.stepId)
    || Object.keys(value).some((key) => !['kind', 'version', 'operationId', 'websiteId', 'stepId'].includes(key))) {
    throw new WebsiteProvisioningJobAuthorizationError(
      'website_provisioning_job_authorization_invalid',
      'Website provisioning child-job authorization scope is invalid',
    );
  }
  return Object.freeze({
    kind: 'website_provisioning',
    version: 1,
    operationId: value.operationId.toLowerCase(),
    websiteId: value.websiteId.toLowerCase(),
    stepId: value.stepId,
  });
}

export function websiteProvisioningJobAuthorization(context = {}) {
  return normalizeWebsiteProvisioningJobAuthorization({
    kind: 'website_provisioning',
    version: 1,
    operationId: context.operationId,
    websiteId: context.websiteId,
    stepId: context.stepId,
  });
}

export function createWebsiteProvisioningJobAuthorizer({
  registry,
  websiteRegistry,
  authorizeActor,
  localServerId = null,
} = {}) {
  if (!registry || typeof registry.get !== 'function' || typeof registry.getActor !== 'function'
    || !websiteRegistry || typeof websiteRegistry.getWebsite !== 'function'
    || typeof authorizeActor !== 'function'
    || (localServerId !== null && (typeof localServerId !== 'string' || !localServerId))) {
    throw new WebsiteProvisioningJobAuthorizationError(
      'website_provisioning_job_authorizer_dependencies_invalid',
      'Website provisioning child-job authorizer dependencies are invalid',
      503,
    );
  }

  return async function authorizeWebsiteProvisioningJob(value) {
    let scope;
    try {
      scope = normalizeWebsiteProvisioningJobAuthorization(value);
      const operation = await registry.get(scope.operationId);
      if (!operation || operation.websiteId !== scope.websiteId
        || operation.terminalState === 'abandoned' || operation.status === 'abandoned') return false;
      const step = operation.steps?.find((candidate) => candidate.id === scope.stepId);
      if (!step || !['applying', 'compensating'].includes(step.state)) return false;

      const website = await websiteRegistry.getWebsite(scope.websiteId);
      if (!website || website.id !== scope.websiteId
        || (localServerId !== null && website.serverId !== localServerId)) return false;

      const actor = await registry.getActor(scope.operationId);
      if (!actor) return false;
      const live = await authorizeActor(actor, scope.websiteId);
      return Boolean(live
        && live.sessionId === actor.sessionId
        && live.userId === actor.userId
        && live.role === actor.role);
    } catch {
      return false;
    }
  };
}

const DIRECT_LEGACY_TYPES = Object.freeze([
  /^website\.ssl\.issue:[0-9a-f-]{36}$/i,
  /^website\.webmail\.ssl\.issue:[0-9a-f-]{36}$/i,
  /^website_mail_(?:apply|rollback):[0-9a-f-]{36}$/i,
  /^website_dkim_(?:apply|cleanup):[0-9a-f-]{36}$/i,
]);

const LEGACY_DATABASE_OPERATIONS = new Set([
  'database.create',
  'database.delete',
  'database.credential.apply',
  'database.credential.delete',
]);

function activeMutationStep(operation, kind) {
  return operation?.steps?.find((step) => (
    step?.kind === kind && ['applying', 'compensating'].includes(step.state)
  )) ?? null;
}

export function createWebsiteProvisioningLegacyJobGuard({ registry } = {}) {
  if (!registry || typeof registry.listAuthorizationSensitive !== 'function') {
    throw new WebsiteProvisioningJobAuthorizationError(
      'website_provisioning_legacy_guard_dependencies_invalid',
      'Website provisioning legacy-job guard dependencies are invalid',
      503,
    );
  }

  return async function requiresWebsiteProvisioningAuthorization(execution = {}) {
    const type = typeof execution.type === 'string' ? execution.type : '';
    if (DIRECT_LEGACY_TYPES.some((pattern) => pattern.test(type))) return true;

    const operation = typeof execution.operation === 'string' ? execution.operation : '';
    const resourceType = typeof execution.resourceType === 'string' ? execution.resourceType : '';
    const resourceId = typeof execution.resourceId === 'string' ? execution.resourceId : '';
    const serverId = typeof execution.serverId === 'string' ? execution.serverId : '';

    const databaseCandidate = LEGACY_DATABASE_OPERATIONS.has(operation) && resourceType === 'database';
    const roundcubeCandidate = operation === 'roundcube.config.apply' && resourceType === 'server';
    if (!databaseCandidate && !roundcubeCandidate) return false;

    const active = await registry.listAuthorizationSensitive();
    if (!Array.isArray(active)) {
      throw new WebsiteProvisioningJobAuthorizationError(
        'website_provisioning_legacy_guard_state_invalid',
        'Website provisioning legacy-job state is invalid',
        503,
      );
    }

    return active.some((provisioning) => {
      if (databaseCandidate) {
        const step = activeMutationStep(provisioning, 'website_database');
        return Boolean(step
          && step.intent?.databaseName === resourceId
          && step.intent?.serverId === serverId);
      }
      const step = activeMutationStep(provisioning, 'roundcube_mapping');
      return Boolean(step
        && step.intent?.serverId === serverId
        && resourceId === serverId);
    });
  };
}
