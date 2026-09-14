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

function compensationSupported(handlers, stepKind) {
  return Boolean(handlers?.[stepKind] && typeof handlers[stepKind].compensate === 'function');
}

function compensationHandlerFor(handlers, step) {
  const handler = handlers?.[step.kind];
  if (!handler || typeof handler.compensate !== 'function') {
    throw new WebsiteProvisioningOrchestratorError(
      'website_provisioning_compensation_unavailable',
      `Provisioning compensation is unavailable for ${step.kind}`,
      503,
    );
  }
  return handler;
}

function publicErrorCode(error, fallback = 'website_provisioning_step_failed') {
  const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(error.code)
    ? error.code
    : fallback;
  return code;
}

function evidence(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function handlerContext(operation, step) {
  return Object.freeze({
    operation,
    operationId: operation.operationId,
    websiteId: operation.websiteId,
    stepId: step.id,
    intent: step.intent,
    evidence: step.evidence,
    compensation: step.compensation,
  });
}

export function createWebsiteProvisioningOrchestrator({ registry, handlers = {} } = {}) {
  if (!registry
    || typeof registry.get !== 'function'
    || typeof registry.beginStep !== 'function'
    || typeof registry.completeStep !== 'function'
    || typeof registry.blockStep !== 'function'
    || typeof registry.failStep !== 'function'
    || typeof registry.retryStep !== 'function'
    || typeof registry.beginCompensation !== 'function'
    || typeof registry.completeCompensation !== 'function'
    || typeof registry.failCompensation !== 'function') {
    throw new WebsiteProvisioningOrchestratorError(
      'website_provisioning_dependencies_invalid',
      'Website provisioning orchestrator dependencies are invalid',
      503,
    );
  }

  async function inspectStep(operation, step) {
    const handler = handlerFor(handlers, step);
    if (typeof handler.inspect !== 'function') return null;
    return evidence(await handler.inspect(handlerContext(operation, step)));
  }

  async function inspectCompensation(operation, step) {
    const handler = compensationHandlerFor(handlers, step);
    if (typeof handler.inspectCompensation !== 'function') return null;
    return evidence(await handler.inspectCompensation(handlerContext(operation, step)));
  }

  async function reconcileInterrupted(operation, step) {
    let inspected;
    try { inspected = await inspectStep(operation, step); }
    catch (error) {
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
    return Object.freeze({
      operation: completed,
      outcome: completed.ready ? 'ready' : 'reconciled',
      stepId: step.id,
    });
  }

  async function reconcileInterruptedCompensation(operation, step) {
    let inspected;
    try { inspected = await inspectCompensation(operation, step); }
    catch (error) {
      return Object.freeze({
        operation,
        outcome: 'compensation_interrupted',
        stepId: step.id,
        actionRequired: 'inspect_or_remediate_compensation',
        error: publicErrorCode(error, 'website_provisioning_compensation_inspection_failed'),
      });
    }

    if (!inspected || inspected.satisfied !== true) {
      return Object.freeze({
        operation,
        outcome: 'compensation_interrupted',
        stepId: step.id,
        actionRequired: 'inspect_or_remediate_compensation',
      });
    }

    const completed = await registry.completeCompensation({
      operationId: operation.operationId,
      stepId: step.id,
      evidence: inspected,
    });
    return Object.freeze({
      operation: completed,
      outcome: 'compensated',
      stepId: step.id,
    });
  }

  async function reconcileBlocked(operation, step) {
    let inspected;
    try { inspected = await inspectStep(operation, step); }
    catch (error) {
      return Object.freeze({
        operation,
        outcome: 'blocked',
        stepId: step.id,
        actionRequired: 'remediate_or_compensate',
        error: publicErrorCode(error),
      });
    }
    if (!inspected || inspected.satisfied !== true) {
      return Object.freeze({
        operation,
        outcome: 'blocked',
        stepId: step.id,
        actionRequired: 'remediate_or_compensate',
      });
    }

    const applying = await registry.beginStep({ operationId: operation.operationId, stepId: step.id });
    const applyingStep = applying.steps.find((candidate) => candidate.id === step.id);
    if (!applyingStep || applyingStep.state !== 'applying') {
      throw new WebsiteProvisioningOrchestratorError(
        'website_provisioning_transition_invalid',
        'Blocked provisioning step could not enter reconciliation',
      );
    }
    const completed = await registry.completeStep({
      operationId: operation.operationId,
      stepId: step.id,
      evidence: inspected,
    });
    return Object.freeze({
      operation: completed,
      outcome: completed.ready ? 'ready' : 'reconciled',
      stepId: step.id,
    });
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

    const interruptedCompensation = operation.steps.find((step) => step.state === 'compensating');
    if (interruptedCompensation) return reconcileInterruptedCompensation(operation, interruptedCompensation);

    const blocked = operation.steps.find((step) => step.required && step.state === 'blocked');
    if (blocked) return reconcileBlocked(operation, blocked);

    const terminal = operation.steps.find((step) => step.required
      && ['failed', 'compensated'].includes(step.state));
    if (terminal) {
      return Object.freeze({
        operation,
        outcome: 'blocked',
        stepId: terminal.id,
        actionRequired: terminal.state === 'compensated'
          ? 'continue_compensation_or_remediate'
          : 'remediate_or_compensate',
      });
    }

    const step = operation.steps.find((candidate) => candidate.state === 'pending');
    if (!step) {
      return Object.freeze({ operation, outcome: 'blocked', stepId: null, actionRequired: 'remediate' });
    }

    const handler = handlerFor(handlers, step);
    const applying = await registry.beginStep({ operationId, stepId: step.id });
    const applyingStep = applying.steps.find((candidate) => candidate.id === step.id);
    try {
      const result = evidence(await handler.apply(handlerContext(applying, applyingStep)));
      if (!result) {
        throw new WebsiteProvisioningOrchestratorError(
          'website_provisioning_evidence_required',
          'Provisioning handler did not return completion evidence',
          500,
        );
      }
      if (result.satisfied === false) {
        const code = publicErrorCode({ code: result.reason ?? 'website_provisioning_blocked' });
        const blockedOperation = await registry.blockStep({
          operationId,
          stepId: step.id,
          error: code,
          evidence: result,
        });
        return Object.freeze({
          operation: blockedOperation,
          outcome: 'blocked',
          stepId: step.id,
          actionRequired: 'remediate_or_compensate',
          error: code,
        });
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

  async function retryStep(operationId, stepId) {
    await registry.retryStep({ operationId, stepId });
    return runNext(operationId);
  }

  async function compensateStep(operationId, stepId) {
    const operation = await registry.get(operationId);
    if (!operation) {
      throw new WebsiteProvisioningOrchestratorError(
        'website_provisioning_not_found',
        'Website provisioning operation was not found',
        404,
      );
    }
    const step = operation.steps.find((candidate) => candidate.id === stepId);
    if (!step) {
      throw new WebsiteProvisioningOrchestratorError(
        'website_provisioning_step_not_found',
        'Website provisioning step was not found',
        404,
      );
    }
    if (step.compensation.state === 'not_required') {
      throw new WebsiteProvisioningOrchestratorError(
        'website_provisioning_compensation_not_required',
        'Provisioning step does not require compensation',
      );
    }
    if (step.state === 'compensating') return reconcileInterruptedCompensation(operation, step);

    const handler = compensationHandlerFor(handlers, step);
    const compensating = await registry.beginCompensation({ operationId, stepId });
    const compensatingStep = compensating.steps.find((candidate) => candidate.id === stepId);
    try {
      const result = evidence(await handler.compensate(handlerContext(compensating, compensatingStep)));
      if (!result || result.satisfied === false) {
        const code = publicErrorCode(
          { code: result?.reason },
          'website_provisioning_compensation_failed',
        );
        const failed = await registry.failCompensation({ operationId, stepId, error: code });
        return Object.freeze({
          operation: failed,
          outcome: 'compensation_failed',
          stepId,
          actionRequired: 'retry_compensation_or_remediate',
          error: code,
        });
      }
      const completed = await registry.completeCompensation({
        operationId,
        stepId,
        evidence: result,
      });
      return Object.freeze({ operation: completed, outcome: 'compensated', stepId });
    } catch (error) {
      const code = publicErrorCode(error, 'website_provisioning_compensation_failed');
      const failed = await registry.failCompensation({ operationId, stepId, error: code });
      return Object.freeze({
        operation: failed,
        outcome: 'compensation_failed',
        stepId,
        actionRequired: 'retry_compensation_or_remediate',
        error: code,
      });
    }
  }

  return Object.freeze({
    runNext,
    retryStep,
    compensateStep,
    supportsCompensation: (stepKind) => compensationSupported(handlers, stepKind),
  });
}

export const websiteProvisioningOrchestratorInternals = Object.freeze({
  handlerContext,
  compensationSupported,
});
