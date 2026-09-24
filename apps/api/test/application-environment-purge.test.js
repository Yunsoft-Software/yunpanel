import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationEnvironmentRegistry } from '../src/application-environment-registry.js';

test('Application environment purge removes variables, credentials and metadata without requiring live Application', async () => {
  const applicationId='11111111-1111-4111-8111-111111111111';
  const registry=createApplicationEnvironmentRegistry({masterKey:'a'.repeat(64),applicationExists:async()=>true});
  await registry.init();
  await registry.setVariable({applicationId,key:'FOO',value:'bar',secret:false});
  await registry.setWebhookSecret({applicationId,secret:'secret-1234567890'});
  const before=await registry.inspectApplicationState(applicationId); assert.ok(before.variableCount>=2); assert.equal(before.environmentPresent,true);
  const receipt=await registry.purgeApplication(applicationId); assert.equal(receipt.purged,true);
  assert.deepEqual(await registry.inspectApplicationState(applicationId),{applicationId,variableCount:0,environmentPresent:false});
  assert.equal((await registry.purgeApplication(applicationId)).purged,true);
});
