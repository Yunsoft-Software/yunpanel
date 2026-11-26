import { createWebsitePassengerEnvironmentManager } from '@yunpanel/host-runtime/website-passenger-environment-manager';

export class WebsitePassengerEnvironmentProvisioningError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsitePassengerEnvironmentProvisioningError';
    this.code = code;
    this.status = status;
  }
}

function intentFor(context = {}) {
  const { operation, operationId, websiteId, intent } = context;
  if (!operation || typeof operation !== 'object' || operation.operationId !== operationId
    || operation.websiteId !== websiteId
    || !intent || typeof intent !== 'object' || Array.isArray(intent)
    || intent.adapter !== 'passenger-environment'
    || typeof intent.applicationId !== 'string') {
    throw new WebsitePassengerEnvironmentProvisioningError(
      'website_passenger_environment_intent_invalid',
      'Passenger environment provisioning intent is invalid',
      400,
    );
  }
  const application = operation.resources?.application;
  const website = operation.resources?.website;
  if (!application || application.id !== intent.applicationId
    || application.type !== 'node' || application.runtimeAdapter !== 'passenger'
    || !website || website.id !== websiteId || website.applicationId !== application.id
    || website.runtimeType !== 'node') {
    throw new WebsitePassengerEnvironmentProvisioningError(
      'website_passenger_environment_plan_drift',
      'Passenger environment provisioning no longer matches the Website plan',
    );
  }
  return Object.freeze({ applicationId: application.id, operationId });
}

export function createWebsitePassengerEnvironmentProvisioningHandler({
  applicationEnvironmentRegistry,
  environmentManager = createWebsitePassengerEnvironmentManager(),
} = {}) {
  if (!applicationEnvironmentRegistry
    || typeof applicationEnvironmentRegistry.environmentStatus !== 'function'
    || typeof applicationEnvironmentRegistry.materialize !== 'function'
    || !environmentManager
    || typeof environmentManager.operation !== 'function'
    || typeof environmentManager.inspect !== 'function'
    || typeof environmentManager.apply !== 'function'
    || typeof environmentManager.inspectCompensation !== 'function'
    || typeof environmentManager.compensate !== 'function') {
    throw new WebsitePassengerEnvironmentProvisioningError(
      'website_passenger_environment_dependencies_invalid',
      'Passenger environment provisioning dependencies are invalid',
      503,
    );
  }

  async function specFor(context = {}) {
    const intent = intentFor(context);
    const operation = await environmentManager.operation(intent.applicationId, intent.operationId);
    const status = await applicationEnvironmentRegistry.environmentStatus(intent.applicationId);
    const environmentRevision = operation?.environmentRevision ?? status.savedRevision;
    if (status.savedRevision !== environmentRevision) {
      throw new WebsitePassengerEnvironmentProvisioningError(
        'website_passenger_environment_revision_drift',
        'Application environment changed after Passenger provisioning captured its revision',
      );
    }
    const values = await applicationEnvironmentRegistry.materialize(intent.applicationId, {
      expectedRevision: environmentRevision,
    });
    return Object.freeze({
      intent,
      operation,
      spec: Object.freeze({ applicationId: intent.applicationId, environmentRevision, values }),
    });
  }

  async function inspect(context = {}) {
    const { intent, spec } = await specFor(context);
    return environmentManager.inspect(spec, { operationId: intent.operationId });
  }

  async function apply(context = {}) {
    const { intent, spec } = await specFor(context);
    const current = await environmentManager.inspect(spec, { operationId: intent.operationId });
    if (current?.satisfied === true) return current;
    return environmentManager.apply(spec, { operationId: intent.operationId });
  }

  async function inspectCompensation(context = {}) {
    const { intent, spec } = await specFor(context);
    return environmentManager.inspectCompensation(spec, {
      operationId: intent.operationId,
      ownedByOperation: context.evidence?.ownedByOperation === true,
    });
  }

  async function compensate(context = {}) {
    const { intent, spec } = await specFor(context);
    return environmentManager.compensate(spec, {
      operationId: intent.operationId,
      ownedByOperation: context.evidence?.ownedByOperation === true,
    });
  }

  return Object.freeze({ apply, inspect, compensate, inspectCompensation });
}

export const websitePassengerEnvironmentProvisioningInternals = Object.freeze({ intentFor });
