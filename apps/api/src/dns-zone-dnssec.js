import { createHash } from 'node:crypto';
import {
  createDnsParentDsInspector,
  DnsParentDsInspectorError,
} from '@yunpanel/host-runtime/dns-parent-ds-inspector';
import {
  createDnssecKeyPropagationInspector,
  DnssecKeyPropagationInspectorError,
} from '@yunpanel/host-runtime/dnssec-key-propagation-inspector';
import {
  createPowerDnsDnssecManager,
  PowerDnsDnssecManagerError,
} from '@yunpanel/host-runtime/powerdns-dnssec-manager';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ROLLOVER_KEY_TYPES = new Set(['ksk', 'csk']);
const ROLLOVER_STAGES = Object.freeze([
  'create_new_key',
  'publish_new_key',
  'verify_dnskey_propagation',
  'activate_new_key',
  'await_parent_ds_addition',
  'await_old_ds_retirement',
  'deactivate_old_key',
  'delete_old_key',
]);

export class DnsZoneDnssecError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsZoneDnssecError';
    this.code = code;
    this.status = status;
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function rootDomain(domain, localServerId) {
  if (!domain) throw new DnsZoneDnssecError('domain_not_found', 'Domain not found', 404);
  if (typeof domain !== 'object' || typeof domain.id !== 'string'
    || typeof domain.serverId !== 'string' || typeof domain.primaryDomain !== 'string') {
    throw new DnsZoneDnssecError('dnssec_domain_state_invalid', 'Domain state is invalid', 409);
  }
  if (domain.serverId !== localServerId) {
    throw new DnsZoneDnssecError('dnssec_local_server_required', 'DNSSEC is available only for this panel host', 404);
  }
  if (domain.parentDomainId !== null && domain.parentDomainId !== undefined) {
    throw new DnsZoneDnssecError('dnssec_root_domain_required', 'DNSSEC is managed only on root authoritative zones', 409);
  }
  return domain;
}

function dsIntersection(left, right) {
  const expected = new Set(left);
  return Object.freeze(right.filter((entry) => expected.has(entry)));
}

function localSigningReady(authoritative) {
  return authoritative?.dnssec === true
    && authoritative?.ready === true
    && Array.isArray(authoritative.ds)
    && authoritative.ds.length > 0;
}

function statusFor(authoritative, parent) {
  if (authoritative.dnssec !== true) {
    if (parent.status === 'present') return 'parent_ds_without_dnssec';
    if (parent.status === 'unverifiable') return 'insecure_parent_unverifiable';
    return 'insecure';
  }
  if (!localSigningReady(authoritative)) return 'signing_material_incomplete';
  if (parent.status === 'unverifiable') return 'parent_ds_unverifiable';
  if (parent.status === 'absent') return 'pending_parent_ds';
  return dsIntersection(authoritative.ds, parent.records).length > 0 ? 'secure_ready' : 'parent_ds_mismatch';
}

function publicState(domain, authoritative, parent) {
  const matches = dsIntersection(authoritative.ds, parent.records);
  const localReady = localSigningReady(authoritative);
  const status = statusFor(authoritative, parent);
  return Object.freeze({
    version: 1,
    domainId: domain.id,
    serverId: domain.serverId,
    zoneName: domain.primaryDomain,
    dnssec: authoritative.dnssec,
    localReady,
    status,
    secureReady: status === 'secure_ready',
    serial: authoritative.serial,
    keys: authoritative.keys,
    keySetDigest: typeof authoritative.keySetDigest === 'string' && SHA256_PATTERN.test(authoritative.keySetDigest)
      ? authoritative.keySetDigest
      : null,
    ds: authoritative.ds,
    parent: Object.freeze({
      status: parent.status,
      records: parent.records,
      matchingRecords: matches,
      ttl: Number.isSafeInteger(parent.ttl) && parent.ttl >= 0 ? parent.ttl : null,
      errorCode: parent.errorCode,
      checkedAt: parent.checkedAt,
    }),
    registrar: Object.freeze({
      addDs: localReady ? authoritative.ds : Object.freeze([]),
      removeDsBeforeDisable: authoritative.dnssec === true && parent.status === 'present' ? parent.records : Object.freeze([]),
    }),
  });
}

function rolloverKeyView(key) {
  return Object.freeze({
    id: key.id,
    keyType: key.keyType,
    algorithm: key.algorithm,
    bits: key.bits,
    ds: Object.freeze([...key.ds]),
  });
}

function rolloverPreflight(state) {
  const blockers = [];
  if (state.secureReady !== true) {
    blockers.push(Object.freeze({
      code: 'dnssec_rollover_secure_delegation_required',
      message: 'DNSSEC rollover requires a currently verified secure delegation.',
    }));
  }
  if (typeof state.keySetDigest !== 'string' || !SHA256_PATTERN.test(state.keySetDigest)) {
    blockers.push(Object.freeze({
      code: 'dnssec_rollover_key_evidence_invalid',
      message: 'The current public DNSSEC key-set identity is unavailable.',
    }));
  }
  const keys = Array.isArray(state.keys) ? state.keys : [];
  const signingKeys = keys.filter((entry) => ROLLOVER_KEY_TYPES.has(entry?.keyType));
  const parentBound = signingKeys.filter((entry) => entry.active === true && entry.published === true
    && Array.isArray(entry.ds) && dsIntersection(entry.ds, state.parent.matchingRecords).length > 0);
  if (parentBound.length !== 1) {
    blockers.push(Object.freeze({
      code: 'dnssec_rollover_current_key_ambiguous',
      message: 'Exactly one active published KSK/CSK must own the current parent DS set.',
    }));
  }
  const oldKey = parentBound.length === 1 ? parentBound[0] : null;
  if (oldKey && signingKeys.some((entry) => entry.id !== oldKey.id)) {
    blockers.push(Object.freeze({
      code: 'dnssec_rollover_key_artifact_present',
      message: 'Another KSK/CSK is already present; reconcile the existing rollover state first.',
    }));
  }
  if (oldKey && state.parent.records.some((record) => !oldKey.ds.includes(record))) {
    blockers.push(Object.freeze({
      code: 'dnssec_rollover_parent_ds_ambiguous',
      message: 'Every published parent DS must belong to the selected current key before rollover starts.',
    }));
  }
  if (oldKey && (!Number.isSafeInteger(oldKey.id) || oldKey.id < 0
    || typeof oldKey.algorithm !== 'string' || !oldKey.algorithm
    || !Number.isSafeInteger(oldKey.bits) || oldKey.bits < 1)) {
    blockers.push(Object.freeze({
      code: 'dnssec_rollover_current_key_invalid',
      message: 'The selected current key does not have complete public generation metadata.',
    }));
  }
  return Object.freeze({ blockers: Object.freeze(blockers), oldKey });
}

function previewBlockers(state, enabled) {
  const blockers = [];
  if (enabled === false) {
    if (state.parent.status === 'present') {
      blockers.push(Object.freeze({
        code: 'parent_ds_must_be_removed',
        message: 'Remove every DS record from the parent/registrar before disabling DNSSEC.',
        records: state.parent.records,
      }));
    } else if (state.parent.status === 'unverifiable') {
      blockers.push(Object.freeze({
        code: 'parent_ds_unverifiable',
        message: 'Parent DS state must be verifiably absent before disabling DNSSEC.',
        records: Object.freeze([]),
      }));
    }
  } else if (state.dnssec === true && state.localReady !== true) {
    blockers.push(Object.freeze({
      code: 'dnssec_signing_material_incomplete',
      message: 'DNSSEC is marked enabled but local signing keys/DS material are incomplete; repair the signing state before continuing.',
      records: Object.freeze([]),
    }));
  } else if (state.dnssec === false && state.parent.status === 'present'
    && state.parent.matchingRecords.length === 0) {
    blockers.push(Object.freeze({
      code: 'stale_parent_ds_before_enable',
      message: 'Existing parent DS does not match locally retained DNSSEC material. Remove it before enabling a new signing state.',
      records: state.parent.records,
    }));
  }
  return Object.freeze(blockers);
}

function hostFailure(error) {
  if (error instanceof DnsZoneDnssecError) return error;
  if (error instanceof PowerDnsDnssecManagerError || error instanceof DnsParentDsInspectorError
    || error instanceof DnssecKeyPropagationInspectorError) {
    return new DnsZoneDnssecError(error.code, error.message, error.status);
  }
  return error;
}

export function createDnsZoneDnssecService({
  domainRegistry,
  powerDnsSecretRegistry,
  localServerId,
  manager = createPowerDnsDnssecManager(),
  parentDsInspector = createDnsParentDsInspector(),
  dnsIdentityRegistry = null,
  keyPropagationInspector = null,
} = {}) {
  const propagationInspector = keyPropagationInspector
    ?? (dnsIdentityRegistry ? createDnssecKeyPropagationInspector() : null);
  if (!domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !powerDnsSecretRegistry || typeof powerDnsSecretRegistry.materializeForServer !== 'function'
    || typeof localServerId !== 'string' || !localServerId
    || !manager || typeof manager.inspect !== 'function' || typeof manager.enable !== 'function' || typeof manager.disable !== 'function'
    || !parentDsInspector || typeof parentDsInspector.inspect !== 'function'
    || (dnsIdentityRegistry !== null && typeof dnsIdentityRegistry.getForServer !== 'function')
    || (keyPropagationInspector !== null && typeof keyPropagationInspector.inspect !== 'function')) {
    throw new DnsZoneDnssecError('dnssec_dependencies_invalid', 'DNSSEC lifecycle dependencies are unavailable', 503);
  }

  async function context(domainId) {
    const domain = rootDomain(await domainRegistry.getDomain(domainId), localServerId);
    let secret;
    try { secret = await powerDnsSecretRegistry.materializeForServer(domain.serverId); }
    catch (error) { throw hostFailure(error); }
    if (!secret || secret.serverId !== domain.serverId || typeof secret.apiKey !== 'string') {
      throw new DnsZoneDnssecError('dnssec_powerdns_secret_invalid', 'PowerDNS API credential state is invalid', 409);
    }
    return Object.freeze({ domain, apiKey: secret.apiKey });
  }

  async function inspectParent(domain) {
    try { return await parentDsInspector.inspect({ domain }); }
    catch (error) { throw hostFailure(error); }
  }

  async function inspectContext(current) {
    let authoritative;
    let parent;
    try {
      [authoritative, parent] = await Promise.all([
        manager.inspect({ zoneName: current.domain.primaryDomain, apiKey: current.apiKey }),
        parentDsInspector.inspect({ domain: current.domain.primaryDomain }),
      ]);
    } catch (error) { throw hostFailure(error); }
    return publicState(current.domain, authoritative, parent);
  }

  function rolloverMethod(name) {
    if (typeof manager[name] !== 'function') {
      throw new DnsZoneDnssecError('dnssec_rollover_unavailable', 'DNSSEC rollover host capability is unavailable', 503);
    }
    return manager[name].bind(manager);
  }

  async function status({ domainId } = {}) {
    return inspectContext(await context(domainId));
  }

  async function preview({ domainId, enabled } = {}) {
    if (typeof enabled !== 'boolean') {
      throw new DnsZoneDnssecError('dnssec_target_invalid', 'DNSSEC target state must be boolean');
    }
    const state = await status({ domainId });
    const blockers = previewBlockers(state, enabled);
    const targetSatisfied = enabled
      ? state.dnssec === true && state.localReady === true
      : state.dnssec === false;
    const noChanges = targetSatisfied;
    const payload = Object.freeze({
      version: 1,
      domainId: state.domainId,
      serverId: state.serverId,
      zoneName: state.zoneName,
      targetEnabled: enabled,
      currentDnssec: state.dnssec,
      currentLocalReady: state.localReady,
      currentDs: state.ds,
      parentStatus: state.parent.status,
      parentRecords: state.parent.records,
      parentMatchingRecords: state.parent.matchingRecords,
      blockers,
    });
    const previewDigest = digest(payload);
    const applyAllowed = !noChanges && blockers.length === 0;
    return Object.freeze({
      ...payload,
      status: state.status,
      noChanges,
      applyAllowed,
      previewDigest,
      confirmation: applyAllowed
        ? `${enabled ? 'enable' : 'disable'}-dnssec:${state.domainId}:${previewDigest}`
        : null,
      registrar: state.registrar,
      impact: Object.freeze({
        authoritativeSigningChange: !noChanges,
        registrarActionAfterEnable: enabled && state.dnssec === false,
        parentDsRemovalRequiredBeforeDisable: !enabled && state.parent.status === 'present',
      }),
    });
  }

  async function previewRollover({ domainId } = {}) {
    const state = await status({ domainId });
    const preflight = rolloverPreflight(state);
    const oldKey = preflight.oldKey ? rolloverKeyView(preflight.oldKey) : null;
    const newKey = oldKey ? Object.freeze({
      keyType: oldKey.keyType,
      algorithm: oldKey.algorithm,
      bits: oldKey.bits,
      active: false,
      published: false,
    }) : null;
    const payload = Object.freeze({
      version: 1,
      action: 'dnssec_key_rollover',
      domainId: state.domainId,
      serverId: state.serverId,
      zoneName: state.zoneName,
      expectedKeySetDigest: state.keySetDigest,
      expectedKeyIds: Object.freeze((Array.isArray(state.keys) ? state.keys : []).map((entry) => entry.id).sort((left, right) => left - right)),
      oldKey,
      newKey,
      parentDs: state.parent.records,
      stages: ROLLOVER_STAGES,
      blockers: preflight.blockers,
    });
    const previewDigest = digest(payload);
    const applyAllowed = preflight.blockers.length === 0;
    return Object.freeze({
      ...payload,
      applyAllowed,
      previewDigest,
      confirmation: applyAllowed ? `rollover-dnssec:${state.domainId}:${previewDigest}` : null,
      impact: Object.freeze({
        authoritativeKeyMutation: true,
        registrarActionsRequired: true,
        oldKeyDeletionDeferredUntilParentRetirement: true,
      }),
    });
  }

  async function createRolloverKey({ domainId, expectedKeySetDigest, expectedKeyIds, newKey: target } = {}) {
    const current = await context(domainId);
    try {
      return await rolloverMethod('createRolloverKey')({
        zoneName: current.domain.primaryDomain,
        apiKey: current.apiKey,
        expectedKeySetDigest,
        expectedKeyIds,
        keyType: target?.keyType,
        algorithm: target?.algorithm,
        bits: target?.bits,
        active: target?.active,
        published: target?.published,
      });
    } catch (error) { throw hostFailure(error); }
  }

  async function previewRolloverKeyState({ domainId, keyId, active, published } = {}) {
    const current = await context(domainId);
    try {
      return await rolloverMethod('previewRolloverKeyState')({
        zoneName: current.domain.primaryDomain,
        apiKey: current.apiKey,
        keyId,
        active,
        published,
      });
    } catch (error) { throw hostFailure(error); }
  }

  async function setRolloverKeyState({
    domainId,
    keyId,
    expectedKeySetDigest,
    expectedTargetKeySetDigest,
    expectedActive,
    expectedPublished,
    active,
    published,
  } = {}) {
    const current = await context(domainId);
    try {
      return await rolloverMethod('setRolloverKeyState')({
        zoneName: current.domain.primaryDomain,
        apiKey: current.apiKey,
        keyId,
        expectedKeySetDigest,
        expectedTargetKeySetDigest,
        expectedActive,
        expectedPublished,
        active,
        published,
      });
    } catch (error) { throw hostFailure(error); }
  }

  async function inspectRolloverPropagation({
    domainId,
    newKeyId,
    newKeyDs,
    expectedKeySetDigest,
    expectedSerial,
    publishedAt,
  } = {}) {
    if (!dnsIdentityRegistry || !propagationInspector) {
      throw new DnsZoneDnssecError(
        'dnssec_rollover_propagation_unavailable',
        'DNSSEC rollover propagation inspection is unavailable',
        503,
      );
    }
    if (!Number.isSafeInteger(newKeyId) || newKeyId < 0
      || !Array.isArray(newKeyDs) || newKeyDs.length < 1
      || typeof expectedKeySetDigest !== 'string' || !SHA256_PATTERN.test(expectedKeySetDigest)
      || !Number.isSafeInteger(expectedSerial) || expectedSerial < 1
      || typeof publishedAt !== 'string' || !Number.isFinite(Date.parse(publishedAt))
      || new Date(publishedAt).toISOString() !== publishedAt) {
      throw new DnsZoneDnssecError(
        'dnssec_rollover_propagation_input_invalid',
        'DNSSEC rollover propagation evidence is invalid',
      );
    }
    const current = await context(domainId);
    let identity;
    let authoritative;
    try {
      [identity, authoritative] = await Promise.all([
        dnsIdentityRegistry.getForServer(current.domain.serverId),
        manager.inspect({ zoneName: current.domain.primaryDomain, apiKey: current.apiKey }),
      ]);
    } catch (error) {
      const mapped = hostFailure(error);
      if (mapped !== error) throw mapped;
      throw new DnsZoneDnssecError(
        'dnssec_rollover_propagation_inspection_failed',
        'DNSSEC rollover propagation state could not be inspected',
        503,
      );
    }
    if (!identity || identity.serverId !== current.domain.serverId
      || typeof identity.settings?.ns1?.ipv4 !== 'string'
      || !Array.isArray(identity.settings?.secondaryDns)) {
      throw new DnsZoneDnssecError('dnssec_rollover_dns_identity_invalid', 'Server DNS identity is unavailable or invalid', 409);
    }
    if (authoritative?.zoneName !== current.domain.primaryDomain
      || authoritative?.keySetDigest !== expectedKeySetDigest
      || authoritative?.serial !== expectedSerial) {
      throw new DnsZoneDnssecError(
        'dnssec_rollover_publication_state_changed',
        'DNSSEC publication state changed before propagation could be verified',
        409,
      );
    }
    const key = Array.isArray(authoritative.keys)
      ? authoritative.keys.find((entry) => entry?.id === newKeyId)
      : null;
    if (!key || key.active !== false || key.published !== true
      || typeof key.dnskey !== 'string' || !key.dnskey
      || JSON.stringify(key.ds) !== JSON.stringify(newKeyDs)) {
      throw new DnsZoneDnssecError(
        'dnssec_rollover_publication_key_changed',
        'DNSSEC rollover key no longer matches the published operation evidence',
        409,
      );
    }
    try {
      return await propagationInspector.inspect({
        zoneName: current.domain.primaryDomain,
        expectedSerial,
        expectedDnskey: key.dnskey,
        publishedAt,
        primaryTarget: identity.settings.ns1.ipv4,
        secondaryTargets: identity.settings.secondaryDns,
      });
    } catch (error) { throw hostFailure(error); }
  }

  async function previewRolloverKeyDeletion({ domainId, keyId } = {}) {
    const current = await context(domainId);
    try {
      return await rolloverMethod('previewRolloverKeyDeletion')({
        zoneName: current.domain.primaryDomain,
        apiKey: current.apiKey,
        keyId,
      });
    } catch (error) { throw hostFailure(error); }
  }

  async function deleteRolloverKey({
    domainId,
    keyId,
    expectedKeySetDigest,
    expectedRemainingKeySetDigest,
  } = {}) {
    const current = await context(domainId);
    try {
      return await rolloverMethod('deleteRolloverKey')({
        zoneName: current.domain.primaryDomain,
        apiKey: current.apiKey,
        keyId,
        expectedKeySetDigest,
        expectedRemainingKeySetDigest,
      });
    } catch (error) { throw hostFailure(error); }
  }

  async function apply({ domainId, enabled, previewDigest, confirmation } = {}) {
    if (typeof enabled !== 'boolean'
      || typeof previewDigest !== 'string' || !SHA256_PATTERN.test(previewDigest)
      || typeof confirmation !== 'string' || !confirmation) {
      throw new DnsZoneDnssecError('dnssec_apply_input_invalid', 'DNSSEC apply requires target, current preview digest and exact confirmation');
    }
    const plan = await preview({ domainId, enabled });
    if (plan.previewDigest !== previewDigest) {
      throw new DnsZoneDnssecError('dnssec_preview_stale', 'DNSSEC state changed after preview; request a new preview', 409);
    }
    if (plan.noChanges) throw new DnsZoneDnssecError('dnssec_no_changes', 'DNSSEC already has the requested state', 409);
    if (!plan.applyAllowed) {
      throw new DnsZoneDnssecError('dnssec_apply_blocked', 'DNSSEC mutation is blocked by signing or parent delegation state', 409);
    }
    if (confirmation !== plan.confirmation) {
      throw new DnsZoneDnssecError('dnssec_confirmation_invalid', 'Exact DNSSEC confirmation is required', 409);
    }

    const current = await context(domainId);
    if (!enabled) {
      const immediateParent = await inspectParent(current.domain.primaryDomain);
      if (immediateParent.status !== 'absent') {
        throw new DnsZoneDnssecError(
          'dnssec_parent_state_changed',
          'Parent DS state changed or became unverifiable before DNSSEC disable; request a new preview',
          409,
        );
      }
    }

    let authoritative;
    try {
      authoritative = await (enabled ? manager.enable : manager.disable)({
        zoneName: current.domain.primaryDomain,
        apiKey: current.apiKey,
      });
    } catch (error) { throw hostFailure(error); }
    const parent = await inspectParent(current.domain.primaryDomain);
    return Object.freeze({
      applied: true,
      changed: authoritative.changed === true,
      ...publicState(current.domain, authoritative, parent),
    });
  }

  return Object.freeze({
    status,
    preview,
    previewRollover,
    createRolloverKey,
    previewRolloverKeyState,
    setRolloverKeyState,
    inspectRolloverPropagation,
    previewRolloverKeyDeletion,
    deleteRolloverKey,
    apply,
  });
}

export const dnsZoneDnssecInternals = Object.freeze({
  digest,
  rootDomain,
  dsIntersection,
  localSigningReady,
  statusFor,
  publicState,
  previewBlockers,
  rolloverKeyView,
  rolloverPreflight,
  rolloverStages: ROLLOVER_STAGES,
  hostFailure,
});
