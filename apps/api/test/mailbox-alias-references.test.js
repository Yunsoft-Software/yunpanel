import assert from 'node:assert/strict';
import test from 'node:test';
import { mailboxAliasReferences } from '../src/mailbox-alias-references.js';

const mailbox = { id: 'mailbox-a', mailDomainId: 'mail-domain-a', address: 'user@example.test' };
const local = { id: 'local-alias', destinations: [mailbox.address] };
const foreign = { id: 'private-other-domain-alias', destinations: [mailbox.address] };

test('inbound foreign alias blocks deletion without revealing its identity', async () => {
  const calls = [];
  const refs = await mailboxAliasReferences({ listAliases: async (filter) => {
    calls.push(filter); return filter ? [local] : [local, foreign];
  } }, mailbox);
  assert.deepEqual(calls, [{ mailDomainId: mailbox.mailDomainId }, undefined]);
  assert.equal(refs.length, 2); assert.equal(refs[0].id, local.id); assert.equal(refs[1].id, null);
  assert.equal(JSON.stringify(refs).includes(foreign.id), false);
});

test('local and global duplicates count once and irrelevant destinations do not block', async () => {
  const refs = await mailboxAliasReferences({ listAliases: async () => [local, local, { id: 'unrelated', destinations: ['another@example.test'] }] }, mailbox);
  assert.deepEqual(refs, [{ id: 'local-alias' }]);
});

test('a reference observed during either side of a concurrent read is conservatively retained', async () => {
  const refs = await mailboxAliasReferences({ listAliases: async (filter) => filter ? [local] : [] }, mailbox);
  assert.equal(refs.length, 1);
});

for (const invalid of [null, {}, [{ id: 'x' }], [{ id: '', destinations: [mailbox.address] }], [{ id: 'x', destinations: [null] }]]) {
  test(`invalid global alias data fails closed: ${JSON.stringify(invalid)}`, async () => {
    await assert.rejects(mailboxAliasReferences({ listAliases: async (filter) => filter ? [] : invalid }, mailbox));
  });
}

test('global registry read failure cannot be treated as no foreign references', async () => {
  await assert.rejects(mailboxAliasReferences({ listAliases: async (filter) => {
    if (!filter) throw new Error('database temporarily unavailable'); return [];
  } }, mailbox));
});

import { createMailDeleteImpactService } from '../src/mail-delete-impact.js';
function impactService(listAliases) {
  return createMailDeleteImpactService({
    localServerId: 'server-a',
    mailDomainRegistry: { getMailDomain: async () => ({ id: mailbox.mailDomainId, webDomainId: 'domain-a', domainName: 'example.test', status: 'disabled', managementMode: 'local' }) },
    domainRegistry: { getDomain: async () => ({ id: 'domain-a', serverId: 'server-a', primaryDomain: 'example.test' }) },
    mailboxRegistry: { getMailbox: async () => ({ ...mailbox, revision: 1, enabled: false }), listMailboxes: async () => [] },
    mailAliasRegistry: { listAliases }, mailboxQuotaRegistry: { getQuota: async () => null },
    mailboxForwardingRegistry: { getForwarding: async () => null }, mailDkimRegistry: { getKey: async () => null },
    jobRegistry: { listJobs: async () => [] },
    mailDataInspector: { inspectMailbox: async () => ({ present: false, bytes: 0, snapshotSha256: 'a'.repeat(64) }), inspectDomain: async () => ({ present: false }) },
  });
}

test('real impact service now reports a foreign inbound alias as a redacted blocker', async () => {
  const impact = await impactService(async (filter) => filter ? [] : [foreign]).inspectMailbox(mailbox.id);
  assert.equal(impact.safeToDelete, false);
  assert.deepEqual(impact.blockers, [{ code: 'mailbox_alias_reference_configured', count: 1 }]);
  assert.deepEqual(impact.dependencies.aliasReferences, { count: 1, ids: [], truncated: true });
  assert.equal(JSON.stringify(impact).includes(foreign.id), false);
});

test('real impact service preserves the existing 50-identity local bound', async () => {
  const aliases = Array.from({ length: 73 }, (_, i) => ({ id: `local-${i}`, destinations: [mailbox.address] }));
  const impact = await impactService(async () => aliases).inspectMailbox(mailbox.id);
  assert.equal(impact.dependencies.aliasReferences.count, 73);
  assert.equal(impact.dependencies.aliasReferences.ids.length, 50);
});

test('real impact service wraps unknown global inventory as unavailable, never safe to delete', async () => {
  await assert.rejects(impactService(async (filter) => filter ? [] : null).inspectMailbox(mailbox.id), { code: 'mail_delete_impact_unavailable', status: 503 });
});
