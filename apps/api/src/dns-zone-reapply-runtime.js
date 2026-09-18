import {
  dnsZoneReapplyOperationPublicView,
  DnsZoneReapplyOperationRegistryError,
} from './dns-zone-reapply-operation-registry.js';
import { DnsZoneReapplyError } from './dns-zone-reapply.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class DnsZoneReapplyRuntimeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsZoneReapplyRuntimeError';
    this.code = code;
    this.status = status;
  }
}

function safeFailure(error, fallbackCode = 'dns_zone_reapply_failed', fallbackMessage = 'DNS zone reapply failed') {
  const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,120}$/.test(error.code)
    ? error.code
    : fallbackCode;
  const message = typeof error?.message === 'string' && error.message.length > 0 && error.message.length <= 500
    ? error.message
    : fallbackMessage;
  return Object.freeze({ code, message });
}

function mapped(error) {
  if (error instanceof DnsZoneReapplyRuntimeError) return error;
  if (error instanceof DnsZoneReapplyError || error instanceof DnsZoneReapplyOperationRegistryError) {
    return new DnsZoneReapplyRuntimeError(error.code, error.message, error.status);
  }
  return error;
}

function targetSatisfied(operation, preview) {
  return Boolean(preview
    && preview.noChanges === true
    && preview.domainId === operation.domainId
    && preview.serverId === operation.serverId
    && preview.zoneName === operation.zoneName
    && preview.domainRevision === operation.domainRevision
    && preview.templateVersion === operation.templateVersion
    && preview.dnsIdentityRevision === operation.dnsIdentityRevision
    && operation.mailStateDigest !== null
    && preview.mailStateDigest === operation.mailStateDigest
    && operation.appliedZoneDigest !== null
    && preview.sourceZoneDigest === operation.appliedZoneDigest
    && Number.isSafeInteger(preview.observedSerial)
    && preview.observedSerial >= operation.targetSerial);
}

function currentPreviewMatches(operation, preview) {
  return Boolean(preview
    && preview.applyAllowed === true
    && preview.noChanges === false
    && preview.domainId === operation.domainId
    && preview.serverId === operation.serverId
    && preview.zoneName === operation.zoneName
    && preview.domainRevision === operation.domainRevision
    && preview.templateVersion === operation.templateVersion
    && preview.dnsIdentityRevision === operation.dnsIdentityRevision
    && operation.mailStateDigest !== null
    && preview.mailStateDigest === operation.mailStateDigest
    && operation.sourceZoneDigest !== null
    && operation.appliedZoneDigest !== null
    && preview.sourceZoneDigest === operation.sourceZoneDigest
    && preview.observedSerial === operation.observedSerial
    && preview.nextSerial === operation.targetSerial
    && preview.previewDigest === operation.previewDigest
    && preview.confirmation === operation.confirmation);
}

function evidenceFromPreview(operation, preview) {
  return Object.freeze({
    satisfied: true,
    zoneName: operation.zoneName,
    serial: preview.observedSerial,
    changedRrsetCount: 0,
    manualRrsetCount: Number.isSafeInteger(preview.preservedManualRrsetCount)
      ? preview.preservedManualRrsetCount
      : 0,
  });
}

function evidenceFromApply(operation, result) {
  if (!result || result.satisfied !== true || result.zoneName !== operation.zoneName
    || !Number.isSafeInteger(result.serial) || result.serial < operation.targetSerial
    || !Number.isSafeInteger(result.changedRrsetCount) || result.changedRrsetCount < 0
    || !Number.isSafeInteger(result.manualRrsetCount) || result.manualRrsetCount < 0) {
    throw new DnsZoneReapplyRuntimeError(
      'dns_zone_reapply_evidence_invalid',
      'DNS provider did not return valid reapply post-condition evidence',
      503,
    );
  }
  return Object.freeze({
    satisfied: true,
    zoneName: operation.zoneName,
    serial: result.serial,
    changedRrsetCount: result.changedRrsetCount,
    manualRrsetCount: result.manualRrsetCount,
  });
}

function rollbackConfirmation(operation) {
  return `rollback-dns-zone-reapply:${operation.domainId}:${operation.id}:${operation.updatedAt}:${operation.sourceZoneDigest}:${operation.appliedZoneDigest}`;
}

function rollbackResultEvidence(operation, result) {
  if (!result || result.satisfied !== true || result.zoneName !== operation.zoneName
    || !Number.isSafeInteger(result.restoredRrsetCount) || result.restoredRrsetCount < 0
    || typeof result.kindRestored !== 'boolean'
    || result.sourceZoneDigest !== operation.sourceZoneDigest) {
    throw new DnsZoneReapplyRuntimeError(
      'dns_zone_reapply_rollback_evidence_invalid',
      'DNS provider did not return valid rollback post-condition evidence',
      503,
    );
  }
  return Object.freeze({
    satisfied: true,
    zoneName: operation.zoneName,
    restoredRrsetCount: result.restoredRrsetCount,
    kindRestored: result.kindRestored,
    sourceZoneDigest: operation.sourceZoneDigest,
  });
}

export function createDnsZoneReapplyRuntime({ registry, service } = {}) {
  if (!registry || typeof registry.init !== 'function' || typeof registry.create !== 'function'
    || typeof registry.get !== 'function' || typeof registry.listForDomain !== 'function'
    || typeof registry.listInterrupted !== 'function' || typeof registry.listInterruptedRollbacks !== 'function'
    || typeof registry.markApplying !== 'function' || typeof registry.succeed !== 'function' || typeof registry.fail !== 'function'
    || typeof registry.markRollingBack !== 'function' || typeof registry.succeedRollback !== 'function'
    || typeof registry.failRollback !== 'function'
    || !service || typeof service.preview !== 'function'
    || typeof service.captureRollbackSnapshot !== 'function' || typeof service.apply !== 'function'
    || typeof service.inspectRollback !== 'function' || typeof service.rollback !== 'function') {
    throw new DnsZoneReapplyRuntimeError(
      'dns_zone_reapply_runtime_dependencies_invalid',
      'DNS zone reapply runtime dependencies are unavailable',
      503,
    );
  }

  async function preview(input) {
    try { return await service.preview(input); }
    catch (error) { throw mapped(error); }
  }

  async function inspectTarget(operation) {
    const current = await preview({ domainId: operation.domainId });
    return Object.freeze({ current, satisfied: targetSatisfied(operation, current) });
  }

  async function completeFromInspection(operation, current) {
    const completed = await registry.succeed(operation.id, evidenceFromPreview(operation, current));
    return dnsZoneReapplyOperationPublicView(completed);
  }

  async function inspectRollback(operation) {
    if (operation.sourceZoneSnapshot === null || operation.appliedZoneSnapshot === null
      || operation.sourceZoneDigest === null || operation.appliedZoneDigest === null) {
      throw new DnsZoneReapplyRuntimeError(
        'dns_zone_reapply_rollback_evidence_missing',
        'DNS zone reapply operation has no exact before/after rollback evidence',
        409,
      );
    }
    let inspected;
    try {
      inspected = await service.inspectRollback({
        domainId: operation.domainId,
        before: operation.sourceZoneSnapshot,
        after: operation.appliedZoneSnapshot,
      });
    } catch (error) { throw mapped(error); }
    if (!inspected || inspected.zoneName !== operation.zoneName
      || inspected.sourceZoneDigest !== operation.sourceZoneDigest
      || inspected.appliedZoneDigest !== operation.appliedZoneDigest
      || typeof inspected.satisfied !== 'boolean'
      || typeof inspected.repairCandidate !== 'boolean') {
      throw new DnsZoneReapplyRuntimeError(
        'dns_zone_reapply_rollback_inspection_invalid',
        'DNS rollback inspection did not match the journaled before/after evidence',
        503,
      );
    }
    return inspected;
  }

  async function failFromObservedState(operation, fallbackFailure) {
    if (operation.sourceZoneSnapshot === null || operation.appliedZoneSnapshot === null
      || operation.sourceZoneDigest === null || operation.appliedZoneDigest === null) {
      return dnsZoneReapplyOperationPublicView(await registry.fail(operation.id, {
        code: 'dns_zone_reapply_rollback_evidence_missing',
        message: 'DNS zone reapply operation predates exact before/after rollback evidence and cannot be replayed safely',
      }));
    }

    let rollbackInspection;
    try { rollbackInspection = await inspectRollback(operation); }
    catch (error) {
      if (Number(error?.status) !== 409) {
        throw new DnsZoneReapplyRuntimeError(
          'dns_zone_reapply_recovery_inspection_unavailable',
          'DNS zone reapply state is uncertain and rollback ownership cannot be inspected; operation remains applying',
          503,
        );
      }
      return dnsZoneReapplyOperationPublicView(await registry.fail(
        operation.id,
        safeFailure(error, 'dns_zone_reapply_rollback_drift', 'DNS zone state drifted outside the journaled reapply operation'),
      ));
    }

    const failure = rollbackInspection.satisfied
      ? fallbackFailure
      : rollbackInspection.repairCandidate
        ? Object.freeze({
          code: 'dns_zone_reapply_partial_apply_detected',
          message: 'DNS zone contains an operation-owned mixed before/after state; exact rollback is available',
        })
        : fallbackFailure;
    return dnsZoneReapplyOperationPublicView(await registry.fail(operation.id, failure));
  }

  async function reconcileInterruptedRollback(operation) {
    let inspected;
    try { inspected = await inspectRollback(operation); }
    catch (error) {
      if (Number(error?.status) === 409) {
        const failed = await registry.failRollback(
          operation.id,
          safeFailure(error, 'dns_zone_reapply_rollback_drift', 'DNS zone rollback state drifted'),
        );
        return dnsZoneReapplyOperationPublicView(failed);
      }
      throw new DnsZoneReapplyRuntimeError(
        'dns_zone_reapply_rollback_recovery_pending',
        'Interrupted DNS zone rollback cannot be reconciled because current zone state is unavailable',
        503,
      );
    }
    if (inspected.satisfied) {
      const completed = await registry.succeedRollback(operation.id, {
        satisfied: true,
        zoneName: operation.zoneName,
        restoredRrsetCount: 0,
        kindRestored: false,
        sourceZoneDigest: operation.sourceZoneDigest,
      });
      return dnsZoneReapplyOperationPublicView(completed);
    }
    const failed = await registry.failRollback(operation.id, {
      code: 'dns_zone_reapply_rollback_interrupted',
      message: 'Interrupted DNS zone rollback was inspected; automatic mutation replay remains blocked',
    });
    return dnsZoneReapplyOperationPublicView(failed);
  }

  async function run(operationId) {
    let operation;
    try { operation = await registry.get(operationId); }
    catch (error) { throw mapped(error); }
    if (!operation) {
      throw new DnsZoneReapplyRuntimeError('dns_zone_reapply_operation_not_found', 'DNS zone reapply operation was not found', 404);
    }
    if (!['pending', 'applying'].includes(operation.status)) {
      return dnsZoneReapplyOperationPublicView(operation);
    }
    if (operation.status === 'pending') {
      try { operation = await registry.markApplying(operation.id); }
      catch (error) { throw mapped(error); }
    }

    let inspection;
    try { inspection = await inspectTarget(operation); }
    catch (error) {
      throw new DnsZoneReapplyRuntimeError(
        'dns_zone_reapply_recovery_inspection_unavailable',
        'DNS zone reapply state could not be inspected; operation remains applying for safe retry',
        503,
      );
    }
    if (inspection.satisfied) {
      try { return await completeFromInspection(operation, inspection.current); }
      catch (error) { throw mapped(error); }
    }

    if (!currentPreviewMatches(operation, inspection.current)) {
      try {
        return await failFromObservedState(operation, Object.freeze({
          code: 'dns_zone_reapply_preview_stale',
          message: 'DNS zone, Domain, Zone Template or server DNS identity changed after the operation was journaled',
        }));
      } catch (error) { throw mapped(error); }
    }

    let applied;
    try {
      applied = await service.apply({
        domainId: operation.domainId,
        previewDigest: operation.previewDigest,
        confirmation: operation.confirmation,
      });
    } catch (applyError) {
      let after;
      try { after = await inspectTarget(operation); }
      catch {
        throw new DnsZoneReapplyRuntimeError(
          'dns_zone_reapply_postcondition_unavailable',
          'DNS provider result is uncertain and the post-condition cannot be inspected; operation remains applying',
          503,
        );
      }
      if (after.satisfied) {
        try { return await completeFromInspection(operation, after.current); }
        catch (error) { throw mapped(error); }
      }
      const failure = safeFailure(applyError);
      try { return await failFromObservedState(operation, failure); }
      catch (error) { throw mapped(error); }
    }

    let evidence;
    try { evidence = evidenceFromApply(operation, applied); }
    catch (error) {
      let after;
      try { after = await inspectTarget(operation); }
      catch {
        throw new DnsZoneReapplyRuntimeError(
          'dns_zone_reapply_postcondition_unavailable',
          'DNS provider evidence is invalid and the post-condition cannot be inspected; operation remains applying',
          503,
        );
      }
      if (after.satisfied) return completeFromInspection(operation, after.current);
      const failure = safeFailure(error, 'dns_zone_reapply_evidence_invalid', 'DNS provider evidence is invalid');
      return failFromObservedState(operation, failure);
    }

    let afterApply;
    try { afterApply = await inspectTarget(operation); }
    catch {
      throw new DnsZoneReapplyRuntimeError(
        'dns_zone_reapply_postcondition_unavailable',
        'DNS provider returned success but the exact journaled after-state cannot be inspected; operation remains applying',
        503,
      );
    }
    if (!afterApply.satisfied) {
      try {
        return await failFromObservedState(operation, Object.freeze({
          code: 'dns_zone_reapply_postcondition_unverified',
          message: 'DNS provider returned success but the exact journaled after-state is not proven',
        }));
      } catch (error) { throw mapped(error); }
    }
    try {
      return dnsZoneReapplyOperationPublicView(await registry.succeed(operation.id, evidence));
    } catch (error) { throw mapped(error); }
  }

  async function start({ domainId, previewDigest, confirmation } = {}) {
    if (typeof previewDigest !== 'string' || !SHA256_PATTERN.test(previewDigest)
      || typeof confirmation !== 'string' || !confirmation) {
      throw new DnsZoneReapplyRuntimeError(
        'dns_zone_reapply_confirmation_invalid',
        'A current DNS zone reapply preview digest and exact confirmation are required',
        409,
      );
    }
    const current = await preview({ domainId });
    if (current.noChanges) {
      throw new DnsZoneReapplyRuntimeError('dns_zone_reapply_no_changes', 'DNS zone already matches the current Zone Template', 409);
    }
    if (current.applyAllowed !== true || current.previewDigest !== previewDigest || current.confirmation !== confirmation) {
      throw new DnsZoneReapplyRuntimeError(
        'dns_zone_reapply_confirmation_invalid',
        'DNS zone reapply preview is stale, blocked or confirmation is invalid',
        409,
      );
    }
    let rollbackEvidence;
    try {
      rollbackEvidence = await service.captureRollbackSnapshot({
        domainId,
        preview: current,
      });
    } catch (error) { throw mapped(error); }
    let operation;
    try { operation = await registry.create(current, rollbackEvidence); }
    catch (error) { throw mapped(error); }
    return run(operation.id);
  }

  async function rollbackPreview({ domainId, operationId } = {}) {
    let operation;
    try { operation = await registry.get(operationId); }
    catch (error) { throw mapped(error); }
    if (!operation || operation.domainId !== domainId) {
      throw new DnsZoneReapplyRuntimeError('dns_zone_reapply_operation_not_found', 'DNS zone reapply operation was not found', 404);
    }
    if (operation.status === 'rolling_back') {
      await reconcileInterruptedRollback(operation);
      operation = await registry.get(operation.id);
    }
    if (!['succeeded', 'failed', 'rollback_failed', 'rolled_back'].includes(operation.status)) {
      throw new DnsZoneReapplyRuntimeError(
        'dns_zone_reapply_rollback_not_available',
        'DNS zone reapply operation is not eligible for rollback',
        409,
      );
    }
    const inspected = await inspectRollback(operation);
    const publicOperation = dnsZoneReapplyOperationPublicView(operation);
    return Object.freeze({
      operation: publicOperation,
      inspection: inspected,
      confirmation: publicOperation.rollback.available
        ? rollbackConfirmation(operation)
        : null,
    });
  }

  async function rollback({
    domainId,
    operationId,
    expectedUpdatedAt,
    sourceZoneDigest,
    appliedZoneDigest,
    confirmation,
  } = {}) {
    let operation;
    try { operation = await registry.get(operationId); }
    catch (error) { throw mapped(error); }
    if (!operation || operation.domainId !== domainId) {
      throw new DnsZoneReapplyRuntimeError('dns_zone_reapply_operation_not_found', 'DNS zone reapply operation was not found', 404);
    }
    const publicOperation = dnsZoneReapplyOperationPublicView(operation);
    if (!publicOperation.rollback.available) {
      throw new DnsZoneReapplyRuntimeError('dns_zone_reapply_rollback_not_available', 'DNS zone reapply rollback is not available', 409);
    }
    if (expectedUpdatedAt !== operation.updatedAt
      || sourceZoneDigest !== operation.sourceZoneDigest
      || appliedZoneDigest !== operation.appliedZoneDigest
      || confirmation !== rollbackConfirmation(operation)) {
      throw new DnsZoneReapplyRuntimeError(
        'dns_zone_reapply_rollback_stale',
        'DNS zone rollback request is stale or confirmation is invalid',
        409,
      );
    }

    const before = await inspectRollback(operation);
    try { operation = await registry.markRollingBack(operation.id); }
    catch (error) { throw mapped(error); }
    if (before.satisfied) {
      return dnsZoneReapplyOperationPublicView(await registry.succeedRollback(operation.id, {
        satisfied: true,
        zoneName: operation.zoneName,
        restoredRrsetCount: 0,
        kindRestored: false,
        sourceZoneDigest: operation.sourceZoneDigest,
      }));
    }

    let result;
    try {
      result = await service.rollback({
        domainId: operation.domainId,
        before: operation.sourceZoneSnapshot,
        after: operation.appliedZoneSnapshot,
      });
      const evidence = rollbackResultEvidence(operation, result);
      return dnsZoneReapplyOperationPublicView(await registry.succeedRollback(operation.id, evidence));
    } catch (rollbackError) {
      let inspected;
      try { inspected = await inspectRollback(operation); }
      catch (inspectionError) {
        if (Number(inspectionError?.status) === 409) {
          const failed = await registry.failRollback(
            operation.id,
            safeFailure(inspectionError, 'dns_zone_reapply_rollback_drift', 'DNS zone rollback state drifted'),
          );
          return dnsZoneReapplyOperationPublicView(failed);
        }
        throw new DnsZoneReapplyRuntimeError(
          'dns_zone_reapply_rollback_recovery_pending',
          'DNS zone rollback result is uncertain and current zone state cannot be inspected; automatic replay is blocked',
          503,
        );
      }
      if (inspected.satisfied) {
        return dnsZoneReapplyOperationPublicView(await registry.succeedRollback(operation.id, {
          satisfied: true,
          zoneName: operation.zoneName,
          restoredRrsetCount: 0,
          kindRestored: false,
          sourceZoneDigest: operation.sourceZoneDigest,
        }));
      }
      const failed = await registry.failRollback(
        operation.id,
        safeFailure(rollbackError, 'dns_zone_reapply_rollback_failed', 'DNS zone rollback failed'),
      );
      return dnsZoneReapplyOperationPublicView(failed);
    }
  }

  async function get(operationId) {
    try { return dnsZoneReapplyOperationPublicView(await registry.get(operationId)); }
    catch (error) { throw mapped(error); }
  }

  async function listForDomain(domainId) {
    try { return Object.freeze((await registry.listForDomain(domainId)).map(dnsZoneReapplyOperationPublicView)); }
    catch (error) { throw mapped(error); }
  }

  async function init() {
    try { await registry.init(); }
    catch (error) { throw mapped(error); }
    const interrupted = await registry.listInterrupted();
    const recovery = [];
    for (const operation of interrupted) {
      try {
        recovery.push(Object.freeze({ operationId: operation.id, recovered: true, operation: await run(operation.id) }));
      } catch (error) {
        recovery.push(Object.freeze({
          operationId: operation.id,
          recovered: false,
          error: safeFailure(error, 'dns_zone_reapply_recovery_pending', 'DNS zone reapply recovery remains pending'),
        }));
      }
    }
    const interruptedRollbacks = await registry.listInterruptedRollbacks();
    for (const operation of interruptedRollbacks) {
      try {
        recovery.push(Object.freeze({
          operationId: operation.id,
          recovered: true,
          operation: await reconcileInterruptedRollback(operation),
        }));
      } catch (error) {
        recovery.push(Object.freeze({
          operationId: operation.id,
          recovered: false,
          error: safeFailure(error, 'dns_zone_reapply_rollback_recovery_pending', 'DNS zone rollback recovery remains pending'),
        }));
      }
    }
    return Object.freeze(recovery);
  }

  return Object.freeze({
    init,
    preview,
    start,
    run,
    rollbackPreview,
    rollback,
    get,
    listForDomain,
  });
}

export const dnsZoneReapplyRuntimeInternals = Object.freeze({
  safeFailure,
  targetSatisfied,
  currentPreviewMatches,
  evidenceFromPreview,
  evidenceFromApply,
  rollbackConfirmation,
  rollbackResultEvidence,
});
