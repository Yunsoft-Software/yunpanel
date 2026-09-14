import { WebsiteProvisioningRegistryError } from './website-provisioning-registry.js';

export class WebsiteProvisioningOrchestratorError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteProvisioningOrchestratorError';
    this.code = code;
    this.status = status;
  }
}

function handlerFor(handlers, step) {
  const handler = handlers?.[step.kind];
  if (!handler || typeof handler.apply !== 'function') {
    throw new WebsiteProvisioningOrchestratorError(
      'website_provisioning_handler_unavailable',
      `Provisioning handler is unavailable for ${step.kind}`,
      503,
    );
  }
  return handler;
}

function publicErrorCode(error) {
  const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(error.code)
    ? error.code
    : 'website_provisioning_step_failed';
  return code;
}

function evidence(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function createWebsiteProvisioningOrchestrator({ registry, handlers = {} } = {}) {
  if (!registry
    || typeof registry.get !== 'function'
    || typeof registry.beginStep !== 'function'
    || typeof registry.completeStep !== 'function'
    || typeof registry.failStep !== 'function') {
    throw new WebsiteProvisioningOrchestratorError(
      'website_provisioning_dependencies_invalid',
      'Website provisioning orchestrator dependencies are invalid',
      503,
    );
  }

  async function reconcileInterrupted(operation, step) {
    const handler = handlerFor(handlers, step);
    if (typeof handler.inspect !== 'function') {
      return Object.freeze({
        operation,
        outcome: 'interrupted',
        stepId: step.id,
        actionRequired: 'inspect_or_remediate',
      });
    }

    let inspected;
    try {
      inspected = evidence(await handler.inspect({
        operationId: operation.operationId,
        websiteId: operation.websiteId,
        stepId: step.id,
        intent: step.intent,
      }));
    } catch (error) {
      return Object.freeze({
        operation,
        outcome: 'interrupted',
        stepId: step.id,
        actionRequired: 'inspect_or_remediate',
        error: publicErrorCode(error),
      });
    }

    if (!inspected || inspected.satisfied !== true) {
      return Object.freeze({
        operation,
        outcome: 'interrupted',
        stepId: step.id,
        actionRequired: 'inspect_or_remediate',
      });
    }

    const completed = await registry.completeStep({
      operationId: operation.operationId,
      stepId: step.id,
      evidence: inspected,
    });
    return Object.freeze({ operation: completed, outcome: 'reconciled', stepId: step.id });
  }

  async function runNext(operationId) {
    const operation = await registry.get(operationId);
    if (!operation) {
      throw new WebsiteProvisioningOrchestratorError(
        'website_provisioning_not_found',
        'Website provisioning operation was not found',
        404,
      );
    }
    if (operation.ready) return Object.freeze({ operation, outcome: 'ready', stepId: null });

    const interrupted = operation.steps.find((step) => step.state === 'applying');
    if (interrupted) return reconcileInterrupted(operation, interrupted);

    const blocked = operation.steps.find((step) => step.required && ['failed', 'compensating', 'compensated'].includes(step.state));
    if (blocked) {
      return Object.freeze({
        operation,
        outcome: 'blocked',
        stepId: blocked.id,
        actionRequired: 'remediate_or_compensate',
      });
    }

    const step = operation.steps.find((candidate) => candidate.state === 'pending' || candidate.state === 'blocked');
    if (!step) {
      return Object.freeze({ operation, outcome: 'blocked', stepId: null, actionRequired: 'remediate' });
    }

    const handler = handlerFor(handlers, step);
    await registry.beginStep({ operationId, stepId: step.id });
    try {
      const result = evidence(await handler.apply({
        operationId,
        websiteId: operation.websiteId,
        stepId: step.id,
        intent: step.intent,
      }));
      if (!result) {
        throw new WebsiteProvisioningOrchestratorError(
          'website_provisioning_evidence_required',
          'Provisioning handler did not return completion evidence',
          500,
        );
      }
      const completed = await registry.completeStep({ operationId, stepId: step.id, evidence: result });
      return Object.freeze({ operation: completed, outcome: completed.ready ? 'ready' : 'progressed', stepId: step.id });
    } catch (error) {
      if (error instanceof WebsiteProvisioningRegistryError
        && error.code === 'website_provisioning_evidence_required') throw error;
      const failed = await registry.failStep({
        operationId,
        stepId: step.id,
        error: publicErrorCode(error),
      });
      return Object.freeze({
        operation: failed,
        outcome: 'failed',
        stepId: step.id,
        error: publicErrorCode(error),
      });
    }
  }

  return Object.freeze({ runNext });
}
