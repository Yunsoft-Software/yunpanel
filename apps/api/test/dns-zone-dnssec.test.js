import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDnsZoneDnssecService,
  DnsZoneDnssecError,
} from '../src/dns-zone-dnssec.js';

const domainId = '8bc307db-9e2d-4c3f-91ea-49e740d259a9';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const apiKey = 'a'.repeat(43);
const ds = '12345 13 2 AABBCCDD';

function authoritative({ dnssec = false, records = dnssec ? [ds] : [], changed = false } = {}) {
  return Object.freeze({
    adapter: 'powerdns-authoritative-api',
    zoneName: 'example.com',
    dnssec,
    serial: 2026091601,
    keySetDigest: dnssec ? 'a'.repeat(64) : 'b'.repeat(64),
    keys: Object.freeze(dnssec ? [Object.freeze({
      id: 1,
      keyType: 'csk',
      active: true,
      published: true,
      dnskey: '257 3 13 AAAATEST',
      ds: Object.freeze(records),
      cds: Object.freeze(records),
      algorithm: 'ECDSAP256SHA256',
      bits: 256,
    })] : []),
    ds: Object.freeze(records),
    keyCount: dnssec ? 1 : 0,
    activeKeyCount: dnssec ? 1 : 0,
    ready: dnssec && records.length > 0,
    changed,
  });
}

function parent(status = 'absent', records = []) {
  return Object.freeze({
    version: 1,
    domain: 'example.com',
    status,
    records: Object.freeze(records),
    errorCode: status === 'unverifiable' ? 'ETIMEOUT' : null,
    checkedAt: '2026-09-16T00:30:00.000Z',
  });
}

function fixture({ current = authoritative(), parentStates = [parent()], enableResult = null, disableResult = null } = {}) {
  const calls = [];
  let currentState = current;
  let parentIndex = 0;
  const domainRegistry = {
    getDomain: async (id) => id === domainId ? {
      id: domainId,
      serverId,
      primaryDomain: 'example.com',
      parentDomainId: null,
      desiredRevision: 1,
    } : null,
  };
  const powerDnsSecretRegistry = {
    materializeForServer: async (id) => ({ serverId: id, revision: 1, apiKey }),
  };
  const manager = {
    inspect: async (input) => { calls.push(['inspect', input]); return currentState; },
    enable: async (input) => {
      calls.push(['enable', input]);
      currentState = enableResult ?? authoritative({ dnssec: true, changed: true });
      return currentState;
    },
    disable: async (input) => {
      calls.push(['disable', input]);
      currentState = disableResult ?? authoritative({ dnssec: false, changed: true });
      return currentState;
    },
    createRolloverKey: async (input) => {
      calls.push(['create-rollover-key', input]);
      return { changed: true, keySetDigest: 'c'.repeat(64), createdKey: { id: 2, ds: ['22345 13 2 EEFF0011'] } };
    },
    previewRolloverKeyState: async (input) => {
      calls.push(['preview-rollover-key-state', input]);
      return { keySetDigest: 'c'.repeat(64), targetKeySetDigest: 'd'.repeat(64), targetKey: { id: input.keyId } };
    },
    setRolloverKeyState: async (input) => {
      calls.push(['set-rollover-key-state', input]);
      return { changed: true, keySetDigest: input.expectedTargetKeySetDigest, updatedKey: { id: input.keyId } };
    },
    previewRolloverKeyDeletion: async (input) => {
      calls.push(['preview-rollover-key-deletion', input]);
      return { keySetDigest: 'e'.repeat(64), remainingKeySetDigest: 'f'.repeat(64), deletedKey: { id: input.keyId } };
    },
    deleteRolloverKey: async (input) => {
      calls.push(['delete-rollover-key', input]);
      return { changed: true, keySetDigest: input.expectedRemainingKeySetDigest, deletedKeyId: input.keyId };
    },
  };
  const parentDsInspector = {
    inspect: async (input) => {
      calls.push(['parent', input]);
      const value = parentStates[Math.min(parentIndex, parentStates.length - 1)];
      parentIndex += 1;
      return value;
    },
  };
  return {
    calls,
    service: createDnsZoneDnssecService({
      domainRegistry,
      powerDnsSecretRegistry,
      localServerId: serverId,
      manager,
      parentDsInspector,
    }),
  };
}

test('reports secure_ready only when a published parent DS matches local PowerDNS material', async () => {
  const { service } = fixture({
    current: authoritative({ dnssec: true }),
    parentStates: [parent('present', [ds])],
  });
  const status = await service.status({ domainId });

  assert.equal(status.status, 'secure_ready');
  assert.equal(status.secureReady, true);
  assert.deepEqual(status.parent.matchingRecords, [ds]);
});

test('reports mismatched parent DS without claiming secure delegation', async () => {
  const stale = '54321 13 2 DDEEFF00';
  const { service } = fixture({
    current: authoritative({ dnssec: true }),
    parentStates: [parent('present', [stale])],
  });
  const status = await service.status({ domainId });

  assert.equal(status.status, 'parent_ds_mismatch');
  assert.equal(status.secureReady, false);
  assert.deepEqual(status.parent.matchingRecords, []);
  assert.deepEqual(status.ds, [ds]);
});

test('enables DNSSEC only with exact preview confirmation and returns registrar DS material', async () => {
  const { calls, service } = fixture({ parentStates: [parent('absent'), parent('absent'), parent('absent')] });
  const preview = await service.preview({ domainId, enabled: true });

  assert.equal(preview.applyAllowed, true);
  assert.equal(preview.noChanges, false);
  assert.match(preview.confirmation, new RegExp(`^enable-dnssec:${domainId}:`));

  await assert.rejects(
    service.apply({ domainId, enabled: true, previewDigest: preview.previewDigest, confirmation: 'wrong' }),
    (error) => error instanceof DnsZoneDnssecError && error.code === 'dnssec_confirmation_invalid',
  );
  assert.equal(calls.some((entry) => entry[0] === 'enable'), false);

  const fresh = await service.preview({ domainId, enabled: true });
  const applied = await service.apply({
    domainId,
    enabled: true,
    previewDigest: fresh.previewDigest,
    confirmation: fresh.confirmation,
  });
  assert.equal(applied.dnssec, true);
  assert.equal(applied.status, 'pending_parent_ds');
  assert.deepEqual(applied.ds, [ds]);
  assert.deepEqual(applied.registrar.addDs, [ds]);
  assert.equal(calls.some((entry) => entry[0] === 'enable'), true);
});

test('blocks DNSSEC disable while any parent DS is still published', async () => {
  const { calls, service } = fixture({
    current: authoritative({ dnssec: true }),
    parentStates: [parent('present', [ds])],
  });
  const preview = await service.preview({ domainId, enabled: false });

  assert.equal(preview.applyAllowed, false);
  assert.equal(preview.confirmation, null);
  assert.equal(preview.blockers.some((entry) => entry.code === 'parent_ds_must_be_removed'), true);
  await assert.rejects(
    service.apply({ domainId, enabled: false, previewDigest: preview.previewDigest, confirmation: 'blocked' }),
    (error) => error instanceof DnsZoneDnssecError && error.code === 'dnssec_apply_blocked',
  );
  assert.equal(calls.some((entry) => entry[0] === 'disable'), false);
});

test('blocks DNSSEC disable when parent DS lookup is unverifiable', async () => {
  const { service } = fixture({
    current: authoritative({ dnssec: true }),
    parentStates: [parent('unverifiable')],
  });
  const preview = await service.preview({ domainId, enabled: false });
  assert.equal(preview.applyAllowed, false);
  assert.equal(preview.blockers[0].code, 'parent_ds_unverifiable');
});

test('disables DNSSEC after parent DS is verifiably absent', async () => {
  const { calls, service } = fixture({
    current: authoritative({ dnssec: true }),
    parentStates: [parent('absent'), parent('absent'), parent('absent'), parent('absent')],
  });
  const preview = await service.preview({ domainId, enabled: false });
  const applied = await service.apply({
    domainId,
    enabled: false,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });

  assert.equal(applied.dnssec, false);
  assert.equal(applied.status, 'insecure');
  assert.equal(calls.some((entry) => entry[0] === 'disable'), true);
});

test('requires root local authoritative Domain scope before materializing DNS credentials', async () => {
  let secretRead = false;
  const service = createDnsZoneDnssecService({
    domainRegistry: {
      getDomain: async () => ({
        id: domainId,
        serverId,
        primaryDomain: 'sub.example.com',
        parentDomainId: '759bb4fa-ecea-4e2d-8df4-3bf20ac41980',
      }),
    },
    powerDnsSecretRegistry: {
      materializeForServer: async () => { secretRead = true; return { serverId, apiKey }; },
    },
    localServerId: serverId,
    manager: { inspect: async () => ({}), enable: async () => ({}), disable: async () => ({}) },
    parentDsInspector: { inspect: async () => parent('absent') },
  });

  await assert.rejects(
    service.status({ domainId }),
    (error) => error instanceof DnsZoneDnssecError && error.code === 'dnssec_root_domain_required',
  );
  assert.equal(secretRead, false);
});

test('previews a secure digest-bound KSK/CSK rollover without exposing private material', async () => {
  const { calls, service } = fixture({
    current: authoritative({ dnssec: true }),
    parentStates: [parent('present', [ds])],
  });
  const preview = await service.previewRollover({ domainId });

  assert.equal(preview.applyAllowed, true);
  assert.equal(preview.action, 'dnssec_key_rollover');
  assert.equal(preview.expectedKeySetDigest, 'a'.repeat(64));
  assert.deepEqual(preview.expectedKeyIds, [1]);
  assert.deepEqual(preview.oldKey, {
    id: 1,
    keyType: 'csk',
    algorithm: 'ECDSAP256SHA256',
    bits: 256,
    ds: [ds],
  });
  assert.deepEqual(preview.newKey, {
    keyType: 'csk',
    algorithm: 'ECDSAP256SHA256',
    bits: 256,
    active: false,
    published: false,
  });
  assert.deepEqual(preview.stages, [
    'create_new_key',
    'publish_new_key',
    'verify_dnskey_propagation',
    'activate_new_key',
    'await_parent_ds_addition',
    'await_old_ds_retirement',
    'deactivate_old_key',
    'delete_old_key',
  ]);
  assert.match(preview.confirmation, new RegExp(`^rollover-dnssec:${domainId}:`));
  assert.equal(JSON.stringify(preview).includes('private'), false);
  assert.deepEqual(calls.map((entry) => entry[0]), ['inspect', 'parent']);
});

test('blocks rollover unless current parent delegation is securely bound to one key', async () => {
  const stale = '54321 13 2 DDEEFF00';
  const { service } = fixture({
    current: authoritative({ dnssec: true }),
    parentStates: [parent('present', [stale])],
  });
  const preview = await service.previewRollover({ domainId });

  assert.equal(preview.applyAllowed, false);
  assert.equal(preview.confirmation, null);
  assert.equal(preview.oldKey, null);
  assert.equal(preview.blockers.some((entry) => entry.code === 'dnssec_rollover_secure_delegation_required'), true);
  assert.equal(preview.blockers.some((entry) => entry.code === 'dnssec_rollover_current_key_ambiguous'), true);
});

test('blocks rollover when another KSK/CSK artifact indicates an unfinished rotation', async () => {
  const current = authoritative({ dnssec: true });
  const second = Object.freeze({
    ...current.keys[0],
    id: 2,
    active: false,
    published: false,
    ds: Object.freeze(['22345 13 2 EEFF0011']),
    cds: Object.freeze(['22345 13 2 EEFF0011']),
  });
  const { service } = fixture({
    current: Object.freeze({ ...current, keys: Object.freeze([...current.keys, second]), keyCount: 2 }),
    parentStates: [parent('present', [ds])],
  });
  const preview = await service.previewRollover({ domainId });

  assert.equal(preview.applyAllowed, false);
  assert.equal(preview.blockers.some((entry) => entry.code === 'dnssec_rollover_key_artifact_present'), true);
});

test('binds rollover preview identity to public key-set digest and parent DS evidence', async () => {
  const first = fixture({
    current: authoritative({ dnssec: true }),
    parentStates: [parent('present', [ds])],
  });
  const drifted = authoritative({ dnssec: true });
  const second = fixture({
    current: Object.freeze({ ...drifted, keySetDigest: 'c'.repeat(64) }),
    parentStates: [parent('present', [ds])],
  });

  const left = await first.service.previewRollover({ domainId });
  const right = await second.service.previewRollover({ domainId });
  assert.notEqual(left.previewDigest, right.previewDigest);
});

test('scopes rollover host mutations through local Domain identity without returning the API key', async () => {
  const { calls, service } = fixture({
    current: authoritative({ dnssec: true }),
    parentStates: [parent('present', [ds])],
  });
  const target = { keyType: 'csk', algorithm: 'ECDSAP256SHA256', bits: 256, active: false, published: false };
  const created = await service.createRolloverKey({
    domainId,
    expectedKeySetDigest: 'a'.repeat(64),
    expectedKeyIds: [1],
    newKey: target,
  });
  const statePreview = await service.previewRolloverKeyState({ domainId, keyId: 2, active: true, published: true });
  const updated = await service.setRolloverKeyState({
    domainId,
    keyId: 2,
    expectedKeySetDigest: 'c'.repeat(64),
    expectedTargetKeySetDigest: statePreview.targetKeySetDigest,
    expectedActive: false,
    expectedPublished: false,
    active: true,
    published: true,
  });
  const deletionPreview = await service.previewRolloverKeyDeletion({ domainId, keyId: 1 });
  const deleted = await service.deleteRolloverKey({
    domainId,
    keyId: 1,
    expectedKeySetDigest: deletionPreview.keySetDigest,
    expectedRemainingKeySetDigest: deletionPreview.remainingKeySetDigest,
  });

  assert.equal(created.createdKey.id, 2);
  assert.equal(updated.updatedKey.id, 2);
  assert.equal(deleted.deletedKeyId, 1);
  assert.equal(JSON.stringify({ created, statePreview, updated, deletionPreview, deleted }).includes(apiKey), false);
  const hostCalls = calls.filter((entry) => entry[0].includes('rollover'));
  assert.deepEqual(hostCalls.map((entry) => [entry[0], entry[1].zoneName, entry[1].apiKey]), [
    ['create-rollover-key', 'example.com', apiKey],
    ['preview-rollover-key-state', 'example.com', apiKey],
    ['set-rollover-key-state', 'example.com', apiKey],
    ['preview-rollover-key-deletion', 'example.com', apiKey],
    ['delete-rollover-key', 'example.com', apiKey],
  ]);
});
