import {
  dnsZoneDnssecRolloverPublicView,
  DnsZoneDnssecRolloverRegistryError,
} from './dns-zone-dnssec-rollover-registry.js';
import { DnsZoneDnssecError } from './dns-zone-dnssec.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class DnsZoneDnssecRolloverRuntimeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsZoneDnssecRolloverRuntimeError';
    this.code = code;
    this.status = status;
  }
}

function mapped(error) {
  if (error instanceof DnsZoneDnssecRolloverRuntimeError) return error;
  if (error instanceof DnsZoneDnssecRolloverRegistryError || error instanceof DnsZoneDnssecError) {
    return new DnsZoneDnssecRolloverRuntimeError(error.code, error.message, error.status);
  }
  return error;
}

function safeFailure(error, fallbackCode = 'dnssec_rollover_operation_failed', fallbackMessage = 'DNSSEC rollover operation failed') {
  if (error instanceof DnsZoneDnssecRolloverRuntimeError
    || error instanceof DnsZoneDnssecRolloverRegistryError
    || error instanceof DnsZoneDnssecError) {
    return Object.freeze({ code: error.code, message: error.message });
  }
  return Object.freeze({ code: fallbackCode, message: fallbackMessage });
}

function currentPreviewMatches(operation, preview) {
  return Boolean(preview
    && preview.action === 'dnssec_key_rollover'
    && preview.applyAllowed === true
    && Array.isArray(preview.blockers) && preview.blockers.length === 0
    && preview.domainId === operation.domainId
    && preview.serverId === operation.serverId
    && preview.zoneName === operation.zoneName
    && preview.previewDigest === operation.previewDigest
    && preview.confirmation === operation.confirmation
    && preview.expectedKeySetDigest === operation.expectedKeySetDigest
    && JSON.stringify(preview.expectedKeyIds) === JSON.stringify(operation.expectedKeyIds)
    && JSON.stringify(preview.oldKey) === JSON.stringify(operation.oldKey)
    && JSON.stringify(preview.newKey) === JSON.stringify(operation.newKey)
    && JSON.stringify(preview.parentDs) === JSON.stringify(operation.initialParentDs));
}

function createdKeyEvidence(operation, result) {
  const key = result?.createdKey;
  if (!result || typeof result !== 'object'
    || typeof result.keySetDigest !== 'string' || !SHA256_PATTERN.test(result.keySetDigest)
    || !Number.isSafeInteger(result.serial) || result.serial < 1
    || !key || !Number.isSafeInteger(key.id) || key.id < 0 || key.id === operation.oldKey.id
    || key.keyType !== operation.newKey.keyType || key.algorithm !== operation.newKey.algorithm
    || key.bits !== operation.newKey.bits || key.active !== false || key.published !== false
    || !Array.isArray(key.ds) || key.ds.length === 0) {
    throw new DnsZoneDnssecRolloverRuntimeError(
      'dnssec_rollover_create_evidence_invalid',
      'DNSSEC rollover key creation evidence is invalid',
      503,
    );
  }
  return Object.freeze({
    newKeyId: key.id,
    keySetDigest: result.keySetDigest,
    newKeyDs: Object.freeze([...key.ds]),
    serial: result.serial,
  });
}

function publicationTarget(operation, created, preview) {
  const key = preview?.targetKey;
  if (!preview || preview.keySetDigest !== created.keySetDigest
    || typeof preview.targetKeySetDigest !== 'string' || !SHA256_PATTERN.test(preview.targetKeySetDigest)
    || !key || key.id !== created.newKeyId || key.keyType !== operation.newKey.keyType
    || key.algorithm !== operation.newKey.algorithm || key.bits !== operation.newKey.bits
    || key.active !== false || key.published !== true
    || !Array.isArray(key.ds) || JSON.stringify(key.ds) !== JSON.stringify(created.newKeyDs)) {
    throw new DnsZoneDnssecRolloverRuntimeError(
      'dnssec_rollover_publish_preview_invalid',
      'DNSSEC rollover publication target evidence is invalid',
      503,
    );
  }
  return Object.freeze({
    newKeyId: created.newKeyId,
    keySetDigest: created.keySetDigest,
    targetKeySetDigest: preview.targetKeySetDigest,
    newKeyDs: created.newKeyDs,
    serial: created.serial,
    parentDs: operation.initialParentDs,
    propagation: null,
  });
}

function publishedEvidence(operation, result) {
  const key = result?.updatedKey;
  if (!result || result.keySetDigest !== operation.evidence.targetKeySetDigest
    || !Number.isSafeInteger(result.serial) || result.serial < 1
    || !key || key.id !== operation.evidence.newKeyId || key.keyType !== operation.newKey.keyType
    || key.algorithm !== operation.newKey.algorithm || key.bits !== operation.newKey.bits
    || key.active !== false || key.published !== true
    || !Array.isArray(key.ds) || JSON.stringify(key.ds) !== JSON.stringify(operation.evidence.newKeyDs)) {
    throw new DnsZoneDnssecRolloverRuntimeError(
      'dnssec_rollover_publish_evidence_invalid',
      'DNSSEC rollover publication evidence is invalid',
      503,
    );
  }
  return Object.freeze({
    ...operation.evidence,
    keySetDigest: result.keySetDigest,
    targetKeySetDigest: null,
    serial: result.serial,
  });
}

function verifiedPropagation(operation, result) {
  if (result?.ready !== true) return null;
  if (!result || result.version !== 1 || result.zoneName !== operation.zoneName
    || !['synced', 'disabled'].includes(result.status)
    || result.expectedSerial !== operation.evidence.serial
    || !Number.isSafeInteger(result.dnskeyTtl) || result.dnskeyTtl < 0 || result.dnskeyTtl > 2_147_483_647
    || typeof result.publishedAt !== 'string' || result.publishedAt !== operation.updatedAt
    || typeof result.eligibleAfter !== 'string' || typeof result.checkedAt !== 'string'
    || !Array.isArray(result.targets) || result.targets.length < 1 || result.targets.length > 9
    || result.targets.some((entry) => entry?.ready !== true)) {
    throw new DnsZoneDnssecRolloverRuntimeError(
      'dnssec_rollover_propagation_evidence_invalid',
      'DNSSEC rollover propagation evidence is invalid',
      503,
    );
  }
  return Object.freeze({
    status: result.status,
    serial: result.expectedSerial,
    dnskeyTtl: result.dnskeyTtl,
    publishedAt: result.publishedAt,
    eligibleAfter: result.eligibleAfter,
    checkedAt: result.checkedAt,
    targetCount: result.targets.length,
  });
}

function activationTarget(operation, propagation, preview) {
  const key = preview?.targetKey;
  if (!preview || preview.keySetDigest !== operation.evidence.keySetDigest
    || typeof preview.targetKeySetDigest !== 'string' || !SHA256_PATTERN.test(preview.targetKeySetDigest)
    || !key || key.id !== operation.evidence.newKeyId || key.keyType !== operation.newKey.keyType
    || key.algorithm !== operation.newKey.algorithm || key.bits !== operation.newKey.bits
    || key.active !== true || key.published !== true
    || !Array.isArray(key.ds) || JSON.stringify(key.ds) !== JSON.stringify(operation.evidence.newKeyDs)) {
    throw new DnsZoneDnssecRolloverRuntimeError(
      'dnssec_rollover_activation_preview_invalid',
      'DNSSEC rollover activation target evidence is invalid',
      503,
    );
  }
  return Object.freeze({
    ...operation.evidence,
    targetKeySetDigest: preview.targetKeySetDigest,
    propagation,
  });
}

function activatedEvidence(operation, result) {
  const key = result?.updatedKey;
  if (!result || result.keySetDigest !== operation.evidence.targetKeySetDigest
    || !Number.isSafeInteger(result.serial) || result.serial < 1
    || !key || key.id !== operation.evidence.newKeyId || key.keyType !== operation.newKey.keyType
    || key.algorithm !== operation.newKey.algorithm || key.bits !== operation.newKey.bits
    || key.active !== true || key.published !== true
    || !Array.isArray(key.ds) || JSON.stringify(key.ds) !== JSON.stringify(operation.evidence.newKeyDs)) {
    throw new DnsZoneDnssecRolloverRuntimeError(
      'dnssec_rollover_activation_evidence_invalid',
      'DNSSEC rollover activation evidence is invalid',
      503,
    );
  }
  return Object.freeze({
    ...operation.evidence,
    keySetDigest: result.keySetDigest,
    targetKeySetDigest: null,
    serial: result.serial,
  });
}

function parentAdditionEvidence(operation, state) {
  if (!state || state.domainId !== operation.domainId || state.serverId !== operation.serverId
    || state.zoneName !== operation.zoneName || state.dnssec !== true || state.localReady !== true
    || state.keySetDigest !== operation.evidence.keySetDigest
    || !state.parent || !['present', 'absent', 'unverifiable'].includes(state.parent.status)
    || !Array.isArray(state.parent.records)) {
    throw new DnsZoneDnssecRolloverRuntimeError(
      'dnssec_rollover_parent_addition_evidence_invalid',
      'DNSSEC rollover parent DS addition evidence is invalid',
      503,
    );
  }
  if (state.parent.status !== 'present') return null;
  const allowed = new Set([...operation.oldKey.ds, ...operation.evidence.newKeyDs]);
  const oldPresent = state.parent.records.some((record) => operation.oldKey.ds.includes(record));
  const newPresent = state.parent.records.some((record) => operation.evidence.newKeyDs.includes(record));
  const foreignPresent = state.parent.records.some((record) => !allowed.has(record));
  if (!oldPresent || !newPresent || foreignPresent) return null;
  return Object.freeze({
    ...operation.evidence,
    parentDs: Object.freeze([...state.parent.records]),
  });
}

function parentRetirementEvidence(operation, state) {
  if (!state || state.domainId !== operation.domainId || state.serverId !== operation.serverId
    || state.zoneName !== operation.zoneName || state.dnssec !== true || state.localReady !== true
    || state.keySetDigest !== operation.evidence.keySetDigest
    || !state.parent || !['present', 'absent', 'unverifiable'].includes(state.parent.status)
    || !Array.isArray(state.parent.records)) {
    throw new DnsZoneDnssecRolloverRuntimeError(
      'dnssec_rollover_parent_retirement_evidence_invalid',
      'DNSSEC rollover parent DS retirement evidence is invalid',
      503,
    );
  }
  if (state.parent.status !== 'present') return null;
  const allowed = new Set(operation.evidence.newKeyDs);
  const oldPresent = state.parent.records.some((record) => operation.oldKey.ds.includes(record));
  const newPresent = state.parent.records.some((record) => operation.evidence.newKeyDs.includes(record));
  const foreignPresent = state.parent.records.some((record) => !allowed.has(record));
  if (oldPresent || !newPresent || foreignPresent) return null;
  return Object.freeze([...state.parent.records]);
}

function deactivationTarget(operation, parentDs, preview) {
  const key = preview?.targetKey;
  if (!preview || preview.keySetDigest !== operation.evidence.keySetDigest
    || typeof preview.targetKeySetDigest !== 'string' || !SHA256_PATTERN.test(preview.targetKeySetDigest)
    || !key || key.id !== operation.oldKey.id || key.keyType !== operation.oldKey.keyType
    || key.algorithm !== operation.oldKey.algorithm || key.bits !== operation.oldKey.bits
    || key.active !== false || key.published !== true
    || !Array.isArray(key.ds) || JSON.stringify(key.ds) !== JSON.stringify(operation.oldKey.ds)) {
    throw new DnsZoneDnssecRolloverRuntimeError(
      'dnssec_rollover_deactivation_preview_invalid',
      'DNSSEC rollover old-key deactivation target evidence is invalid',
      503,
    );
  }
  return Object.freeze({
    ...operation.evidence,
    targetKeySetDigest: preview.targetKeySetDigest,
    parentDs,
  });
}

export function createDnsZoneDnssecRolloverRuntime({ registry, service } = {}) {
  if (!registry || typeof registry.init !== 'function' || typeof registry.create !== 'function'
    || typeof registry.get !== 'function' || typeof registry.listForDomain !== 'function'
    || typeof registry.listActive !== 'function' || typeof registry.advance !== 'function'
    || typeof registry.fail !== 'function'
    || !service || typeof service.status !== 'function'
    || typeof service.previewRollover !== 'function' || typeof service.createRolloverKey !== 'function'
    || typeof service.previewRolloverKeyState !== 'function' || typeof service.setRolloverKeyState !== 'function'
    || typeof service.inspectRolloverPropagation !== 'function') {
    throw new DnsZoneDnssecRolloverRuntimeError('dnssec_rollover_runtime_dependencies_invalid', 'DNSSEC rollover runtime dependencies are unavailable', 503);
  }

  async function getRequired(operationId) {
    let operation;
    try { operation = await registry.get(operationId); }
    catch (error) { throw mapped(error); }
    if (!operation) throw new DnsZoneDnssecRolloverRuntimeError('dnssec_rollover_operation_not_found', 'DNSSEC rollover operation was not found', 404);
    return operation;
  }

  async function run(operationId) {
    let operation = await getRequired(operationId);
    if (operation.status === 'succeeded' || operation.status === 'failed'
      || !['pending', 'creating_key', 'publishing_key', 'verifying_dnskey_propagation', 'activating_key',
        'awaiting_parent_ds_addition', 'awaiting_parent_ds_retirement'].includes(operation.status)) {
      return dnsZoneDnssecRolloverPublicView(operation);
    }

    if (operation.status === 'pending') {
      let preview;
      try { preview = await service.previewRollover({ domainId: operation.domainId }); }
      catch (error) { throw mapped(error); }
      if (!currentPreviewMatches(operation, preview)) {
        const failure = Object.freeze({
          code: 'dnssec_rollover_preview_stale',
          message: 'DNSSEC rollover state changed after the operation was journaled',
        });
        try { return dnsZoneDnssecRolloverPublicView(await registry.fail(operation.id, failure)); }
        catch (error) { throw mapped(error); }
      }
      try { operation = await registry.advance(operation.id, 'creating_key', operation.evidence); }
      catch (error) { throw mapped(error); }
    }

    if (operation.status === 'creating_key') {
      let created;
      try {
        created = createdKeyEvidence(operation, await service.createRolloverKey({
          domainId: operation.domainId,
          expectedKeySetDigest: operation.expectedKeySetDigest,
          expectedKeyIds: operation.expectedKeyIds,
          newKey: operation.newKey,
        }));
      } catch (error) {
        throw mapped(error);
      }
      let target;
      try {
        target = publicationTarget(operation, created, await service.previewRolloverKeyState({
          domainId: operation.domainId,
          keyId: created.newKeyId,
          active: false,
          published: true,
        }));
      } catch (error) { throw mapped(error); }
      try { operation = await registry.advance(operation.id, 'publishing_key', target); }
      catch (error) { throw mapped(error); }
    }

    if (operation.status === 'publishing_key') {
      let published;
      try {
        published = await service.setRolloverKeyState({
          domainId: operation.domainId,
          keyId: operation.evidence.newKeyId,
          expectedKeySetDigest: operation.evidence.keySetDigest,
          expectedTargetKeySetDigest: operation.evidence.targetKeySetDigest,
          expectedActive: false,
          expectedPublished: false,
          active: false,
          published: true,
        });
      } catch (error) { throw mapped(error); }
      const nextEvidence = publishedEvidence(operation, published);
      try { operation = await registry.advance(operation.id, 'verifying_dnskey_propagation', nextEvidence); }
      catch (error) { throw mapped(error); }
    }

    if (operation.status === 'verifying_dnskey_propagation') {
      let propagation;
      try {
        propagation = verifiedPropagation(operation, await service.inspectRolloverPropagation({
          domainId: operation.domainId,
          newKeyId: operation.evidence.newKeyId,
          newKeyDs: operation.evidence.newKeyDs,
          expectedKeySetDigest: operation.evidence.keySetDigest,
          expectedSerial: operation.evidence.serial,
          publishedAt: operation.updatedAt,
        }));
      } catch (error) { throw mapped(error); }
      if (propagation === null) return dnsZoneDnssecRolloverPublicView(operation);
      let target;
      try {
        target = activationTarget(operation, propagation, await service.previewRolloverKeyState({
          domainId: operation.domainId,
          keyId: operation.evidence.newKeyId,
          active: true,
          published: true,
        }));
      } catch (error) { throw mapped(error); }
      try { operation = await registry.advance(operation.id, 'activating_key', target); }
      catch (error) { throw mapped(error); }
    }

    if (operation.status === 'activating_key') {
      let activated;
      try {
        activated = activatedEvidence(operation, await service.setRolloverKeyState({
          domainId: operation.domainId,
          keyId: operation.evidence.newKeyId,
          expectedKeySetDigest: operation.evidence.keySetDigest,
          expectedTargetKeySetDigest: operation.evidence.targetKeySetDigest,
          expectedActive: false,
          expectedPublished: true,
          active: true,
          published: true,
        }));
      } catch (error) { throw mapped(error); }
      try { operation = await registry.advance(operation.id, 'awaiting_parent_ds_addition', activated); }
      catch (error) { throw mapped(error); }
    }

    if (operation.status === 'awaiting_parent_ds_addition') {
      let parentEvidence;
      try {
        parentEvidence = parentAdditionEvidence(operation, await service.status({ domainId: operation.domainId }));
      } catch (error) { throw mapped(error); }
      if (parentEvidence === null) return dnsZoneDnssecRolloverPublicView(operation);
      try { operation = await registry.advance(operation.id, 'awaiting_parent_ds_retirement', parentEvidence); }
      catch (error) { throw mapped(error); }
    }

    if (operation.status === 'awaiting_parent_ds_retirement') {
      let parentDs;
      try {
        parentDs = parentRetirementEvidence(operation, await service.status({ domainId: operation.domainId }));
      } catch (error) { throw mapped(error); }
      if (parentDs === null) return dnsZoneDnssecRolloverPublicView(operation);
      let target;
      try {
        target = deactivationTarget(operation, parentDs, await service.previewRolloverKeyState({
          domainId: operation.domainId,
          keyId: operation.oldKey.id,
          active: false,
          published: true,
        }));
      } catch (error) { throw mapped(error); }
      try { operation = await registry.advance(operation.id, 'deactivating_old_key', target); }
      catch (error) { throw mapped(error); }
    }
    return dnsZoneDnssecRolloverPublicView(operation);
  }

  async function start({ domainId, previewDigest, confirmation } = {}) {
    if (typeof previewDigest !== 'string' || !SHA256_PATTERN.test(previewDigest)
      || typeof confirmation !== 'string' || !confirmation) {
      throw new DnsZoneDnssecRolloverRuntimeError('dnssec_rollover_confirmation_invalid', 'A current DNSSEC rollover preview and exact confirmation are required', 409);
    }
    let active;
    try {
      active = (await registry.listForDomain(domainId)).find((entry) => !['succeeded', 'failed'].includes(entry.status)) ?? null;
    } catch (error) { throw mapped(error); }
    if (active) {
      if (active.previewDigest === previewDigest && active.confirmation === confirmation) return run(active.id);
      throw new DnsZoneDnssecRolloverRuntimeError('dnssec_rollover_operation_conflict', 'Another DNSSEC rollover is active for this Domain', 409);
    }
    let preview;
    try { preview = await service.previewRollover({ domainId }); }
    catch (error) { throw mapped(error); }
    if (preview.applyAllowed !== true || preview.previewDigest !== previewDigest || preview.confirmation !== confirmation) {
      throw new DnsZoneDnssecRolloverRuntimeError('dnssec_rollover_confirmation_invalid', 'DNSSEC rollover preview is stale, blocked or confirmation is invalid', 409);
    }
    let operation;
    try { operation = await registry.create(preview); }
    catch (error) { throw mapped(error); }
    return run(operation.id);
  }

  async function get(operationId) {
    return dnsZoneDnssecRolloverPublicView(await getRequired(operationId));
  }

  async function listForDomain(domainId) {
    try { return Object.freeze((await registry.listForDomain(domainId)).map(dnsZoneDnssecRolloverPublicView)); }
    catch (error) { throw mapped(error); }
  }

  async function init() {
    try { await registry.init(); }
    catch (error) { throw mapped(error); }
    const recovery = [];
    for (const operation of await registry.listActive()) {
      try {
        recovery.push(Object.freeze({ operationId: operation.id, recovered: true, operation: await run(operation.id) }));
      } catch (error) {
        recovery.push(Object.freeze({
          operationId: operation.id,
          recovered: false,
          error: safeFailure(error, 'dnssec_rollover_recovery_pending', 'DNSSEC rollover recovery remains pending'),
        }));
      }
    }
    return Object.freeze(recovery);
  }

  return Object.freeze({ init, start, run, get, listForDomain });
}

export const dnsZoneDnssecRolloverRuntimeInternals = Object.freeze({
  safeFailure,
  currentPreviewMatches,
  createdKeyEvidence,
  publicationTarget,
  publishedEvidence,
  verifiedPropagation,
  activationTarget,
  activatedEvidence,
  parentAdditionEvidence,
  parentRetirementEvidence,
  deactivationTarget,
});
