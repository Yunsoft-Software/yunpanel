import assert from 'node:assert/strict';
import test from 'node:test';
import { resourceImpactInternals } from '../src/resource-impact.js';

test('Application impact reference pins desired revision for destructive previews', () => {
  const value=resourceImpactInternals.applicationReference({
    id:'11111111-1111-4111-8111-111111111111',
    serverId:'22222222-2222-4222-8222-222222222222',
    name:'app',type:'php',state:'active',desiredRevision:7,currentReleaseId:null,activeDeploymentId:null,
  });
  assert.equal(value.desiredRevision,7);
});
