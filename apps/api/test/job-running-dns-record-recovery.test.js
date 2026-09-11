import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { recoverRunningDnsRecord } from '../src/job-running-dns-record-recovery.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';
const dnsZoneId = '822fa920-166c-4a7a-a26b-476c81d82165';
const payload = {
  provider: 'cloudflare', credentialId: '10714f5d-8646-4f9a-a8e9-b80439ff6305', dnsZoneId,
  zoneName: 'example.test', action: 'upsert',
  record: { type: 'A', name: 'app.example.test', content: '203.0.113.10', ttl: 300, proxied: false },
  expectedSnapshotDigest: 'a'.repeat(64),
};
const result = {
  provider: 'cloudflare', action: 'upsert', zoneName: 'example.test', record: payload.record,
  changed: false, state: 'present',
};

function fixture() {
  const events = [];
  let status = 'running';
  const publicJob = () => ({
    id: jobId, serverId, status, operation: OPERATIONS.DNS_RECORD_APPLY,
    resourceType: 'dns_zone', resourceId: dnsZoneId,
  });
  return {
    events,
    options: {
      serverId,
      jobId,
      jobRegistry: {
        async getJob() { events.push('get'); return publicJob(); },
        async beginReconciliation() { events.push('begin'); return { serverId, jobId, status: 'running', pending: true }; },
        async complete(input) {
          events.push('complete');
          assert.deepEqual(input.result, result);
          status = 'succeeded';
          return { ...publicJob(), result: input.result };
        },
        async acknowledgeReconciliation() { events.push('ack'); return { serverId, jobId, status, acknowledged: true }; },
      },
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      inspect: async () => ({
        jobs: [{ jobId, serverId, status: 'running', operation: OPERATIONS.DNS_RECORD_APPLY, resourceType: 'dns_zone', resourceId: dnsZoneId }],
      }),
      loadJobContext: async () => {
        events.push('context');
        return { ...publicJob(), payload };
      },
      applyDnsRecord: async (input) => { events.push('provider'); assert.deepEqual(input, payload); return result; },
      reconcile: async () => { events.push('reconcile'); return { reconciled: true }; },
    },
  };
}

test('DNS record recovery safely re-establishes the exact provider post-condition', async () => {
  const fx = fixture();
  const recovered = await recoverRunningDnsRecord(fx.options);
  assert.equal(recovered.recoveryMethod, 'idempotent_provider_postcondition');
  assert.deepEqual(fx.events, ['get', 'context', 'provider', 'begin', 'complete', 'reconcile', 'ack']);
});

test('DNS provider uncertainty leaves the running job and journal untouched', async () => {
  const fx = fixture();
  fx.options.applyDnsRecord = async () => { fx.events.push('provider'); throw new Error('private provider response'); };
  await assert.rejects(
    recoverRunningDnsRecord(fx.options),
    (error) => error.code === 'job_dns_record_recovery_evidence_failed' && !error.message.includes('private'),
  );
  assert.deepEqual(fx.events, ['get', 'context', 'provider']);
});

test('DNS recovery rejects private payload identity drift before provider access', async () => {
  const fx = fixture();
  fx.options.loadJobContext = async () => ({
    id: jobId, serverId, status: 'running', operation: OPERATIONS.DNS_RECORD_APPLY,
    resourceType: 'dns_zone', resourceId: dnsZoneId,
    payload: { ...payload, dnsZoneId: '9e0e5f8f-982c-44b0-84c1-643234890224' },
  });
  await assert.rejects(recoverRunningDnsRecord(fx.options), { code: 'job_dns_record_recovery_context_mismatch' });
  assert.deepEqual(fx.events, ['get']);
});
