import {
  domainSuspensionOperationPublicView,
  DomainSuspensionOperationRegistryError,
} from './domain-suspension-operation-registry.js';
import { DomainSuspensionError } from './domain-suspension.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class DomainSuspensionRuntimeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DomainSuspensionRuntimeError';
    this.code = code;
    this.status = status;
  }
}

function safeFailure(error, fallbackCode, fallbackMessage) {
  const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,120}$/.test(error.code)
    ? error.code
    : fallbackCode;
  const message = typeof error?.message === 'string' && error.message.length > 0 && error.message.length <= 500
    ? error.message
    : fallbackMessage;
  return Object.freeze({ code, message });
}

function mapped(error) {
  if (error instanceof DomainSuspensionRuntimeError) return error;
  if (error instanceof DomainSuspensionError || error instanceof DomainSuspensionOperationRegistryError) {
    return new DomainSuspensionRuntimeError(error.code, error.message, error.status);
  }
  return error;
}

function suspendRetryConfirmation(operation) {
  return `retry-domain-suspend:${operation.domainId}:${operation.id}:${operation.updatedAt}:${operation.checksum}`;
}

function resumeConfirmation(operation) {
  return `resume-domain:${operation.domainId}:${operation.id}:${operation.updatedAt}:${operation.checksum}`;
}

function resumeRetryConfirmation(operation) {
  return `retry-domain-resume:${operation.domainId}:${operation.id}:${operation.updatedAt}:${operation.checksum}`;
}

function publicOperation(operation) {
  if (!operation) return null;
  const base = domainSuspensionOperationPublicView(operation);
  return Object.freeze({
    ...base,
    actions: Object.freeze({
      suspendRetryConfirmation: ['suspending', 'failed'].includes(operation.status)
        ? suspendRetryConfirmation(operation)
        : null,
      resumeConfirmation: operation.status === 'suspended'
        ? resumeConfirmation(operation)
        : null,
      resumeRetryConfirmation: ['resuming', 'resume_failed'].includes(operation.status)
        ? resumeRetryConfirmation(operation)
        : null,
    }),
  });
}

function currentPreviewMatches(operation, preview) {
  return Boolean(preview
    && preview.readyToSuspend === true
    && preview.domain?.id === operation.domainId
    && preview.domain?.serverId === operation.serverId
    && preview.domain?.primaryDomain === operation.primaryDomain
    && preview.domain?.desiredRevision === operation.domainRevision
    && preview.domain?.stagedRevision === operation.domainRevision
    && preview.domain?.appliedRevision === operation.domainRevision
    && preview.domain?.stagedChecksum === operation.checksum
    && preview.previewDigest === operation.previewDigest
    && preview.confirmation === operation.confirmation);
}

function inspectShape(operation, inspection, phase) {
  if (!inspection || typeof inspection !== 'object'
    || inspection.domainId !== operation.domainId
    || inspection.primaryDomain !== operation.primaryDomain
    || inspection.expectedRevision !== operation.domainRevision
    || inspection.checksum !== operation.checksum
    || !['active', 'suspended', 'resumed', 'drift'].includes(inspection.controlPlane)
    || !inspection.host || typeof inspection.host !== 'object'
    || inspection.host.checksum !== operation.checksum
    || typeof inspection.host.satisfied !== 'boolean') {
    throw new DomainSuspensionRuntimeError(
      phase === 'resume'
        ? 'domain_resume_inspection_invalid'
        : 'domain_suspension_inspection_invalid',
      phase === 'resume'
        ? 'Domain resume inspection did not match journaled intent'
        : 'Domain suspension inspection did not match journaled intent',
      503,
    );
  }
  return inspection;
}

export function createDomainSuspensionRuntime({ registry, service } = {}) {
  if (!registry || typeof registry.init !== 'function' || typeof registry.create !== 'function'
    || typeof registry.get !== 'function' || typeof registry.listForDomain !== 'function'
    || typeof registry.listInterrupted !== 'function' || typeof registry.markSuspending !== 'function'
    || typeof registry.succeedSuspend !== 'function' || typeof registry.failSuspend !== 'function'
    || typeof registry.markResuming !== 'function' || typeof registry.succeedResume !== 'function'
    || typeof registry.failResume !== 'function'
    || !service || typeof service.preview !== 'function'
    || typeof service.inspectSuspend !== 'function' || typeof service.deactivateHost !== 'function'
    || typeof service.commitSuspended !== 'function' || typeof service.inspectResume !== 'function'
    || typeof service.restoreHost !== 'function' || typeof service.commitResumed !== 'function') {
    throw new DomainSuspensionRuntimeError(
      'domain_suspension_runtime_dependencies_invalid',
      'Domain suspension runtime dependencies are unavailable',
      503,
    );
  }

  async function inspectSuspend(operation) {
    try {
      return inspectShape(operation, await service.inspectSuspend({
        domainId: operation.domainId,
        operationId: operation.id,
        expectedRevision: operation.domainRevision,
        checksum: operation.checksum,
      }), 'suspend');
    } catch (error) { throw mapped(error); }
  }

  async function inspectResume(operation) {
    try {
      return inspectShape(operation, await service.inspectResume({
        domainId: operation.domainId,
        operationId: operation.id,
        expectedRevision: operation.domainRevision,
        checksum: operation.checksum,
      }), 'resume');
    } catch (error) { throw mapped(error); }
  }

  async function commitSuspended(operation, hostChanged) {
    let domain;
    try {
      domain = await service.commitSuspended({
        domainId: operation.domainId,
        operationId: operation.id,
        expectedRevision: operation.domainRevision,
        checksum: operation.checksum,
      });
    } catch (error) { throw mapped(error); }
    if (!domain || domain.state !== 'suspended'
      || domain.suspensionOperationId !== operation.id
      || domain.suspendedChecksum !== operation.checksum
      || typeof domain.suspendedAt !== 'string') {
      throw new DomainSuspensionRuntimeError(
        'domain_suspension_commit_invalid',
        'Domain registry did not confirm exact suspension ownership',
        503,
      );
    }
    try {
      return publicOperation(await registry.succeedSuspend(operation.id, {
        hostChanged,
        suspendedAt: domain.suspendedAt,
      }));
    } catch (error) { throw mapped(error); }
  }

  async function commitResumed(operation, hostChanged) {
    let domain;
    try {
      domain = await service.commitResumed({
        domainId: operation.domainId,
        operationId: operation.id,
        expectedRevision: operation.domainRevision,
        checksum: operation.checksum,
      });
    } catch (error) { throw mapped(error); }
    if (!domain || domain.state !== 'active'
      || domain.lastSuspensionOperationId !== operation.id
      || typeof domain.lastResumedAt !== 'string') {
      throw new DomainSuspensionRuntimeError(
        'domain_resume_commit_invalid',
        'Domain registry did not confirm exact resume ownership',
        503,
      );
    }
    try {
      return publicOperation(await registry.succeedResume(operation.id, {
        hostChanged,
        resumedAt: domain.lastResumedAt,
      }));
    } catch (error) { throw mapped(error); }
  }

  async function failSuspend(operation, error) {
    try {
      return publicOperation(await registry.failSuspend(
        operation.id,
        safeFailure(error, 'domain_suspension_failed', 'Domain suspension failed'),
      ));
    } catch (registryError) { throw mapped(registryError); }
  }

  async function failResume(operation, error) {
    try {
      return publicOperation(await registry.failResume(
        operation.id,
        safeFailure(error, 'domain_resume_failed', 'Domain resume failed'),
      ));
    } catch (registryError) { throw mapped(registryError); }
  }

  async function compensateFailedSuspend(operation, originalError) {
    try {
      const resumeInspection = await inspectResume(operation);
      if (resumeInspection.host.satisfied) return failSuspend(operation, originalError);
      await service.restoreHost({
        primaryDomain: operation.primaryDomain,
        checksum: operation.checksum,
      });
      const after = await inspectResume(operation);
      if (!after.host.satisfied) {
        throw new DomainSuspensionRuntimeError(
          'domain_suspension_compensation_unverified',
          'Nginx active configuration could not be restored after suspension commit failure',
          503,
        );
      }
      return failSuspend(operation, originalError);
    } catch (error) {
      if (error instanceof DomainSuspensionRuntimeError
        && error.code === 'domain_suspension_compensation_unverified') throw error;
      throw new DomainSuspensionRuntimeError(
        'domain_suspension_compensation_uncertain',
        'Domain suspension changed host state but control-plane commit failed; automatic host replay is blocked',
        503,
      );
    }
  }

  async function compensateFailedResume(operation, originalError) {
    try {
      const suspendInspection = await inspectSuspend(operation);
      if (suspendInspection.host.satisfied) return failResume(operation, originalError);
      await service.deactivateHost({
        primaryDomain: operation.primaryDomain,
        checksum: operation.checksum,
      });
      const after = await inspectSuspend(operation);
      if (!after.host.satisfied) {
        throw new DomainSuspensionRuntimeError(
          'domain_resume_compensation_unverified',
          'Nginx suspended state could not be restored after resume commit failure',
          503,
        );
      }
      return failResume(operation, originalError);
    } catch (error) {
      if (error instanceof DomainSuspensionRuntimeError
        && error.code === 'domain_resume_compensation_unverified') throw error;
      throw new DomainSuspensionRuntimeError(
        'domain_resume_compensation_uncertain',
        'Domain resume changed host state but control-plane commit failed; automatic host replay is blocked',
        503,
      );
    }
  }

  async function runSuspend(operationId, { allowHostMutation } = {}) {
    let operation;
    try { operation = await registry.get(operationId); }
    catch (error) { throw mapped(error); }
    if (!operation) {
      throw new DomainSuspensionRuntimeError(
        'domain_suspension_operation_not_found',
        'Domain suspension operation was not found',
        404,
      );
    }
    if (operation.status === 'suspended') return publicOperation(operation);
    if (!['pending', 'suspending', 'failed'].includes(operation.status)) {
      return publicOperation(operation);
    }
    if (['pending', 'failed'].includes(operation.status)) {
      try { operation = await registry.markSuspending(operation.id); }
      catch (error) { throw mapped(error); }
    }

    let inspected;
    try { inspected = await inspectSuspend(operation); }
    catch (error) {
      if (Number(error?.status) === 409) return failSuspend(operation, error);
      throw new DomainSuspensionRuntimeError(
        'domain_suspension_recovery_inspection_unavailable',
        'Domain suspension state cannot be inspected; automatic host replay is blocked',
        503,
      );
    }

    if (inspected.controlPlane === 'drift' || inspected.controlPlane === 'resumed') {
      return failSuspend(operation, new DomainSuspensionRuntimeError(
        'domain_suspension_state_drift',
        'Domain control-plane state no longer matches suspension intent',
        409,
      ));
    }
    if (inspected.host.satisfied) {
      if (!['active', 'suspended'].includes(inspected.controlPlane)) {
        return failSuspend(operation, new DomainSuspensionRuntimeError(
          'domain_suspension_state_drift',
          'Domain control-plane state conflicts with deactivated Nginx state',
          409,
        ));
      }
      try { return await commitSuspended(operation, false); }
      catch (error) { throw mapped(error); }
    }
    if (inspected.controlPlane === 'suspended') {
      return failSuspend(operation, new DomainSuspensionRuntimeError(
        'domain_suspension_host_drift',
        'Domain is marked suspended while Nginx traffic remains active',
        409,
      ));
    }
    if (!inspected.host.deactivationCandidate) {
      return failSuspend(operation, new DomainSuspensionRuntimeError(
        'domain_suspension_host_unavailable',
        'Nginx active configuration is not an owned deactivation candidate',
        409,
      ));
    }
    if (!allowHostMutation) {
      return Object.freeze({
        operationId: operation.id,
        recovered: false,
        operation: publicOperation(operation),
        error: Object.freeze({
          code: 'domain_suspension_retry_required',
          message: 'Nginx traffic remains active; explicit suspension retry is required',
        }),
      });
    }

    let preview;
    try { preview = await service.preview({ domainId: operation.domainId }); }
    catch (error) { throw mapped(error); }
    if (!currentPreviewMatches(operation, preview)) {
      return failSuspend(operation, new DomainSuspensionRuntimeError(
        'domain_suspension_preview_stale',
        'Domain routing or Nginx state changed after suspension preview',
        409,
      ));
    }

    let hostResult;
    try {
      hostResult = await service.deactivateHost({
        primaryDomain: operation.primaryDomain,
        checksum: operation.checksum,
      });
    } catch (hostError) {
      let after;
      try { after = await inspectSuspend(operation); }
      catch (inspectionError) {
        if (Number(inspectionError?.status) === 409) return failSuspend(operation, inspectionError);
        throw new DomainSuspensionRuntimeError(
          'domain_suspension_result_uncertain',
          'Nginx deactivation result is uncertain and current state cannot be inspected',
          503,
        );
      }
      if (after.host.satisfied && after.controlPlane === 'active') {
        try { return await commitSuspended(operation, false); }
        catch (commitError) { return compensateFailedSuspend(operation, commitError); }
      }
      if (after.host.deactivationCandidate && after.controlPlane === 'active') {
        return failSuspend(operation, hostError);
      }
      return failSuspend(operation, new DomainSuspensionRuntimeError(
        'domain_suspension_postcondition_invalid',
        'Nginx deactivation failed with inconsistent post-condition',
        409,
      ));
    }

    let after;
    try { after = await inspectSuspend(operation); }
    catch (error) {
      throw new DomainSuspensionRuntimeError(
        'domain_suspension_postcondition_unavailable',
        'Nginx deactivation returned success but exact post-condition cannot be inspected',
        503,
      );
    }
    if (!after.host.satisfied || after.controlPlane !== 'active') {
      return failSuspend(operation, new DomainSuspensionRuntimeError(
        'domain_suspension_postcondition_invalid',
        'Nginx deactivation did not produce the exact journaled suspended host state',
        409,
      ));
    }
    try {
      return await commitSuspended(operation, hostResult?.changed === true);
    } catch (error) {
      return compensateFailedSuspend(operation, error);
    }
  }

  async function runResume(operationId, { allowHostMutation } = {}) {
    let operation;
    try { operation = await registry.get(operationId); }
    catch (error) { throw mapped(error); }
    if (!operation) {
      throw new DomainSuspensionRuntimeError(
        'domain_suspension_operation_not_found',
        'Domain suspension operation was not found',
        404,
      );
    }
    if (operation.status === 'resumed') return publicOperation(operation);
    if (!['suspended', 'resuming', 'resume_failed'].includes(operation.status)) {
      return publicOperation(operation);
    }
    if (['suspended', 'resume_failed'].includes(operation.status)) {
      try { operation = await registry.markResuming(operation.id); }
      catch (error) { throw mapped(error); }
    }

    let inspected;
    try { inspected = await inspectResume(operation); }
    catch (error) {
      if (Number(error?.status) === 409) return failResume(operation, error);
      throw new DomainSuspensionRuntimeError(
        'domain_resume_recovery_inspection_unavailable',
        'Domain resume state cannot be inspected; automatic host replay is blocked',
        503,
      );
    }

    if (inspected.controlPlane === 'drift' || inspected.controlPlane === 'active') {
      return failResume(operation, new DomainSuspensionRuntimeError(
        'domain_resume_state_drift',
        'Domain control-plane state no longer matches resume intent',
        409,
      ));
    }
    if (inspected.host.satisfied) {
      if (!['suspended', 'resumed'].includes(inspected.controlPlane)) {
        return failResume(operation, new DomainSuspensionRuntimeError(
          'domain_resume_state_drift',
          'Domain control-plane state conflicts with restored Nginx state',
          409,
        ));
      }
      try { return await commitResumed(operation, false); }
      catch (error) { throw mapped(error); }
    }
    if (inspected.controlPlane === 'resumed') {
      return failResume(operation, new DomainSuspensionRuntimeError(
        'domain_resume_host_drift',
        'Domain is marked resumed while Nginx traffic remains suspended',
        409,
      ));
    }
    if (inspected.host.reason !== 'nginx_deactivation_rollback_pending') {
      return failResume(operation, new DomainSuspensionRuntimeError(
        'domain_resume_host_unavailable',
        'Nginx suspended state is not an owned resume candidate',
        409,
      ));
    }
    if (!allowHostMutation) {
      return Object.freeze({
        operationId: operation.id,
        recovered: false,
        operation: publicOperation(operation),
        error: Object.freeze({
          code: 'domain_resume_retry_required',
          message: 'Nginx traffic remains suspended; explicit resume retry is required',
        }),
      });
    }

    let hostResult;
    try {
      hostResult = await service.restoreHost({
        primaryDomain: operation.primaryDomain,
        checksum: operation.checksum,
      });
    } catch (hostError) {
      let after;
      try { after = await inspectResume(operation); }
      catch (inspectionError) {
        if (Number(inspectionError?.status) === 409) return failResume(operation, inspectionError);
        throw new DomainSuspensionRuntimeError(
          'domain_resume_result_uncertain',
          'Nginx resume result is uncertain and current state cannot be inspected',
          503,
        );
      }
      if (after.host.satisfied && after.controlPlane === 'suspended') {
        try { return await commitResumed(operation, false); }
        catch (commitError) { return compensateFailedResume(operation, commitError); }
      }
      if (after.host.reason === 'nginx_deactivation_rollback_pending'
        && after.controlPlane === 'suspended') {
        return failResume(operation, hostError);
      }
      return failResume(operation, new DomainSuspensionRuntimeError(
        'domain_resume_postcondition_invalid',
        'Nginx resume failed with inconsistent post-condition',
        409,
      ));
    }

    let after;
    try { after = await inspectResume(operation); }
    catch {
      throw new DomainSuspensionRuntimeError(
        'domain_resume_postcondition_unavailable',
        'Nginx resume returned success but exact post-condition cannot be inspected',
        503,
      );
    }
    if (!after.host.satisfied || after.controlPlane !== 'suspended') {
      return failResume(operation, new DomainSuspensionRuntimeError(
        'domain_resume_postcondition_invalid',
        'Nginx resume did not produce the exact journaled active host state',
        409,
      ));
    }
    try {
      return await commitResumed(operation, hostResult?.changed === true);
    } catch (error) {
      return compensateFailedResume(operation, error);
    }
  }

  async function start({ domainId, previewDigest, confirmation } = {}) {
    if (typeof previewDigest !== 'string' || !SHA256_PATTERN.test(previewDigest)
      || typeof confirmation !== 'string' || !confirmation) {
      throw new DomainSuspensionRuntimeError(
        'domain_suspension_confirmation_invalid',
        'A current Domain suspension preview digest and exact confirmation are required',
        409,
      );
    }
    let preview;
    try { preview = await service.preview({ domainId }); }
    catch (error) { throw mapped(error); }
    if (!preview.readyToSuspend
      || preview.previewDigest !== previewDigest
      || preview.confirmation !== confirmation) {
      throw new DomainSuspensionRuntimeError(
        'domain_suspension_preview_stale',
        'Domain suspension preview is stale, blocked or confirmation is invalid',
        409,
      );
    }
    let operation;
    try { operation = await registry.create(preview); }
    catch (error) { throw mapped(error); }
    return runSuspend(operation.id, { allowHostMutation: true });
  }

  async function retrySuspend({
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
      throw new DomainSuspensionRuntimeError(
        'domain_suspension_operation_not_found',
        'Domain suspension operation was not found',
        404,
      );
    }
    if (!['suspending', 'failed'].includes(operation.status)
      || expectedUpdatedAt !== operation.updatedAt
      || checksum !== operation.checksum
      || confirmation !== suspendRetryConfirmation(operation)) {
      throw new DomainSuspensionRuntimeError(
        'domain_suspension_retry_stale',
        'Domain suspension retry request is stale or confirmation is invalid',
        409,
      );
    }
    return runSuspend(operation.id, { allowHostMutation: true });
  }

  async function resume({
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
      throw new DomainSuspensionRuntimeError(
        'domain_suspension_operation_not_found',
        'Domain suspension operation was not found',
        404,
      );
    }
    if (operation.status !== 'suspended'
      || expectedUpdatedAt !== operation.updatedAt
      || checksum !== operation.checksum
      || confirmation !== resumeConfirmation(operation)) {
      throw new DomainSuspensionRuntimeError(
        'domain_resume_stale',
        'Domain resume request is stale or confirmation is invalid',
        409,
      );
    }
    return runResume(operation.id, { allowHostMutation: true });
  }

  async function retryResume({
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
      throw new DomainSuspensionRuntimeError(
        'domain_suspension_operation_not_found',
        'Domain suspension operation was not found',
        404,
      );
    }
    if (!['resuming', 'resume_failed'].includes(operation.status)
      || expectedUpdatedAt !== operation.updatedAt
      || checksum !== operation.checksum
      || confirmation !== resumeRetryConfirmation(operation)) {
      throw new DomainSuspensionRuntimeError(
        'domain_resume_retry_stale',
        'Domain resume retry request is stale or confirmation is invalid',
        409,
      );
    }
    return runResume(operation.id, { allowHostMutation: true });
  }

  async function init() {
    try { await registry.init(); }
    catch (error) { throw mapped(error); }
    let interrupted;
    try { interrupted = await registry.listInterrupted(); }
    catch (error) { throw mapped(error); }
    const recovery = [];
    for (const operation of interrupted) {
      try {
        recovery.push(operation.status === 'suspending'
          ? await runSuspend(operation.id, { allowHostMutation: false })
          : await runResume(operation.id, { allowHostMutation: false }));
      } catch (error) {
        recovery.push(Object.freeze({
          operationId: operation.id,
          recovered: false,
          error: safeFailure(
            error,
            operation.status === 'suspending'
              ? 'domain_suspension_recovery_pending'
              : 'domain_resume_recovery_pending',
            operation.status === 'suspending'
              ? 'Domain suspension recovery remains pending'
              : 'Domain resume recovery remains pending',
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
    start,
    retrySuspend,
    resume,
    retryResume,
    get,
    listForDomain,
  });
}

export const domainSuspensionRuntimeInternals = Object.freeze({
  safeFailure,
  suspendRetryConfirmation,
  resumeConfirmation,
  resumeRetryConfirmation,
  publicOperation,
  currentPreviewMatches,
  inspectShape,
});
