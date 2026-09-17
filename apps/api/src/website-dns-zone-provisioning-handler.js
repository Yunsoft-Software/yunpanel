import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import path from 'node:path';
import { createPowerDnsZoneManager } from '@yunpanel/host-runtime/powerdns-zone-manager';
import { createPowerDnsSecretRegistry } from './powerdns-secret-registry.js';
import { WebsiteProvisioningHandlerError } from './website-provisioning-handlers.js';

const API_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function stateRoot(env) {
  return path.dirname(env.YUNPANEL_SERVER_STORE ?? path.resolve('.data/server-registry.json'));
}

function secretStorePath(env) {
  return env.YUNPANEL_POWERDNS_SECRET_STORE
    ?? path.join(stateRoot(env), 'powerdns-secret-registry.json');
}

function snapshotDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizedIntent(context = {}) {
  const intent = context.intent;
  const fields = new Set([
    'adapter', 'serverId', 'webDomainId', 'zoneName', 'templateVersion', 'templateSnapshot',
    'dnsIdentityRevision', 'secondaryDns', 'serial', 'dnssec', 'records',
  ]);
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)
    || Object.keys(intent).length !== fields.size || Object.keys(intent).some((field) => !fields.has(field))
    || intent.adapter !== 'powerdns-zone'
    || typeof intent.serverId !== 'string' || !intent.serverId
    || typeof intent.webDomainId !== 'string' || !intent.webDomainId
    || typeof intent.zoneName !== 'string' || !intent.zoneName
    || !Number.isSafeInteger(intent.templateVersion) || intent.templateVersion < 1
    || !Array.isArray(intent.templateSnapshot) || intent.templateSnapshot.length < 1
    || !Number.isSafeInteger(intent.dnsIdentityRevision) || intent.dnsIdentityRevision < 1
    || !Array.isArray(intent.secondaryDns) || intent.secondaryDns.length > 8
    || intent.secondaryDns.some((entry) => typeof entry !== 'string' || !isIP(entry))
    || new Set(intent.secondaryDns).size !== intent.secondaryDns.length
    || !Number.isSafeInteger(intent.serial) || intent.serial < 1
    || typeof intent.dnssec !== 'boolean'
    || !Array.isArray(intent.records) || intent.records.length < 2) {
    throw new WebsiteProvisioningHandlerError(
      'website_dns_zone_intent_invalid',
      'Website DNS zone provisioning intent is invalid',
      400,
    );
  }
  return Object.freeze({
    ...intent,
    secondaryDns: Object.freeze([...intent.secondaryDns].sort()),
    templateSnapshot: Object.freeze(intent.templateSnapshot.map((entry) => Object.freeze({
      ...entry,
      values: Object.freeze([...(entry.values ?? [])]),
    }))),
    records: Object.freeze(intent.records.map((entry) => Object.freeze({
      ...entry,
      values: Object.freeze([...(entry.values ?? [])]),
    }))),
  });
}

function defaultSecretMaterializer(env = process.env) {
  let registryPromise = null;
  async function registryFor(serverId) {
    if (!registryPromise) {
      registryPromise = (async () => {
        const localServerId = env.YUNPANEL_LOCAL_SERVER_ID?.trim() || null;
        if (!localServerId || localServerId !== serverId) {
          throw new WebsiteProvisioningHandlerError(
            'website_dns_zone_local_server_required',
            'PowerDNS Website zone provisioning is restricted to this panel host',
            404,
          );
        }
        const registry = createPowerDnsSecretRegistry({
          filePath: secretStorePath(env),
          masterKey: env.YUNPANEL_SECRET_MASTER_KEY ?? null,
          serverExists: async (id) => id === localServerId,
        });
        await registry.init();
        return registry;
      })();
    }
    return registryPromise;
  }
  return async (serverId) => (await registryFor(serverId)).materializeForServer(serverId);
}

function publicEvidence(intent, result) {
  return Object.freeze({
    satisfied: true,
    adapter: 'powerdns-zone',
    serverId: intent.serverId,
    webDomainId: intent.webDomainId,
    zoneName: intent.zoneName,
    zoneKind: result.kind ?? null,
    templateVersion: intent.templateVersion,
    templateSnapshotDigest: snapshotDigest(intent.templateSnapshot),
    dnsIdentityRevision: intent.dnsIdentityRevision,
    secondaryDns: intent.secondaryDns,
    requestedSerial: intent.serial,
    observedSerial: result.serial ?? null,
    notifiedSerial: result.notifiedSerial ?? result.notification?.notifiedSerial ?? null,
    notifyRequested: intent.secondaryDns.length > 0,
    notifyAccepted: result.notification?.accepted === true,
    notifyCurrentSerialDispatched: result.notification?.currentSerialDispatched === true,
    dnssec: result.dnssec === true,
    managedRrsetCount: result.managedRrsetCount ?? intent.records.length,
    manualRrsetCount: result.manualRrsetCount ?? 0,
    created: result.created === true,
    primaryKindChanged: result.primaryKindChanged === true,
    changedRrsetCount: Number.isSafeInteger(result.changedRrsetCount) ? result.changedRrsetCount : 0,
  });
}

function compensationOwnership(context, intent) {
  const evidence = context.evidence;
  const expectedSnapshotDigest = snapshotDigest(intent.templateSnapshot);
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || evidence.satisfied !== true
    || evidence.adapter !== 'powerdns-zone'
    || evidence.serverId !== intent.serverId
    || evidence.webDomainId !== intent.webDomainId
    || evidence.zoneName !== intent.zoneName
    || evidence.templateVersion !== intent.templateVersion
    || evidence.templateSnapshotDigest !== expectedSnapshotDigest
    || evidence.dnsIdentityRevision !== intent.dnsIdentityRevision
    || evidence.requestedSerial !== intent.serial
    || evidence.dnssec !== intent.dnssec
    || JSON.stringify(evidence.secondaryDns) !== JSON.stringify(intent.secondaryDns)
    || typeof evidence.created !== 'boolean'
    || !Number.isSafeInteger(evidence.changedRrsetCount) || evidence.changedRrsetCount < 0) {
    throw new WebsiteProvisioningHandlerError(
      'website_dns_zone_compensation_evidence_invalid',
      'Website DNS zone compensation requires exact persisted apply ownership evidence',
      409,
    );
  }
  if (evidence.created === true) return Object.freeze({ operationOwned: true });
  if (evidence.changedRrsetCount === 0) return Object.freeze({ operationOwned: false });
  throw new WebsiteProvisioningHandlerError(
    'website_dns_zone_compensation_rollback_unavailable',
    'Pre-existing PowerDNS zone changes cannot be removed without an exact pre-operation snapshot',
    409,
  );
}

export function createWebsiteDnsZoneProvisioningHandler({
  zoneManager = createPowerDnsZoneManager(),
  materializeSecret = null,
  env = process.env,
} = {}) {
  if (!zoneManager || typeof zoneManager.inspect !== 'function' || typeof zoneManager.apply !== 'function'
    || typeof zoneManager.compensate !== 'function' || typeof zoneManager.inspectCompensation !== 'function'
    || (materializeSecret !== null && typeof materializeSecret !== 'function')) {
    throw new WebsiteProvisioningHandlerError(
      'website_dns_zone_dependencies_invalid',
      'Website DNS zone provisioning dependencies are unavailable',
      503,
    );
  }
  const resolveSecret = materializeSecret ?? defaultSecretMaterializer(env);

  async function secret(serverId) {
    const materialized = await resolveSecret(serverId);
    if (!materialized || materialized.serverId !== serverId
      || typeof materialized.apiKey !== 'string' || !API_KEY_PATTERN.test(materialized.apiKey)) {
      throw new WebsiteProvisioningHandlerError(
        'website_dns_zone_secret_invalid',
        'PowerDNS API key material is unavailable',
        503,
      );
    }
    return materialized.apiKey;
  }

  async function inspect(context = {}) {
    const intent = normalizedIntent(context);
    const result = await zoneManager.inspect({
      zoneName: intent.zoneName,
      apiKey: await secret(intent.serverId),
      records: intent.records,
      notifySecondaries: intent.secondaryDns.length > 0,
    });
    if (!result?.satisfied) return Object.freeze({
      satisfied: false,
      reason: result?.reason ?? 'website_dns_zone_pending',
      zoneName: intent.zoneName,
    });
    return publicEvidence(intent, result);
  }

  async function apply(context = {}) {
    const intent = normalizedIntent(context);
    const result = await zoneManager.apply({
      zoneName: intent.zoneName,
      apiKey: await secret(intent.serverId),
      records: intent.records,
      dnssec: intent.dnssec,
      notifySecondaries: intent.secondaryDns.length > 0,
    });
    if (!result?.satisfied) {
      throw new WebsiteProvisioningHandlerError(
        'website_dns_zone_apply_unverified',
        'PowerDNS Website zone apply did not return verified evidence',
      );
    }
    return publicEvidence(intent, result);
  }

  async function compensate(context = {}) {
    const intent = normalizedIntent(context);
    const ownership = compensationOwnership(context, intent);
    if (!ownership.operationOwned) return Object.freeze({
      satisfied: true,
      zoneName: intent.zoneName,
      deleted: false,
      preservedPreExisting: true,
    });
    return zoneManager.compensate({
      zoneName: intent.zoneName,
      apiKey: await secret(intent.serverId),
      records: intent.records,
    });
  }

  async function inspectCompensation(context = {}) {
    const intent = normalizedIntent(context);
    const ownership = compensationOwnership(context, intent);
    if (!ownership.operationOwned) return Object.freeze({
      satisfied: true,
      zoneName: intent.zoneName,
      deleted: false,
      preservedPreExisting: true,
    });
    return zoneManager.inspectCompensation({
      zoneName: intent.zoneName,
      apiKey: await secret(intent.serverId),
      records: intent.records,
    });
  }

  return Object.freeze({ apply, inspect, compensate, inspectCompensation });
}

export const websiteDnsZoneProvisioningInternals = Object.freeze({
  stateRoot,
  secretStorePath,
  snapshotDigest,
  normalizedIntent,
  defaultSecretMaterializer,
  publicEvidence,
  compensationOwnership,
});
