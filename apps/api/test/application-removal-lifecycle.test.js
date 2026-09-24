import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationRegistry } from '../src/application-registry.js';

test('Application deletion requires exact server/revision and no active deployment', async () => {
  const registry=createApplicationRegistry({serverExists:async()=>true});
  await registry.init();
  const app=await registry.createPhpApplication({serverId:'11111111-1111-4111-8111-111111111111',name:'php'});
  await assert.rejects(()=>registry.deleteApplication({applicationId:app.id,expectedServerId:'22222222-2222-4222-8222-222222222222',expectedDesiredRevision:app.desiredRevision}),e=>e.code==='application_delete_scope_mismatch');
  await assert.rejects(()=>registry.deleteApplication({applicationId:app.id,expectedServerId:app.serverId,expectedDesiredRevision:app.desiredRevision+1}),e=>e.code==='application_revision_conflict');
  const receipt=await registry.deleteApplication({applicationId:app.id,expectedServerId:app.serverId,expectedDesiredRevision:app.desiredRevision});
  assert.equal(receipt.deleted,true); assert.equal(await registry.getApplication(app.id),null);
});
