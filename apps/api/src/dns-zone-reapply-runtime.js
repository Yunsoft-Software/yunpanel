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

export function createDnsZoneReapplyRuntime({ registry, service } = {}) {
  if (!registry || typeof registry.init !== 'function' || typeof registry.create !== 'function'
    || typeof registry.get !== 'function' || typeof registry.listForDomain !== 'function'
    || typeof registry.listInterrupted !== 'function' || typeof registry.markApplying !== 'function'
    || typeof registry.succeed !== 'function' || typeof registry.fail !== 'function'
    || !service || typeof service.preview !== 'function' || typeof service.apply !== 'function') {
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

  async function run(operationId) {
    let operation;
    try { operation = await registry.get(operationId); }
    catch (error) { throw mapped(error); }
    if (!operation) {
      throw new DnsZoneReapplyRuntimeError('dns_zone_reapply_operation_not_found', 'DNS zone reapply operation was not found', 404);
    }
    if (operation.status === 'succeeded' || operation.status === 'failed') {
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
      const failure = Object.freeze({
        code: 'dns_zone_reapply_preview_stale',
        message: 'DNS zone, Domain, Zone Template or server DNS identity changed after the operation was journaled',
      });
      try {
        return dnsZoneReapplyOperationPublicView(await registry.fail(operation.id, failure));
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
      try {
        return dnsZoneReapplyOperationPublicView(await registry.fail(operation.id, failure));
      } catch (error) { throw mapped(error); }
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
      return dnsZoneReapplyOperationPublicView(await registry.fail(operation.id, failure));
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
    let operation;
    try { operation = await registry.create(current); }
    catch (error) { throw mapped(error); }
    return run(operation.id);
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
    return Object.freeze(recovery);
  }

  return Object.freeze({ init, preview, start, run, get, listForDomain });
}

export const dnsZoneReapplyRuntimeInternals = Object.freeze({
  safeFailure,
  targetSatisfied,
  currentPreviewMatches,
  evidenceFromPreview,
  evidenceFromApply,
});
