import { createHash } from 'node:crypto';

import {
  domainRemovalOperationPublicView,
  DomainRemovalOperationRegistryError,
} from './domain-removal-operation-registry.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ROUTING_CHILD_STATUSES = new Set(['pending', 'suspending', 'suspended', 'failed']);

export class DomainRemovalRuntimeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DomainRemovalRuntimeError';
    this.code = code;
    this.status = status;
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeFailure(error, fallbackCode = 'domain_removal_failed', fallbackMessage = 'Domain removal failed') {
  const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,120}$/.test(error.code)
    ? error.code
    : fallbackCode;
  const message = typeof error?.message === 'string' && error.message.length > 0 && error.message.length <= 500
    ? error.message
    : fallbackMessage;
  return Object.freeze({ code, message });
}

function mapped(error) {
  if (error instanceof DomainRemovalRuntimeError) return error;
  if (error instanceof DomainRemovalOperationRegistryError) {
    return new DomainRemovalRuntimeError(error.code, error.message, error.status);
  }
  return error;
}

function routingRetryConfirmation(operation) {
  return `retry-domain-remove-routing:${operation.domainId}:${operation.id}:${operation.updatedAt}:${operation.checksum}`;
}

function firstIncomplete(operation) {
  return operation.steps.find((step) => step.status !== 'succeeded') ?? null;
}

function publicOperation(operation) {
  if (!operation) return null;
  const base = domainRemovalOperationPublicView(operation);
  const step = firstIncomplete(operation);
  const routingRetryable = step?.kind === 'routing_suspend'
    && ['running', 'blocked', 'failed'].includes(step.status)
    && operation.status !== 'removed';
  return Object.freeze({
    ...base,
    actions: Object.freeze({
      routingRetryConfirmation: routingRetryable
        ? routingRetryConfirmation(operation)
        : null,
    }),
  });
}

function currentPreviewMatches(operation, preview) {
  return Boolean(preview
    && preview.version === 1
    && preview.operation === 'domain_remove'
    && preview.readyToStart === true
    && Array.isArray(preview.hardBlockers)
    && preview.hardBlockers.length === 0
    && preview.domain?.id === operation.domainId
    && preview.domain?.serverId === operation.serverId
    && preview.domain?.primaryDomain === operation.primaryDomain
    && preview.domain?.desiredRevision === operation.domainRevision
    && preview.domain?.checksum === operation.checksum
    && (preview.domain?.suspensionOperationId ?? null) === operation.sourceSuspensionOperationId
    && preview.impact?.previewDigest === operation.impactPreviewDigest
    && preview.previewDigest === operation.previewDigest
    && preview.confirmation === operation.startConfirmation);
}

function exactSuspensionChild(operation, child) {
  return Boolean(child
    && child.domainId === operation.domainId
    && child.serverId === operation.serverId
    && child.primaryDomain === operation.primaryDomain
    && child.domainRevision === operation.domainRevision
    && child.checksum === operation.checksum);
}

function completedSuspensionEvidence(operation, child) {
  if (!exactSuspensionChild(operation, child)
    || child.status !== 'suspended'
    || child.suspendResult?.suspended !== true
    || typeof child.suspendResult?.suspendedAt !== 'string') {
    throw new DomainRemovalRuntimeError(
      'domain_removal_routing_evidence_invalid',
      'Domain suspension child operation did not prove the exact removed routing state',
      409,
    );
  }
  const evidenceDigest = digest({
    operationId: child.id,
    domainId: child.domainId,
    serverId: child.serverId,
    primaryDomain: child.primaryDomain,
    domainRevision: child.domainRevision,
    checksum: child.checksum,
    status: child.status,
    suspendedAt: child.suspendResult.suspendedAt,
  });
  return Object.freeze({
    referenceId: child.id,
    evidenceDigest,
  });
}

export function createDomainRemovalRuntime({
  registry,
  previewProvider,
  suspensionRuntime,
} = {}) {
  if (!registry || typeof registry.init !== 'function' || typeof registry.create !== 'function'
    || typeof registry.get !== 'function' || typeof registry.listForDomain !== 'function'
    || typeof registry.listInterrupted !== 'function' || typeof registry.markStepRunning !== 'function'
    || typeof registry.succeedStep !== 'function' || typeof registry.blockStep !== 'function'
    || typeof registry.failStep !== 'function'
    || typeof previewProvider !== 'function'
    || !suspensionRuntime || typeof suspensionRuntime.preview !== 'function'
    || typeof suspensionRuntime.start !== 'function'
    || typeof suspensionRuntime.retrySuspend !== 'function'
    || typeof suspensionRuntime.get !== 'function'
    || typeof suspensionRuntime.listForDomain !== 'function') {
    throw new DomainRemovalRuntimeError(
      'domain_removal_runtime_dependencies_invalid',
      'Domain removal runtime dependencies are unavailable',
      503,
    );
  }

  async function childBySource(operation) {
    if (operation.sourceSuspensionOperationId === null) return null;
    let child;
    try { child = await suspensionRuntime.get(operation.sourceSuspensionOperationId); }
    catch (error) { throw mapped(error); }
    if (!child) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_suspension_operation_missing',
        'Journaled Domain suspension operation could not be found',
        409,
      );
    }
    if (!exactSuspensionChild(operation, child)) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_suspension_operation_drift',
        'Journaled Domain suspension operation no longer matches removal intent',
        409,
      );
    }
    return child;
  }

  async function discoverChild(operation) {
    const pinned = await childBySource(operation);
    if (pinned) return pinned;

    let values;
    try { values = await suspensionRuntime.listForDomain(operation.domainId); }
    catch (error) { throw mapped(error); }
    if (!Array.isArray(values)) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_suspension_inventory_invalid',
        'Domain suspension operation inventory is invalid',
        503,
      );
    }
    const candidates = values.filter((child) => (
      exactSuspensionChild(operation, child)
      && ROUTING_CHILD_STATUSES.has(child.status)
    ));
    if (candidates.length > 1) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_suspension_operation_ambiguous',
        'Multiple Domain suspension operations match removal routing intent',
        409,
      );
    }
    return candidates[0] ?? null;
  }

  async function completeRouting(operation, step, child) {
    let result;
    try { result = completedSuspensionEvidence(operation, child); }
    catch (error) { throw mapped(error); }
    try {
      return await registry.succeedStep(operation.id, step.id, result);
    } catch (error) { throw mapped(error); }
  }

  async function blockRouting(operation, step, error) {
    try {
      return await registry.blockStep(
        operation.id,
        step.id,
        safeFailure(
          error,
          'domain_removal_routing_retry_required',
          'Domain routing suspension requires explicit retry',
        ),
      );
    } catch (registryError) { throw mapped(registryError); }
  }

  async function failRouting(operation, step, error) {
    try {
      return await registry.failStep(
        operation.id,
        step.id,
        safeFailure(error, 'domain_removal_routing_failed', 'Domain routing suspension failed'),
      );
    } catch (registryError) { throw mapped(registryError); }
  }

  async function executeChildRetry(operation, child) {
    if (!child.actions?.suspendRetryConfirmation
      || typeof child.updatedAt !== 'string'
      || child.checksum !== operation.checksum) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_suspension_retry_unavailable',
        'Matching Domain suspension operation cannot be retried safely',
        409,
      );
    }
    try {
      return await suspensionRuntime.retrySuspend({
        domainId: operation.domainId,
        operationId: child.id,
        expectedUpdatedAt: child.updatedAt,
        checksum: operation.checksum,
        confirmation: child.actions.suspendRetryConfirmation,
      });
    } catch (error) { throw mapped(error); }
  }

  async function startChild(operation) {
    let preview;
    try { preview = await suspensionRuntime.preview({ domainId: operation.domainId }); }
    catch (error) { throw mapped(error); }
    if (!preview || preview.readyToSuspend !== true
      || preview.domain?.id !== operation.domainId
      || preview.domain?.serverId !== operation.serverId
      || preview.domain?.primaryDomain !== operation.primaryDomain
      || preview.domain?.desiredRevision !== operation.domainRevision
      || preview.domain?.stagedRevision !== operation.domainRevision
      || preview.domain?.appliedRevision !== operation.domainRevision
      || preview.domain?.stagedChecksum !== operation.checksum
      || typeof preview.previewDigest !== 'string' || !SHA256_PATTERN.test(preview.previewDigest)
      || typeof preview.confirmation !== 'string' || !preview.confirmation) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_suspension_preview_stale',
        'Domain suspension preview no longer matches journaled removal intent',
        409,
      );
    }
    try {
      return await suspensionRuntime.start({
        domainId: operation.domainId,
        previewDigest: preview.previewDigest,
        confirmation: preview.confirmation,
      });
    } catch (error) { throw mapped(error); }
  }

  async function runRouting(operationId, { allowHostMutation } = {}) {
    let operation;
    try { operation = await registry.get(operationId); }
    catch (error) { throw mapped(error); }
    if (!operation) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_operation_not_found',
        'Domain removal operation was not found',
        404,
      );
    }
    const first = firstIncomplete(operation);
    if (!first || first.kind !== 'routing_suspend') return publicOperation(operation);
    if (first.status !== 'running') {
      try {
        operation = await registry.markStepRunning(operation.id, first.id);
      } catch (error) { throw mapped(error); }
    }
    const step = firstIncomplete(operation);
    if (!step || step.kind !== 'routing_suspend' || step.status !== 'running') {
      throw new DomainRemovalRuntimeError(
        'domain_removal_routing_state_invalid',
        'Domain removal routing step state changed unexpectedly',
        409,
      );
    }

    let child;
    try { child = await discoverChild(operation); }
    catch (error) {
      if (Number(error?.status) === 409) {
        return publicOperation(await blockRouting(operation, step, error));
      }
      throw error;
    }

    if (child?.status === 'suspended') {
      return publicOperation(await completeRouting(operation, step, child));
    }

    if (!allowHostMutation) {
      return publicOperation(await blockRouting(operation, step, new DomainRemovalRuntimeError(
        child
          ? 'domain_removal_suspension_retry_required'
          : 'domain_removal_suspension_start_required',
        child
          ? 'Matching Domain suspension operation is incomplete; explicit routing retry is required'
          : 'No completed Domain suspension operation exists; explicit routing retry is required',
        409,
      )));
    }

    let result;
    try {
      if (child && ['suspending', 'failed'].includes(child.status)) {
        result = await executeChildRetry(operation, child);
      } else {
        result = await startChild(operation);
      }
    } catch (error) {
      if (Number(error?.status) === 409) {
        return publicOperation(await blockRouting(operation, step, error));
      }
      return publicOperation(await failRouting(operation, step, error));
    }

    if (!result || result.status !== 'suspended') {
      return publicOperation(await blockRouting(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_suspension_incomplete',
        'Domain suspension child operation did not reach suspended state',
        409,
      )));
    }
    try {
      return publicOperation(await completeRouting(operation, step, result));
    } catch (error) {
      if (Number(error?.status) === 409) {
        return publicOperation(await blockRouting(operation, step, error));
      }
      throw error;
    }
  }

  async function preview(input) {
    try { return await previewProvider(input); }
    catch (error) { throw mapped(error); }
  }

  async function start({ domainId, previewDigest, confirmation } = {}) {
    if (typeof previewDigest !== 'string' || !SHA256_PATTERN.test(previewDigest)
      || typeof confirmation !== 'string' || !confirmation) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_confirmation_invalid',
        'A current Domain removal preview digest and exact confirmation are required',
        409,
      );
    }
    let current;
    try { current = await previewProvider({ domainId }); }
    catch (error) { throw mapped(error); }
    if (!current || current.readyToStart !== true
      || current.previewDigest !== previewDigest
      || current.confirmation !== confirmation) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_preview_stale',
        'Domain removal preview is stale, blocked or confirmation is invalid',
        409,
      );
    }
    let operation;
    try { operation = await registry.create(current); }
    catch (error) { throw mapped(error); }
    if (!currentPreviewMatches(operation, current)) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_operation_intent_mismatch',
        'Domain removal journal does not match current preview intent',
        409,
      );
    }
    return runRouting(operation.id, { allowHostMutation: true });
  }

  async function retryRouting({
    domainId,
    operationId,
    expectedUpdatedAt,
    checksum,
    confirmation,
  } = {}) {
    let operation;
    try { operation = await registry.get(operationId); }
    catch (error) { throw mapped(error); }
    if (!operation || operation.domainId !== domainId) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_operation_not_found',
        'Domain removal operation was not found',
        404,
      );
    }
    const step = firstIncomplete(operation);
    if (!step || step.kind !== 'routing_suspend'
      || !['running', 'blocked', 'failed'].includes(step.status)
      || expectedUpdatedAt !== operation.updatedAt
      || checksum !== operation.checksum
      || confirmation !== routingRetryConfirmation(operation)) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_routing_retry_stale',
        'Domain removal routing retry is stale or confirmation is invalid',
        409,
      );
    }
    return runRouting(operation.id, { allowHostMutation: true });
  }

  async function reconcileInterrupted(operation) {
    const step = firstIncomplete(operation);
    if (!step || step.status !== 'running') {
      return Object.freeze({
        operationId: operation.id,
        recovered: false,
        operation: publicOperation(operation),
        error: Object.freeze({
          code: 'domain_removal_recovery_state_invalid',
          message: 'Domain removal interrupted state is invalid',
        }),
      });
    }
    if (step.kind !== 'routing_suspend') {
      return Object.freeze({
        operationId: operation.id,
        recovered: false,
        operation: publicOperation(operation),
        error: Object.freeze({
          code: 'domain_removal_step_retry_required',
          message: 'Interrupted Domain removal step requires explicit retry',
        }),
      });
    }
    const result = await runRouting(operation.id, { allowHostMutation: false });
    return Object.freeze({
      operationId: operation.id,
      recovered: result.steps.find((candidate) => candidate.id === step.id)?.status === 'succeeded',
      operation: result,
      ...(
        result.steps.find((candidate) => candidate.id === step.id)?.status === 'succeeded'
          ? {}
          : {
            error: Object.freeze({
              code: 'domain_removal_routing_retry_required',
              message: 'Domain routing suspension requires explicit retry',
            }),
          }
      ),
    });
  }

  async function init() {
    try { await registry.init(); }
    catch (error) { throw mapped(error); }
    let interrupted;
    try { interrupted = await registry.listInterrupted(); }
    catch (error) { throw mapped(error); }
    const recovery = [];
    for (const operation of interrupted) {
      try { recovery.push(await reconcileInterrupted(operation)); }
      catch (error) {
        recovery.push(Object.freeze({
          operationId: operation.id,
          recovered: false,
          error: safeFailure(
            error,
            'domain_removal_recovery_pending',
            'Domain removal recovery remains pending',
          ),
        }));
      }
    }
    return Object.freeze(recovery);
  }

  async function get(operationId) {
    try { return publicOperation(await registry.get(operationId)); }
    catch (error) { throw mapped(error); }
  }

  async function listForDomain(domainId) {
    try { return Object.freeze((await registry.listForDomain(domainId)).map(publicOperation)); }
    catch (error) { throw mapped(error); }
  }

  return Object.freeze({
    init,
    preview,
    start,
    retryRouting,
    get,
    listForDomain,
  });
}

export const domainRemovalRuntimeInternals = Object.freeze({
  digest,
  safeFailure,
  routingRetryConfirmation,
  firstIncomplete,
  publicOperation,
  currentPreviewMatches,
  exactSuspensionChild,
  completedSuspensionEvidence,
});
