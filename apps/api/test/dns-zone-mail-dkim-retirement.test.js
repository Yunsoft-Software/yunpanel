import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDnsZoneMailDkimRetirementService,
  DnsZoneMailDkimRetirementError,
} from '../src/dns-zone-mail-dkim-retirement.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const domainId = '8bc307db-9e2d-4c3f-91ea-49e740d259a9';
const mailDomainId = 'f77d9d70-3f77-4be9-b257-0ade06401fb7';
const operationId = 'fb31a82f-62d2-49e9-8ad0-bf56ce06449f';
const previousValue = 'v=DKIM1; k=rsa; p=previous';

function fixture({ oldPresent = true, source = 'mail', extraChange = null } = {}) {
  let serial = 2026091701;
  let present = oldPresent;
  let retirement = {
    mailDomainId,
    domainName: 'example.com',
    previousSelector: 'previous',
    previousDnsRecord: {
      type: 'TXT',
      name: 'previous._domainkey.example.com',
      value: previousValue,
    },
    targetSelector: 'current',
    phase: 'dns_retirement_pending',
    revision: 2,
  };
  let startCalls = 0;
  let beginCalls = 0;
  let clearCalls = 0;

  function zonePreview(input) {
    const effectiveRevision = input.retirePendingDkim ? input.retirePendingDkim.expectedRevision + 1 : retirement.revision;
    const changes = present ? [
      { action: 'replace', owner: 'example.com', type: 'SOA', source: 'template', key: 'zone-soa' },
      { action: 'delete', owner: 'previous._domainkey.example.com', type: 'TXT', source: 'mail', key: 'mail-dkim-previous' },
      ...(extraChange ? [extraChange] : []),
    ] : [];
    return {
      domainId,
      serverId,
      zoneName: 'example.com',
      observedSerial: serial,
      noChanges: !present,
      applyAllowed: present,
      changes,
      conflicts: [],
      blockers: [],
      previewDigest: present ? 'a'.repeat(64) : 'b'.repeat(64),
      mailStateDigest: 'c'.repeat(64),
      mailState: {
        retirementPhase: 'dns_retirement_applying',
        retirementRevision: effectiveRevision,
      },
    };
  }

  const runtime = {
    preview: async (input) => zonePreview(input),
    start: async ({ domainId: requestedDomainId, previewDigest, confirmation }) => {
      startCalls += 1;
      assert.equal(requestedDomainId, domainId);
      assert.equal(previewDigest, 'a'.repeat(64));
      assert.equal(confirmation, `reapply-dns-zone-template:${domainId}:${previewDigest}`);
      present = false;
      serial += 1;
      return { id: operationId, domainId, status: 'succeeded' };
    },
  };
  const retirementRegistry = {
    getRetirement: async () => retirement ? structuredClone(retirement) : null,
    beginRetirement: async (_id, { expectedRevision, confirmation }) => {
      beginCalls += 1;
      assert.equal(expectedRevision, retirement.revision);
      assert.equal(confirmation, `begin-dkim-retirement:${mailDomainId}:previous:${retirement.revision}`);
      retirement = { ...retirement, phase: 'dns_retirement_applying', revision: retirement.revision + 1 };
      return structuredClone(retirement);
    },
    clearRetirement: async (_id, { expectedRevision, confirmation }) => {
      clearCalls += 1;
      assert.equal(expectedRevision, retirement.revision);
      assert.equal(confirmation, `clear-dkim-retirement:${mailDomainId}:previous:${retirement.revision}`);
      const cleared = structuredClone(retirement);
      retirement = null;
      return cleared;
    },
  };
  const service = createDnsZoneMailDkimRetirementService({
    mailDomainRegistry: {
      getMailDomain: async () => ({
        id: mailDomainId,
        webDomainId: domainId,
        domainName: 'example.com',
        managementMode: 'local',
        status: 'enabled',
      }),
    },
    mailDkimRetirementRegistry: retirementRegistry,
    domainRegistry: {
      getDomain: async () => ({
        id: domainId,
        serverId,
        primaryDomain: 'example.com',
        parentDomainId: null,
      }),
    },
    dnsZoneRecordsService: {
      getZone: async () => ({
        domainId,
        serverId,
        zoneName: 'example.com',
        serial,
        rrsets: present ? [{
          owner: 'previous._domainkey.example.com',
          type: 'TXT',
          source,
          key: source === 'mail' ? 'mail-dkim-previous' : null,
          records: [{ value: previousValue, disabled: false }],
        }] : [],
      }),
    },
    dnsZoneReapplyRuntime: runtime,
    localServerId: serverId,
  });
  return {
    service,
    counts: () => ({ startCalls, beginCalls, clearCalls }),
    retirement: () => retirement,
  };
}

test('local DKIM retirement persists intent, runs durable zone reapply and clears only after authoritative absence', async () => {
  const state = fixture();
  const preview = await state.service.preview({ mailDomainId, expectedRevision: 2 });
  assert.equal(preview.readyToApply, true);
  assert.equal(preview.previousRecordState, 'managed');
  assert.equal(preview.mutationRequired, true);
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);

  const result = await state.service.apply({
    mailDomainId,
    expectedRevision: 2,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.equal(result.completed, true);
  assert.equal(result.retirementCleared, true);
  assert.equal(result.operation.status, 'succeeded');
  assert.deepEqual(state.counts(), { startCalls: 1, beginCalls: 1, clearCalls: 1 });
  assert.equal(state.retirement(), null);
});

test('already absent previous selector still journals applying intent before clearing without DNS mutation', async () => {
  const state = fixture({ oldPresent: false });
  const preview = await state.service.preview({ mailDomainId, expectedRevision: 2 });
  assert.equal(preview.readyToApply, true);
  assert.equal(preview.previousRecordState, 'absent');
  assert.equal(preview.mutationRequired, false);

  const result = await state.service.apply({
    mailDomainId,
    expectedRevision: 2,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.equal(result.completed, true);
  assert.equal(result.operation, null);
  assert.deepEqual(state.counts(), { startCalls: 0, beginCalls: 1, clearCalls: 1 });
});

test('manual previous selector and unrelated zone drift fail closed', async () => {
  await assert.rejects(
    fixture({ source: 'manual' }).service.preview({ mailDomainId, expectedRevision: 2 }),
    (error) => error instanceof DnsZoneMailDkimRetirementError
      && error.code === 'mail_dkim_local_retirement_record_conflict',
  );

  const drift = fixture({
    extraChange: {
      action: 'replace', owner: 'example.com', type: 'A', source: 'template', key: 'apex-ipv4',
    },
  });
  const preview = await drift.service.preview({ mailDomainId, expectedRevision: 2 });
  assert.equal(preview.readyToApply, false);
  assert.equal(preview.blocker, 'mail_dkim_local_retirement_requires_clean_zone');
  await assert.rejects(
    drift.service.apply({
      mailDomainId,
      expectedRevision: 2,
      previewDigest: preview.previewDigest,
      confirmation: 'blocked',
    }),
    (error) => error instanceof DnsZoneMailDkimRetirementError
      && error.code === 'mail_dkim_local_retirement_preview_stale',
  );
  assert.deepEqual(drift.counts(), { startCalls: 0, beginCalls: 0, clearCalls: 0 });
});
