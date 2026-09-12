import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createMailDkimDnsService, MailDkimDnsError } from '../src/mail-dkim-dns.js';

const serverId = randomUUID();
const webDomainId = randomUUID();
const mailDomainId = randomUUID();
const zoneId = randomUUID();
const credentialId = randomUUID();
const PUBLIC_CURRENT = Buffer.alloc(256, 5).toString('base64');
const PUBLIC_OLD = Buffer.alloc(256, 4).toString('base64');
const currentTxt = `v=DKIM1; k=rsa; p=${PUBLIC_CURRENT}`;
const oldTxt = `v=DKIM1; k=rsa; p=${PUBLIC_OLD}`;

function fixture({ existing = [], retirement = null, activeJobs = [] } = {}) {
  const calls = [];
  let retirementState = retirement;
  const enqueued = [];
  const service = createMailDkimDnsService({
    localServerId: serverId,
    mailDomainRegistry: {
      async getMailDomain(id) {
        return id === mailDomainId ? {
          id: mailDomainId,
          webDomainId,
          domainName: 'example.com',
          managementMode: 'local',
          status: 'enabled',
        } : null;
      },
    },
    mailDkimRegistry: {
      async getKey(id) {
        return id === mailDomainId ? {
          mailDomainId,
          domainName: 'example.com',
          selector: 'mail-new',
          publicKey: PUBLIC_CURRENT,
          revision: 2,
          dnsRecord: {
            type: 'TXT',
            name: 'mail-new._domainkey.example.com',
            value: currentTxt,
          },
        } : null;
      },
    },
    mailDkimRetirementRegistry: {
      async getRetirement() { return retirementState; },
      async clearRetirement(id, input) {
        calls.push(['clearRetirement', id, structuredClone(input)]);
        retirementState = null;
      },
    },
    domainRegistry: {
      async getDomain(id) {
        return id === webDomainId ? { id: webDomainId, serverId, primaryDomain: 'example.com' } : null;
      },
    },
    dnsHostingRegistry: {
      async listZones() {
        return [{
          id: zoneId,
          webDomainId,
          zoneName: 'example.com',
          managementMode: 'external',
          status: 'ready',
          revision: 7,
        }];
      },
    },
    dnsProviderCredentialRegistry: {
      async getForZone(id) {
        assert.equal(id, zoneId);
        return {
          id: credentialId,
          dnsZoneId: zoneId,
          provider: 'cloudflare',
          configured: true,
          updatedAt: '2026-09-12T20:00:00.000Z',
        };
      },
      async materialize(id) {
        assert.equal(id, credentialId);
        return { id: credentialId, dnsZoneId: zoneId, provider: 'cloudflare', token: 'private-token-value-123456' };
      },
    },
    dnsRecordManager: {
      async inspectRecord(input) {
        calls.push(['inspect', structuredClone(input)]);
        return {
          provider: 'cloudflare',
          zoneName: 'example.com',
          desired: structuredClone(input.record),
          records: existing.map((entry) => structuredClone(entry)),
          snapshotDigest: 'a'.repeat(64),
        };
      },
    },
    jobRegistry: {
      async listJobs(filter) {
        calls.push(['listJobs', structuredClone(filter)]);
        return activeJobs.map((job) => ({ ...job }));
      },
      async enqueue(input) {
        enqueued.push(structuredClone(input));
        return { id: 'dns-job-001', status: 'queued', ...input };
      },
    },
  });
  return { service, calls, enqueued, retirement: () => retirementState };
}

test('current DKIM TXT preview queues the existing generic dns.record.apply contract', async () => {
  const state = fixture();
  const preview = await state.service.preview({
    mailDomainId,
    kind: 'current',
    expectedRevision: 2,
  });
  assert.equal(preview.effect, 'create');
  assert.equal(preview.record.type, 'TXT');
  assert.equal(preview.record.content, currentTxt);
  assert.equal(preview.record.proxied, false);
  assert.equal(preview.serverId, serverId);
  assert.equal(preview.zoneName, 'example.com');

  const applied = await state.service.apply({
    mailDomainId,
    kind: 'current',
    expectedRevision: 2,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.equal(applied.completed, false);
  assert.equal(state.enqueued.length, 1);
  const queued = state.enqueued[0];
  assert.equal(queued.operation, OPERATIONS.DNS_RECORD_APPLY);
  assert.equal(queued.resourceType, 'dns_zone');
  assert.equal(queued.resourceId, zoneId);
  assert.deepEqual(queued.payload.record, preview.record);
  assert.equal(queued.payload.expectedSnapshotDigest, 'a'.repeat(64));
  assert.match(queued.idempotencyKey, /^dkim-dns:/);
  assert.doesNotMatch(JSON.stringify({ preview, applied, queued }), /private-token-value/);
});

test('provider content conflict fails closed instead of overwriting a selector owned elsewhere', async () => {
  const state = fixture({
    existing: [{
      type: 'TXT',
      name: 'mail-new._domainkey.example.com',
      content: 'v=DKIM1; k=rsa; p=someone-else',
      ttl: 300,
      proxied: false,
    }],
  });
  await assert.rejects(
    state.service.preview({ mailDomainId, kind: 'current', expectedRevision: 2 }),
    (error) => error instanceof MailDkimDnsError && error.code === 'mail_dkim_dns_record_conflict',
  );
  assert.equal(state.enqueued.length, 0);
});

test('retirement delete uses exact provider TTL and clears state immediately when record is already absent', async () => {
  const retirement = {
    mailDomainId,
    domainName: 'example.com',
    previousSelector: 'mail-old',
    previousDnsRecord: {
      type: 'TXT',
      name: 'mail-old._domainkey.example.com',
      value: oldTxt,
    },
    targetSelector: 'mail-new',
    previousKeyRevision: 1,
    currentKeyRevision: 2,
    phase: 'dns_retirement_pending',
    revision: 2,
  };
  const withRecord = fixture({
    retirement,
    existing: [{
      type: 'TXT',
      name: 'mail-old._domainkey.example.com',
      content: oldTxt,
      ttl: 3600,
      proxied: false,
    }],
  });
  const preview = await withRecord.service.preview({
    mailDomainId,
    kind: 'retirement',
    expectedRevision: 2,
  });
  assert.equal(preview.effect, 'delete');
  assert.equal(preview.record.ttl, 3600);

  const absent = fixture({ retirement, existing: [] });
  const absentPreview = await absent.service.preview({
    mailDomainId,
    kind: 'retirement',
    expectedRevision: 2,
  });
  assert.equal(absentPreview.effect, 'no_change');
  const applied = await absent.service.apply({
    mailDomainId,
    kind: 'retirement',
    expectedRevision: 2,
    previewDigest: absentPreview.previewDigest,
    confirmation: absentPreview.confirmation,
  });
  assert.equal(applied.completed, true);
  assert.equal(applied.retirementCleared, true);
  assert.equal(absent.enqueued.length, 0);
  assert.equal(absent.retirement(), null);
});

test('active DNS-zone job blocks DKIM provider preview before provider inspection', async () => {
  const state = fixture({ activeJobs: [{ id: 'active', status: 'running' }] });
  await assert.rejects(
    state.service.preview({ mailDomainId, kind: 'current', expectedRevision: 2 }),
    (error) => error instanceof MailDkimDnsError && error.code === 'dns_zone_job_conflict',
  );
  assert.deepEqual(state.calls.map(([name]) => name), ['listJobs']);
});
