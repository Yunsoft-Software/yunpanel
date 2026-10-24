import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebsiteRemovalDatabaseCleanup } from '../src/website-removal-database-cleanup.js';
const serverId = '11111111-1111-4111-8111-111111111111', websiteId = '22222222-2222-4222-8222-222222222222';
const applicationId = '33333333-3333-4333-8333-333333333333', bindingId = '44444444-4444-4444-8444-444444444444';
const operationId = '55555555-5555-4555-8555-555555555555', credentialId = '66666666-6666-4666-8666-666666666666';
function fixture({ sqlFails = false, checkpointFails = false, foreign = false } = {}) {
  const binding = { id: bindingId, websiteId, applicationId, serverId, unixUser: 'yunapp-123456abcdef', databaseName: 'owned_schema', revision: 1 };
  const credential = { id: credentialId, databaseBindingId: bindingId, websiteId, applicationId, serverId,
    siteUnixUser: binding.unixUser, databaseName: binding.databaseName, username: 'owned_user', host: 'localhost', privileges: ['ALL'], revision: 1, passwordUpdatedAt: '2026-10-11T00:00:00.000Z' };
  let liveBinding = { ...binding, ...(foreign ? { websiteId: applicationId } : {}) }, liveCredential = credential, schema = true, account = true, failCheckpoint = checkpointFails;
  const actions = [];
  const operation = { id: operationId, websiteId, applicationId, serverId, systemUser: binding.unixUser,
    plan: { additional: { databases: { ids: [bindingId] } } }, steps: [{ id: 'database-step', result: null }] };
  const registry = { checkpointStep: async (_id, _stepId, result) => {
    if (failCheckpoint && result.databaseCleanup.entries[0]?.physicalVerified) { failCheckpoint = false; throw new Error('disk unavailable'); }
    operation.steps[0].result = structuredClone(result); actions.push('checkpoint');
  } };
  const dependencies = { registry, websiteRegistry: { getWebsite: async () => ({ id: websiteId, applicationId, serverId, unixUser: binding.unixUser }) },
    databaseBindingRegistry: { listBindings: async () => liveBinding ? [liveBinding] : [], getBinding: async () => liveBinding,
      unbindDatabase: async () => { actions.push('unbind'); liveBinding = null; } },
    databaseCredentialRegistry: { getForBinding: async () => liveCredential, deleteCredential: async () => { actions.push('credential-metadata'); liveCredential = null; } },
    databaseCredentialOperation: { execute: async (_operation, payload) => { actions.push('sql-user'); account = false; return { ...payload, deleted: true }; } },
    evidenceInspector: { inspectDeleted: async evidence => ({ ...evidence, deleted: !account }) },
    databaseManager: { inspect: async () => ({ databases: schema ? [{ name: binding.databaseName }] : [] }), dropDatabase: async () => {
      actions.push('sql-schema'); if (sqlFails) throw new Error('SQL failure'); schema = false;
    } },
  };
  const service = createWebsiteRemovalDatabaseCleanup(dependencies);
  return { service, operation, actions, run: () => service.run({ operation: structuredClone(operation), stepId: 'database-step' }),
    reappear: () => { schema = true; }, reappearAccount: () => { account = true; }, get binding() { return liveBinding; }, get credential() { return liveCredential; } };
}
test('native user and schema absence are checkpointed before metadata is removed', async () => {
  const f = fixture(), result = await f.run();
  assert.deepEqual(f.actions, ['checkpoint', 'sql-user', 'sql-schema', 'checkpoint', 'credential-metadata', 'unbind', 'checkpoint']);
  assert.equal(result.databaseBindingsCleaned, true); assert.equal(result.unboundBindings[0].physicalVerified, true);
  assert.equal(f.binding, null); assert.equal(f.credential, null);
});
test('native SQL failure preserves credential and binding records', async () => {
  const f = fixture({ sqlFails: true }); await assert.rejects(f.run());
  assert.ok(f.binding); assert.ok(f.credential);
  assert.equal(f.actions.includes('unbind'), false); assert.equal(f.actions.includes('credential-metadata'), false);
});
test('lost physical checkpoint retries the same native operation without a second schema drop', async () => {
  const f = fixture({ checkpointFails: true }); await assert.rejects(f.run());
  assert.ok(f.binding); assert.ok(f.credential);
  const result = await f.run(); assert.equal(result.databaseBindingsCleaned, true);
  assert.equal(f.actions.filter(action => action === 'sql-schema').length, 1);
});
test('a finalized cleanup can be inspected again without repeating physical deletion', async () => {
  const f = fixture(); await f.run(); const actions = f.actions.filter(action => action.startsWith('sql-'));
  await f.run(); assert.deepEqual(f.actions.filter(action => action.startsWith('sql-')), actions);
});
test('reappeared schema is blocked after physical verification instead of deleted again', async () => {
  const f = fixture(); await f.run(); f.reappear();
  await assert.rejects(f.run(), { code: 'website_removal_database_unverified' });
  assert.equal(f.actions.filter(action => action === 'sql-schema').length, 1);
});
test('foreign binding is rejected before any physical or registry mutation', async () => {
  const f = fixture({ foreign: true }); await assert.rejects(f.run(), { code: 'website_removal_database_unverified' }); assert.deepEqual(f.actions, []);
});

test('reappeared SQL account blocks journal replay without deleting a new account', async () => {
  const f = fixture(); await f.run(); f.reappearAccount();
  await assert.rejects(f.run(), { code: 'website_removal_database_unverified' });
  assert.equal(f.actions.filter(action => action === 'sql-user').length, 1);
});
