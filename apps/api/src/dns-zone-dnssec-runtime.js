import {
  dnsZoneDnssecOperationPublicView,
  DnsZoneDnssecOperationRegistryError,
} from './dns-zone-dnssec-operation-registry.js';
import { DnsZoneDnssecError } from './dns-zone-dnssec.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class DnsZoneDnssecRuntimeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsZoneDnssecRuntimeError';
    this.code = code;
    this.status = status;
  }
}

function safeFailure(error, fallbackCode = 'dnssec_operation_failed', fallbackMessage = 'DNSSEC operation failed') {
  const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,120}$/.test(error.code)
    ? error.code
    : fallbackCode;
  const message = typeof error?.message === 'string' && error.message.length > 0 && error.message.length <= 500
    ? error.message
    : fallbackMessage;
  return Object.freeze({ code, message });
}

function mapped(error) {
  if (error instanceof DnsZoneDnssecRuntimeError) return error;
  if (error instanceof DnsZoneDnssecError || error instanceof DnsZoneDnssecOperationRegistryError) {
    return new DnsZoneDnssecRuntimeError(error.code, error.message, error.status);
  }
  return error;
}

function stateIdentityMatches(operation, state) {
  return Boolean(state
    && state.domainId === operation.domainId
    && state.serverId === operation.serverId
    && state.zoneName === operation.zoneName);
}

function targetAssessment(operation, state) {
  if (!stateIdentityMatches(operation, state)) {
    return Object.freeze({ satisfied: false, compromised: false, uncertain: false, reason: 'identity_drift' });
  }
  if (operation.targetEnabled) {
    return Object.freeze({
      satisfied: state.dnssec === true,
      compromised: false,
      uncertain: false,
      reason: state.dnssec === true ? null : 'dnssec_not_enabled',
    });
  }
  if (state.dnssec !== false) {
    return Object.freeze({ satisfied: false, compromised: false, uncertain: false, reason: 'dnssec_not_disabled' });
  }
  if (state.parent?.status === 'absent') {
    return Object.freeze({ satisfied: true, compromised: false, uncertain: false, reason: null });
  }
  if (state.parent?.status === 'present') {
    return Object.freeze({ satisfied: false, compromised: true, uncertain: false, reason: 'parent_ds_without_dnssec' });
  }
  return Object.freeze({ satisfied: false, compromised: false, uncertain: true, reason: 'parent_ds_unverifiable' });
}

function currentPreviewMatches(operation, preview) {
  return Boolean(preview
    && preview.domainId === operation.domainId
    && preview.serverId === operation.serverId
    && preview.zoneName === operation.zoneName
    && preview.targetEnabled === operation.targetEnabled
    && preview.applyAllowed === true
    && preview.noChanges === false
    && preview.previewDigest === operation.previewDigest
    && preview.confirmation === operation.confirmation);
}

function evidenceFromState(operation, state) {
  if (!stateIdentityMatches(operation, state)
    || typeof state.dnssec !== 'boolean'
    || typeof state.status !== 'string' || !state.status
    || typeof state.secureReady !== 'boolean'
    || !Array.isArray(state.ds)
    || !state.parent || !['present', 'absent', 'unverifiable'].includes(state.parent.status)
    || !Array.isArray(state.parent.records) || !Array.isArray(state.parent.matchingRecords)) {
    throw new DnsZoneDnssecRuntimeError('dnssec_operation_evidence_invalid', 'DNSSEC post-condition evidence is invalid', 503);
  }
  return Object.freeze({
    zoneName: operation.zoneName,
    dnssec: state.dnssec,
    status: state.status,
    secureReady: state.secureReady,
    serial: Number.isSafeInteger(state.serial) && state.serial > 0 ? state.serial : null,
    ds: Object.freeze([...state.ds]),
    parentStatus: state.parent.status,
    parentRecords: Object.freeze([...state.parent.records]),
    parentMatchingRecords: Object.freeze([...state.parent.matchingRecords]),
  });
}

export function createDnsZoneDnssecRuntime({ registry, service } = {}) {
  if (!registry || typeof registry.init !== 'function' || typeof registry.create !== 'function'
    || typeof registry.get !== 'function' || typeof registry.listForDomain !== 'function'
    || typeof registry.listInterrupted !== 'function' || typeof registry.markApplying !== 'function'
    || typeof registry.succeed !== 'function' || typeof registry.fail !== 'function'
    || !service || typeof service.status !== 'function' || typeof service.preview !== 'function' || typeof service.apply !== 'function') {
    throw new DnsZoneDnssecRuntimeError('dnssec_runtime_dependencies_invalid', 'DNSSEC runtime dependencies are unavailable', 503);
  }

  async function status(input) {
    try { return await service.status(input); }
    catch (error) { throw mapped(error); }
  }

  async function preview(input) {
    try { return await service.preview(input); }
    catch (error) { throw mapped(error); }
  }

  async function inspectTarget(operation) {
    const current = await status({ domainId: operation.domainId });
    return Object.freeze({ current, assessment: targetAssessment(operation, current) });
  }

  async function succeedFromState(operation, state) {
    const completed = await registry.succeed(operation.id, evidenceFromState(operation, state));
    return dnsZoneDnssecOperationPublicView(completed);
  }

  async function failCompromised(operation, assessment) {
    const failure = Object.freeze({
      code: 'dnssec_disable_parent_regressed',
      message: assessment.reason === 'parent_ds_without_dnssec'
        ? 'DNSSEC is disabled but a parent DS is published; restore signing or remove the parent DS immediately'
        : 'DNSSEC operation post-condition is unsafe',
    });
    return dnsZoneDnssecOperationPublicView(await registry.fail(operation.id, failure));
  }

  async function run(operationId) {
    let operation;
    try { operation = await registry.get(operationId); }
    catch (error) { throw mapped(error); }
    if (!operation) throw new DnsZoneDnssecRuntimeError('dnssec_operation_not_found', 'DNSSEC operation was not found', 404);
    if (operation.status === 'succeeded' || operation.status === 'failed') return dnsZoneDnssecOperationPublicView(operation);
    if (operation.status === 'pending') {
      try { operation = await registry.markApplying(operation.id); }
      catch (error) { throw mapped(error); }
    }

    let inspection;
    try { inspection = await inspectTarget(operation); }
    catch {
      throw new DnsZoneDnssecRuntimeError(
        'dnssec_recovery_inspection_unavailable',
        'DNSSEC state could not be inspected; operation remains applying for safe retry',
        503,
      );
    }
    if (inspection.assessment.satisfied) {
      try { return await succeedFromState(operation, inspection.current); }
      catch (error) { throw mapped(error); }
    }
    if (inspection.assessment.compromised) {
      try { return await failCompromised(operation, inspection.assessment); }
      catch (error) { throw mapped(error); }
    }
    if (inspection.assessment.uncertain) {
      throw new DnsZoneDnssecRuntimeError(
        'dnssec_recovery_parent_unverifiable',
        'Parent DS state is unverifiable after DNSSEC disable; operation remains applying',
        503,
      );
    }

    let currentPreview;
    try { currentPreview = await preview({ domainId: operation.domainId, enabled: operation.targetEnabled }); }
    catch (error) {
      const failure = safeFailure(error, 'dnssec_preview_unavailable', 'DNSSEC preview could not be refreshed');
      try { return dnsZoneDnssecOperationPublicView(await registry.fail(operation.id, failure)); }
      catch (registryError) { throw mapped(registryError); }
    }
    if (!currentPreviewMatches(operation, currentPreview)) {
      const failure = Object.freeze({
        code: 'dnssec_preview_stale',
        message: 'DNSSEC or parent DS state changed after the operation was journaled',
      });
      try { return dnsZoneDnssecOperationPublicView(await registry.fail(operation.id, failure)); }
      catch (error) { throw mapped(error); }
    }

    try {
      await service.apply({
        domainId: operation.domainId,
        enabled: operation.targetEnabled,
        previewDigest: operation.previewDigest,
        confirmation: operation.confirmation,
      });
    } catch (applyError) {
      let after;
      try { after = await inspectTarget(operation); }
      catch {
        throw new DnsZoneDnssecRuntimeError(
          'dnssec_postcondition_unavailable',
          'DNSSEC provider result is uncertain and post-condition cannot be inspected; operation remains applying',
          503,
        );
      }
      if (after.assessment.satisfied) return succeedFromState(operation, after.current);
      if (after.assessment.compromised) return failCompromised(operation, after.assessment);
      if (after.assessment.uncertain) {
        throw new DnsZoneDnssecRuntimeError(
          'dnssec_postcondition_parent_unverifiable',
          'DNSSEC provider result is uncertain and parent DS state is unverifiable; operation remains applying',
          503,
        );
      }
      const failure = safeFailure(applyError);
      try { return dnsZoneDnssecOperationPublicView(await registry.fail(operation.id, failure)); }
      catch (error) { throw mapped(error); }
    }

    let after;
    try { after = await inspectTarget(operation); }
    catch {
      throw new DnsZoneDnssecRuntimeError(
        'dnssec_postcondition_unavailable',
        'DNSSEC mutation returned but post-condition cannot be inspected; operation remains applying',
        503,
      );
    }
    if (after.assessment.satisfied) return succeedFromState(operation, after.current);
    if (after.assessment.compromised) return failCompromised(operation, after.assessment);
    if (after.assessment.uncertain) {
      throw new DnsZoneDnssecRuntimeError(
        'dnssec_postcondition_parent_unverifiable',
        'DNSSEC mutation returned but parent DS state is unverifiable; operation remains applying',
        503,
      );
    }
    const failure = Object.freeze({
      code: 'dnssec_postcondition_not_satisfied',
      message: 'DNSSEC mutation completed without satisfying the requested authoritative state',
    });
    return dnsZoneDnssecOperationPublicView(await registry.fail(operation.id, failure));
  }

  async function start({ domainId, enabled, previewDigest, confirmation } = {}) {
    if (typeof enabled !== 'boolean'
      || typeof previewDigest !== 'string' || !SHA256_PATTERN.test(previewDigest)
      || typeof confirmation !== 'string' || !confirmation) {
      throw new DnsZoneDnssecRuntimeError('dnssec_confirmation_invalid', 'A current DNSSEC preview and exact confirmation are required', 409);
    }
    const current = await preview({ domainId, enabled });
    if (current.noChanges) throw new DnsZoneDnssecRuntimeError('dnssec_no_changes', 'DNSSEC already has the requested state', 409);
    if (current.applyAllowed !== true || current.previewDigest !== previewDigest || current.confirmation !== confirmation) {
      throw new DnsZoneDnssecRuntimeError('dnssec_confirmation_invalid', 'DNSSEC preview is stale, blocked or confirmation is invalid', 409);
    }
    let operation;
    try { operation = await registry.create(current); }
    catch (error) { throw mapped(error); }
    return run(operation.id);
  }

  async function get(operationId) {
    try { return dnsZoneDnssecOperationPublicView(await registry.get(operationId)); }
    catch (error) { throw mapped(error); }
  }

  async function listForDomain(domainId) {
    try { return Object.freeze((await registry.listForDomain(domainId)).map(dnsZoneDnssecOperationPublicView)); }
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
          error: safeFailure(error, 'dnssec_recovery_pending', 'DNSSEC recovery remains pending'),
        }));
      }
    }
    return Object.freeze(recovery);
  }

  return Object.freeze({ init, status, preview, start, run, get, listForDomain });
}

export const dnsZoneDnssecRuntimeInternals = Object.freeze({
  safeFailure,
  stateIdentityMatches,
  targetAssessment,
  currentPreviewMatches,
  evidenceFromState,
});
