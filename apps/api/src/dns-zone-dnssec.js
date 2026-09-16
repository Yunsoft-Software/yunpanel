import { createHash } from 'node:crypto';
import {
  createDnsParentDsInspector,
  DnsParentDsInspectorError,
} from '@yunpanel/host-runtime/dns-parent-ds-inspector';
import {
  createPowerDnsDnssecManager,
  PowerDnsDnssecManagerError,
} from '@yunpanel/host-runtime/powerdns-dnssec-manager';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

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

function statusFor(authoritative, parent) {
  if (authoritative.dnssec !== true) {
    if (parent.status === 'present') return 'parent_ds_without_dnssec';
    if (parent.status === 'unverifiable') return 'insecure_parent_unverifiable';
    return 'insecure';
  }
  if (parent.status === 'unverifiable') return 'parent_ds_unverifiable';
  if (parent.status === 'absent') return 'pending_parent_ds';
  return dsIntersection(authoritative.ds, parent.records).length > 0 ? 'secure_ready' : 'parent_ds_mismatch';
}

function publicState(domain, authoritative, parent) {
  const matches = dsIntersection(authoritative.ds, parent.records);
  const status = statusFor(authoritative, parent);
  return Object.freeze({
    version: 1,
    domainId: domain.id,
    serverId: domain.serverId,
    zoneName: domain.primaryDomain,
    dnssec: authoritative.dnssec,
    status,
    secureReady: status === 'secure_ready',
    serial: authoritative.serial,
    keys: authoritative.keys,
    ds: authoritative.ds,
    parent: Object.freeze({
      status: parent.status,
      records: parent.records,
      matchingRecords: matches,
      errorCode: parent.errorCode,
      checkedAt: parent.checkedAt,
    }),
    registrar: Object.freeze({
      addDs: authoritative.dnssec === true && parent.status !== 'present' ? authoritative.ds : Object.freeze([]),
      removeDsBeforeDisable: authoritative.dnssec === true && parent.status === 'present' ? parent.records : Object.freeze([]),
    }),
  });
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
  if (error instanceof PowerDnsDnssecManagerError || error instanceof DnsParentDsInspectorError) {
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
} = {}) {
  if (!domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !powerDnsSecretRegistry || typeof powerDnsSecretRegistry.materializeForServer !== 'function'
    || typeof localServerId !== 'string' || !localServerId
    || !manager || typeof manager.inspect !== 'function' || typeof manager.enable !== 'function' || typeof manager.disable !== 'function'
    || !parentDsInspector || typeof parentDsInspector.inspect !== 'function') {
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

  async function status({ domainId } = {}) {
    return inspectContext(await context(domainId));
  }

  async function preview({ domainId, enabled } = {}) {
    if (typeof enabled !== 'boolean') {
      throw new DnsZoneDnssecError('dnssec_target_invalid', 'DNSSEC target state must be boolean');
    }
    const state = await status({ domainId });
    const blockers = previewBlockers(state, enabled);
    const noChanges = state.dnssec === enabled;
    const payload = Object.freeze({
      version: 1,
      domainId: state.domainId,
      serverId: state.serverId,
      zoneName: state.zoneName,
      targetEnabled: enabled,
      currentDnssec: state.dnssec,
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
      throw new DnsZoneDnssecError('dnssec_apply_blocked', 'DNSSEC mutation is blocked by parent delegation state', 409);
    }
    if (confirmation !== plan.confirmation) {
      throw new DnsZoneDnssecError('dnssec_confirmation_invalid', 'Exact DNSSEC confirmation is required', 409);
    }

    const current = await context(domainId);
    let authoritative;
    try {
      authoritative = await (enabled ? manager.enable : manager.disable)({
        zoneName: current.domain.primaryDomain,
        apiKey: current.apiKey,
      });
    } catch (error) { throw hostFailure(error); }
    let parent;
    try { parent = await parentDsInspector.inspect({ domain: current.domain.primaryDomain }); }
    catch (error) { throw hostFailure(error); }
    return Object.freeze({
      applied: true,
      changed: authoritative.changed === true,
      ...publicState(current.domain, authoritative, parent),
    });
  }

  return Object.freeze({ status, preview, apply });
}

export const dnsZoneDnssecInternals = Object.freeze({
  digest,
  rootDomain,
  dsIntersection,
  statusFor,
  publicState,
  previewBlockers,
  hostFailure,
});
