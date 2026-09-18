import {
  dnsZoneRetirementOperationPublicView,
  DnsZoneRetirementOperationRegistryError,
} from './dns-zone-retirement-operation-registry.js';
import { DnsZoneRetirementError } from './dns-zone-retirement.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class DnsZoneRetirementRuntimeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsZoneRetirementRuntimeError';
    this.code = code;
    this.status = status;
  }
}

function safeFailure(error, fallbackCode = 'dns_zone_retirement_failed', fallbackMessage = 'DNS zone retirement failed') {
  const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,120}$/.test(error.code)
    ? error.code
    : fallbackCode;
  const message = typeof error?.message === 'string' && error.message.length > 0 && error.message.length <= 500
    ? error.message
    : fallbackMessage;
  return Object.freeze({ code, message });
}

function mapped(error) {
  if (error instanceof DnsZoneRetirementRuntimeError) return error;
  if (error instanceof DnsZoneRetirementError
    || error instanceof DnsZoneRetirementOperationRegistryError) {
    return new DnsZoneRetirementRuntimeError(error.code, error.message, error.status);
  }
  return error;
}

function retryConfirmation(operation) {
  return `retry-dns-zone-retirement:${operation.domainId}:${operation.id}:${operation.updatedAt}:${operation.snapshotDigest}`;
}

function publicOperation(operation) {
  if (!operation) return null;
  const base = dnsZoneRetirementOperationPublicView(operation);
  const retryable = ['deleting', 'failed'].includes(operation.status);
  return Object.freeze({
    ...base,
    recovery: Object.freeze({
      ...base.recovery,
      retryable,
      retryConfirmation: retryable ? retryConfirmation(operation) : null,
    }),
  });
}

function inspectionEvidence(operation, value) {
  if (!value || typeof value !== 'object'
    || value.zoneName !== operation.zoneName
    || value.snapshotDigest !== operation.snapshotDigest
    || typeof value.satisfied !== 'boolean'
    || typeof value.deleteCandidate !== 'boolean'
    || typeof value.deleted !== 'boolean'
    || value.satisfied !== value.deleted
    || (value.satisfied && value.deleteCandidate)
    || (!value.satisfied && !value.deleteCandidate)) {
    throw new DnsZoneRetirementRuntimeError(
      'dns_zone_retirement_inspection_invalid',
      'PowerDNS deletion inspection did not match retained snapshot evidence',
      503,
    );
  }
  return Object.freeze({
    satisfied: value.satisfied,
    deleteCandidate: value.deleteCandidate,
    deleted: value.deleted,
    zoneName: value.zoneName,
    snapshotDigest: value.snapshotDigest,
  });
}

function deletionEvidence(operation, value) {
  if (!value || value.satisfied !== true || value.deleted !== true
    || typeof value.changed !== 'boolean'
    || value.zoneName !== operation.zoneName
    || value.snapshotDigest !== operation.snapshotDigest) {
    throw new DnsZoneRetirementRuntimeError(
      'dns_zone_retirement_result_invalid',
      'PowerDNS deletion result did not match retained snapshot evidence',
      503,
    );
  }
  return Object.freeze({
    changed: value.changed,
    snapshotDigest: operation.snapshotDigest,
  });
}

function currentPreviewMatches(operation, preview) {
  return Boolean(preview
    && preview.retirementPlanReady === true
    && preview.domain?.id === operation.domainId
    && preview.domain?.serverId === operation.serverId
    && preview.domain?.primaryDomain === operation.zoneName
    && preview.domain?.desiredRevision === operation.domainRevision
    && preview.zone?.exists === true
    && preview.zone?.snapshotDigest === operation.snapshotDigest
    && preview.zone?.ownershipOrigin?.evidenceDigest === operation.ownershipEvidenceDigest
    && preview.retention?.snapshotRetentionDays === operation.snapshotRetentionDays
    && preview.previewDigest === operation.previewDigest
    && preview.confirmation === operation.confirmation);
}

export function createDnsZoneRetirementRuntime({ registry, service } = {}) {
  if (!registry || typeof registry.init !== 'function' || typeof registry.create !== 'function'
    || typeof registry.get !== 'function' || typeof registry.listForDomain !== 'function'
    || typeof registry.listInterrupted !== 'function' || typeof registry.markDeleting !== 'function'
    || typeof registry.succeed !== 'function' || typeof registry.fail !== 'function'
    || !service || typeof service.preview !== 'function'
    || typeof service.captureDeletionSnapshot !== 'function'
    || typeof service.inspectDeletion !== 'function'
    || typeof service.deleteCapturedSnapshot !== 'function') {
    throw new DnsZoneRetirementRuntimeError(
      'dns_zone_retirement_runtime_dependencies_invalid',
      'DNS zone retirement runtime dependencies are unavailable',
      503,
    );
  }

  async function inspect(operation) {
    let result;
    try {
      result = await service.inspectDeletion({
        serverId: operation.serverId,
        zoneName: operation.zoneName,
        snapshot: operation.snapshot,
      });
    } catch (error) { throw mapped(error); }
    return inspectionEvidence(operation, result);
  }

  async function completeFromInspection(operation, inspected) {
    if (!inspected.satisfied) return null;
    try {
      const completed = await registry.succeed(operation.id, {
        changed: false,
        snapshotDigest: operation.snapshotDigest,
      });
      return publicOperation(completed);
    } catch (error) { throw mapped(error); }
  }

  async function currentPreview(operation) {
    let preview;
    try { preview = await service.preview({ domainId: operation.domainId }); }
    catch (error) { throw mapped(error); }
    return preview;
  }

  async function execute(operationId) {
    let operation;
    try { operation = await registry.get(operationId); }
    catch (error) { throw mapped(error); }
    if (!operation) {
      throw new DnsZoneRetirementRuntimeError(
        'dns_zone_retirement_operation_not_found',
        'DNS zone retirement operation was not found',
        404,
      );
    }
    if (operation.status === 'deleted') return publicOperation(operation);
    if (['pending', 'failed'].includes(operation.status)) {
      try { operation = await registry.markDeleting(operation.id); }
      catch (error) { throw mapped(error); }
    }

    let inspected;
    try { inspected = await inspect(operation); }
    catch (error) {
      if (Number(error?.status) === 409) {
        try {
          return publicOperation(await registry.fail(
            operation.id,
            safeFailure(error, 'dns_zone_retirement_snapshot_drift', 'DNS zone drifted after snapshot capture'),
          ));
        } catch (registryError) { throw mapped(registryError); }
      }
      throw new DnsZoneRetirementRuntimeError(
        'dns_zone_retirement_recovery_inspection_unavailable',
        'DNS zone retirement state cannot be inspected; automatic mutation replay is blocked',
        503,
      );
    }
    if (inspected.satisfied) return completeFromInspection(operation, inspected);

    const preview = await currentPreview(operation);
    if (!currentPreviewMatches(operation, preview)) {
      try {
        return publicOperation(await registry.fail(operation.id, {
          code: 'dns_zone_retirement_preview_stale',
          message: 'Domain, ownership, retention policy or authoritative zone state changed after snapshot capture',
        }));
      } catch (error) { throw mapped(error); }
    }

    let deleted;
    try {
      deleted = await service.deleteCapturedSnapshot({
        serverId: operation.serverId,
        zoneName: operation.zoneName,
        snapshot: operation.snapshot,
      });
    } catch (deleteError) {
      let after;
      try { after = await inspect(operation); }
      catch (inspectionError) {
        if (Number(inspectionError?.status) === 409) {
          try {
            return publicOperation(await registry.fail(
              operation.id,
              safeFailure(
                inspectionError,
                'dns_zone_retirement_snapshot_drift',
                'DNS zone drifted during retirement',
              ),
            ));
          } catch (registryError) { throw mapped(registryError); }
        }
        throw new DnsZoneRetirementRuntimeError(
          'dns_zone_retirement_result_uncertain',
          'PowerDNS deletion result is uncertain and current state cannot be inspected; automatic replay is blocked',
          503,
        );
      }
      if (after.satisfied) return completeFromInspection(operation, after);
      try {
        return publicOperation(await registry.fail(
          operation.id,
          safeFailure(deleteError),
        ));
      } catch (error) { throw mapped(error); }
    }

    let evidence;
    try { evidence = deletionEvidence(operation, deleted); }
    catch (error) {
      let after;
      try { after = await inspect(operation); }
      catch {
        throw new DnsZoneRetirementRuntimeError(
          'dns_zone_retirement_result_uncertain',
          'PowerDNS deletion evidence is invalid and current state cannot be inspected; automatic replay is blocked',
          503,
        );
      }
      if (after.satisfied) return completeFromInspection(operation, after);
      try {
        return publicOperation(await registry.fail(operation.id, safeFailure(error)));
      } catch (registryError) { throw mapped(registryError); }
    }

    try {
      return publicOperation(await registry.succeed(operation.id, evidence));
    } catch (error) { throw mapped(error); }
  }

  async function start({ domainId, previewDigest, confirmation } = {}) {
    if (typeof previewDigest !== 'string' || !SHA256_PATTERN.test(previewDigest)
      || typeof confirmation !== 'string' || !confirmation) {
      throw new DnsZoneRetirementRuntimeError(
        'dns_zone_retirement_confirmation_invalid',
        'A current DNS zone retirement preview digest and exact confirmation are required',
        409,
      );
    }
    let capture;
    try {
      capture = await service.captureDeletionSnapshot({
        domainId,
        previewDigest,
        confirmation,
      });
    } catch (error) { throw mapped(error); }

    let operation;
    try { operation = await registry.create(capture); }
    catch (error) { throw mapped(error); }
    return execute(operation.id);
  }

  async function retry({
    domainId,
    operationId,
    expectedUpdatedAt,
    snapshotDigest,
    confirmation,
  } = {}) {
    let operation;
    try { operation = await registry.get(operationId); }
    catch (error) { throw mapped(error); }
    if (!operation || operation.domainId !== domainId) {
      throw new DnsZoneRetirementRuntimeError(
        'dns_zone_retirement_operation_not_found',
        'DNS zone retirement operation was not found',
        404,
      );
    }
    if (!['deleting', 'failed'].includes(operation.status)) {
      throw new DnsZoneRetirementRuntimeError(
        'dns_zone_retirement_retry_not_available',
        'DNS zone retirement operation is not retryable',
        409,
      );
    }
    if (expectedUpdatedAt !== operation.updatedAt
      || snapshotDigest !== operation.snapshotDigest
      || confirmation !== retryConfirmation(operation)) {
      throw new DnsZoneRetirementRuntimeError(
        'dns_zone_retirement_retry_stale',
        'DNS zone retirement retry request is stale or confirmation is invalid',
        409,
      );
    }
    return execute(operation.id);
  }

  async function reconcileInterrupted(operation) {
    let inspected;
    try { inspected = await inspect(operation); }
    catch (error) {
      if (Number(error?.status) === 409) {
        const failed = await registry.fail(
          operation.id,
          safeFailure(error, 'dns_zone_retirement_snapshot_drift', 'DNS zone drifted after interrupted deletion'),
        );
        return Object.freeze({
          operationId: operation.id,
          recovered: true,
          operation: publicOperation(failed),
        });
      }
      return Object.freeze({
        operationId: operation.id,
        recovered: false,
        error: safeFailure(
          error,
          'dns_zone_retirement_recovery_pending',
          'DNS zone retirement recovery remains pending',
        ),
      });
    }
    if (inspected.satisfied) {
      const completed = await registry.succeed(operation.id, {
        changed: false,
        snapshotDigest: operation.snapshotDigest,
      });
      return Object.freeze({
        operationId: operation.id,
        recovered: true,
        operation: publicOperation(completed),
      });
    }
    return Object.freeze({
      operationId: operation.id,
      recovered: false,
      operation: publicOperation(operation),
      error: Object.freeze({
        code: 'dns_zone_retirement_retry_required',
        message: 'Retained DNS zone snapshot is still present; explicit retry is required',
      }),
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
            'dns_zone_retirement_recovery_pending',
            'DNS zone retirement recovery remains pending',
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
    try {
      return Object.freeze((await registry.listForDomain(domainId)).map(publicOperation));
    } catch (error) { throw mapped(error); }
  }

  return Object.freeze({
    init,
    start,
    retry,
    get,
    listForDomain,
  });
}

export const dnsZoneRetirementRuntimeInternals = Object.freeze({
  safeFailure,
  retryConfirmation,
  publicOperation,
  inspectionEvidence,
  deletionEvidence,
  currentPreviewMatches,
});
