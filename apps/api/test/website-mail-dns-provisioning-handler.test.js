import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebsiteMailDnsProvisioningHandler,
  WebsiteMailDnsProvisioningError,
} from '../src/website-mail-dns-provisioning-handler.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const webDomainId = '3854e385-adfc-42bd-bccf-f655f24cd68f';
const mailDomainId = '2dd93f8e-23aa-4e2e-b65c-f53eb29558dd';
const childOperationId = 'f22d41c3-8540-43f3-9a58-88096e1fe630';
const selector = 'yp-9ae512c0a7174611943c6ce2';
const dkimValue = 'v=DKIM1; k=rsa; p=public-key-material';
const sourceDigest = 'a'.repeat(64);
const appliedDigest = 'b'.repeat(64);
const mailStateDigest = 'c'.repeat(64);
const previewDigest = 'd'.repeat(64);

function provisioningIntent(overrides = {}) {
  return {
    adapter: 'powerdns-mail-reapply',
    serverId,
    websiteId,
    webDomainId,
    zoneName: 'example.com',
    mailDomainId,
    domainName: 'example.com',
    expectedMailDomainRevision: 2,
    expectedMailDomainStatus: 'enabled',
    expectedDkimKeyRevision: 1,
    selector,
    ...overrides,
  };
}

function mailState() {
  return {
    version: 1,
    managed: true,
    enabled: true,
    mailDomainId,
    mailDomainRevision: 2,
    mailServiceIdentityRevision: 4,
    mailDiscoveryEndpointRevision: null,
    roundcubeWebmailMappingRevision: null,
    roundcubeWebmailPreviewSha256: null,
    dkimRevisions: [1],
    retirementPhase: null,
    retirementRevision: null,
  };
}

function records() {
  return [{
    key: `mail-dkim-${selector}`,
    owner: `${selector}._domainkey.example.com`,
    type: 'TXT',
    ttl: 300,
    values: [dkimValue],
    source: 'mail',
    templateVersion: null,
  }];
}

function pendingPreview() {
  return {
    version: 1,
    domainId: webDomainId,
    serverId,
    domainRevision: 1,
    zoneName: 'example.com',
    zoneKind: 'Native',
    primaryKindChangeRequired: false,
    secondaryDns: [],
    templateVersion: 5,
    templateSnapshotDigest: 'e'.repeat(64),
    dnsIdentityRevision: 4,
    mailState: mailState(),
    mailStateDigest,
    sourceZoneDigest: sourceDigest,
    observedSerial: 2026091901,
    nextSerial: 2026091902,
    dnssec: false,
    records: records(),
    changes: [{ action: 'replace', owner: `${selector}._domainkey.example.com`, type: 'TXT' }],
    conflicts: [],
    blockers: [],
    changeRequired: true,
    noChanges: false,
    applyAllowed: true,
    unchangedRrsetCount: 4,
    preservedManualRrsetCount: 0,
    previewDigest,
    confirmation: `reapply-dns-zone-template:${webDomainId}:${previewDigest}`,
  };
}

function appliedPreview() {
  return {
    ...pendingPreview(),
    sourceZoneDigest: appliedDigest,
    observedSerial: 2026091902,
    nextSerial: 2026091902,
    changes: [],
    changeRequired: false,
    noChanges: true,
    applyAllowed: false,
    previewDigest: 'f'.repeat(64),
    confirmation: null,
  };
}

function succeededOperation() {
  return {
    id: childOperationId,
    domainId: webDomainId,
    serverId,
    zoneName: 'example.com',
    domainRevision: 1,
    templateVersion: 5,
    dnsIdentityRevision: 4,
    mailStateDigest,
    observedSerial: 2026091901,
    targetSerial: 2026091902,
    previewDigest,
    status: 'succeeded',
    result: {
      satisfied: true,
      zoneName: 'example.com',
      serial: 2026091902,
      changedRrsetCount: 1,
      manualRrsetCount: 0,
    },
    error: null,
    rollback: {
      available: true,
      status: 'idle',
      sourceZoneDigest: sourceDigest,
      appliedZoneDigest: appliedDigest,
      result: null,
      error: null,
      automaticReplayBlocked: false,
    },
    createdAt: '2026-09-19T03:00:00.000Z',
    updatedAt: '2026-09-19T03:00:01.000Z',
  };
}

function rolledBackOperation() {
  return {
    ...succeededOperation(),
    status: 'rolled_back',
    rollback: {
      ...succeededOperation().rollback,
      available: false,
      status: 'succeeded',
      result: {
        satisfied: true,
        zoneName: 'example.com',
        restoredRrsetCount: 1,
        kindRestored: false,
        sourceZoneDigest: sourceDigest,
      },
    },
    updatedAt: '2026-09-19T03:00:02.000Z',
  };
}

function fixture({
  initiallyApplied = false,
  includeHistory = true,
  mailDomainRevision = 2,
  keySelector = selector,
} = {}) {
  let applied = initiallyApplied;
  let rolledBack = false;
  let starts = 0;
  let rollbacks = 0;

  const runtime = {
    async preview({ domainId }) {
      assert.equal(domainId, webDomainId);
      return applied && !rolledBack ? appliedPreview() : pendingPreview();
    },
    async start(input) {
      assert.deepEqual(input, {
        domainId: webDomainId,
        previewDigest,
        confirmation: `reapply-dns-zone-template:${webDomainId}:${previewDigest}`,
      });
      starts += 1;
      applied = true;
      rolledBack = false;
      return succeededOperation();
    },
    async listForDomain(domainId) {
      assert.equal(domainId, webDomainId);
      return includeHistory && applied && !rolledBack ? [succeededOperation()] : [];
    },
    async get(operationId) {
      assert.equal(operationId, childOperationId);
      if (rolledBack) return rolledBackOperation();
      return includeHistory || applied ? succeededOperation() : null;
    },
    async rollbackPreview({ domainId, operationId }) {
      assert.equal(domainId, webDomainId);
      assert.equal(operationId, childOperationId);
      return {
        operation: succeededOperation(),
        inspection: {
          satisfied: false,
          repairCandidate: true,
          sourceZoneDigest: sourceDigest,
          appliedZoneDigest: appliedDigest,
        },
        confirmation: `rollback-dns-zone-reapply:${webDomainId}:${childOperationId}`,
      };
    },
    async rollback(input) {
      assert.equal(input.domainId, webDomainId);
      assert.equal(input.operationId, childOperationId);
      assert.equal(input.expectedUpdatedAt, '2026-09-19T03:00:01.000Z');
      assert.equal(input.sourceZoneDigest, sourceDigest);
      assert.equal(input.appliedZoneDigest, appliedDigest);
      assert.equal(typeof input.confirmation, 'string');
      rollbacks += 1;
      rolledBack = true;
      applied = false;
      return rolledBackOperation();
    },
  };

  const handler = createWebsiteMailDnsProvisioningHandler({
    mailDomainRegistry: {
      async getMailDomain(id) {
        assert.equal(id, mailDomainId);
        return {
          id: mailDomainId,
          webDomainId,
          domainName: 'example.com',
          managementMode: 'local',
          status: 'enabled',
          revision: mailDomainRevision,
        };
      },
    },
    domainRegistry: {
      async getDomain(id) {
        assert.equal(id, webDomainId);
        return {
          id: webDomainId,
          serverId,
          websiteId,
          primaryDomain: 'example.com',
          parentDomainId: null,
        };
      },
    },
    mailDkimRegistry: {
      async getKey(id) {
        assert.equal(id, mailDomainId);
        return {
          mailDomainId,
          domainName: 'example.com',
          selector: keySelector,
          algorithm: 'rsa-sha256',
          publicKey: 'public-key-material',
          dnsRecord: {
            type: 'TXT',
            name: `${keySelector}._domainkey.example.com`,
            value: dkimValue,
          },
          revision: 1,
        };
      },
    },
    dnsZoneReapplyRuntime: runtime,
  });

  return {
    handler,
    context: {
      operationId: '9ae512c0-a717-4611-943c-6ce2ab0abf16',
      websiteId,
      intent: provisioningIntent(),
      evidence: null,
    },
    starts: () => starts,
    rollbacks: () => rollbacks,
  };
}

test('Website local mail DNS applies the exact durable PowerDNS desired state', async () => {
  const f = fixture();
  const evidence = await f.handler.apply(f.context);

  assert.equal(evidence.satisfied, true);
  assert.equal(evidence.adapter, 'powerdns-mail-reapply');
  assert.equal(evidence.webDomainId, webDomainId);
  assert.equal(evidence.mailDomainId, mailDomainId);
  assert.equal(evidence.dnsReapplyOperationId, childOperationId);
  assert.equal(evidence.previewDigest, previewDigest);
  assert.equal(evidence.mailStateDigest, mailStateDigest);
  assert.equal(evidence.appliedZoneDigest, appliedDigest);
  assert.equal(evidence.serial, 2026091902);
  assert.equal(f.starts(), 1);
});

test('Website local mail DNS inspect recovers a lost acknowledgement without a second mutation', async () => {
  const f = fixture({ initiallyApplied: true });
  const evidence = await f.handler.inspect(f.context);

  assert.equal(evidence.satisfied, true);
  assert.equal(evidence.dnsReapplyOperationId, childOperationId);
  assert.equal(f.starts(), 0);
});

test('Website local mail DNS refuses to adopt an unexplained matching zone state', async () => {
  const f = fixture({ initiallyApplied: true, includeHistory: false });
  await assert.rejects(
    f.handler.inspect(f.context),
    (error) => error instanceof WebsiteMailDnsProvisioningError
      && error.code === 'website_mail_dns_ownership_evidence_missing',
  );
  assert.equal(f.starts(), 0);
});

test('Website local mail DNS compensation uses the durable exact-snapshot rollback', async () => {
  const f = fixture();
  const evidence = await f.handler.apply(f.context);
  const compensation = await f.handler.compensate({ ...f.context, evidence });

  assert.equal(compensation.satisfied, true);
  assert.equal(compensation.rolledBack, true);
  assert.equal(compensation.dnsReapplyOperationId, childOperationId);
  assert.equal(compensation.sourceZoneDigest, sourceDigest);
  assert.equal(f.rollbacks(), 1);
  assert.equal((await f.handler.inspectCompensation({ ...f.context, evidence })).satisfied, true);
});

test('Website local mail DNS fails closed when the Mail Domain revision drifts', async () => {
  const f = fixture({ mailDomainRevision: 3 });
  await assert.rejects(
    f.handler.apply(f.context),
    (error) => error instanceof WebsiteMailDnsProvisioningError
      && error.code === 'website_mail_dns_mail_state_drift',
  );
  assert.equal(f.starts(), 0);
});

test('Website local mail DNS fails closed when a foreign DKIM selector owns the key', async () => {
  const f = fixture({ keySelector: 'manual-selector' });
  await assert.rejects(
    f.handler.apply(f.context),
    (error) => error instanceof WebsiteMailDnsProvisioningError
      && error.code === 'website_mail_dns_dkim_state_drift',
  );
  assert.equal(f.starts(), 0);
});
