import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteRemovalRuntime } from '../src/websites/website-removal-runtime.js';
import { removalFixture, removalPreview } from '../test-support/website-removal-fixture.js';
import { mkdtemp, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createLiveSessionRegistry } from '../src/auth/live-session-registry.js';
import { createWebsiteRemovalOperationRegistry } from '../src/websites/website-removal-operation-registry.js';
import { createDomainRegistry } from '../src/domains/domain-registry.js';

test('removal preview blocks legacy direct-systemd binding without matching Application runtime authority', async()=>{
 const preview=removalPreview('site-a',{runtimeBindings:[{id:'binding-a'}]});
 const f=await removalFixture({runtimeBindingRegistry:{
  getBinding:async()=>({adapter:'direct-systemd',revision:2,sourceOperationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}),
  removeOwnedPassenger:async()=>{},removeOwnedStatic:async()=>{},removeOwnedDirectSystemd:async()=>{},
 }},preview);
 const value=await f.runtime.preview({websiteId:'site-a'});
 assert.equal(value.readyToStart,false);
 assert.ok(value.hardBlockers.includes('runtime_cleanup_authority_conflict'));
});
test('static runtime cleanup uses static ownership API, never Passenger API', async()=>{
 let staticCalls=0,passengerCalls=0;
 const preview=removalPreview('site-a',{runtimeBindings:[{id:'binding-a'}]},{systemUser:null});
 let binding={adapter:'static',revision:3,sourceOperationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
 const f=await removalFixture({runtimeBindingRegistry:{
  getBinding:async()=>binding,
  removeOwnedPassenger:async()=>{passengerCalls++;},
  removeOwnedStatic:async(_id,options)=>{staticCalls++;assert.equal(options.sourceOperationId,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');binding=null;},
 }},preview);
 let op=await f.runtime.start({websiteId:preview.website.id,previewDigest:preview.previewDigest,confirmation:preview.confirmation});
 while(op.status==='running'){
  const step=op.steps.find((x)=>x.status!=='succeeded'); if(!step)break;
  op=await f.runtime.continueStep({websiteId:op.websiteId,operationId:op.id,stepId:step.id,expectedUpdatedAt:op.updatedAt,confirmation:op.actions.stepContinuationConfirmation});
 }
 assert.equal(staticCalls,1);assert.equal(passengerCalls,0);
});

async function actualJournal(directory, { pending = false } = {}) {
  const filePath = path.join(directory, 'removals.json');
  const registry = createWebsiteRemovalOperationRegistry({ filePath });
  await registry.init();
  const domainRegistry = createDomainRegistry({ filePath: path.join(directory, 'domains.json') });
  await domainRegistry.init();
  const liveSessions = createLiveSessionRegistry();
  let lease;
  if (pending) lease = liveSessions.beginWebsiteOpen({ websiteId: 'site-a', backend: 'node-pty',
    snapshot: () => ({ version: 1, started: false }), stop: () => {},
    drain: async () => {
      // A real OS persistence fault after markStepRunning, before checkpointStep.
      await rename(filePath, filePath + '.before-disk-fault');
      await mkdir(filePath);
      return lease.settleWithoutProcess();
    } });
  const reservation = liveSessions.reserveWebsiteRemoval('site-a');
  const snapshot = await reservation.snapshot();
  const operation = await registry.create({ operation: 'website_remove', readyToStart: true,
    website: { id: 'site-a', serverId: 'server-a', applicationId: null, systemUser: null },
    previewDigest: 'a'.repeat(64), confirmation: 'policy-only',
    plan: { domainIds: [], additional: {}, terminalLifecycle: snapshot } });
  liveSessions.commitWebsiteRemoval('site-a', operation.id, snapshot);
  return { registry, domainRegistry, liveSessions, filePath, operation };
}

test('T898 actual journal checkpoints terminal closure before a real filesystem cleanup failure', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-t898-order-'));
  try {
    const f = await actualJournal(directory);
    const sentinel = path.join(directory, 'retained');
    await writeFile(sentinel, 'unchanged');
    let calls = 0;
    const runtime = createWebsiteRemovalRuntime({ ...f,
      previewProvider: async () => { throw new Error('No new preview or operation is allowed'); },
      domainRemovalRuntime: { start: async () => { throw new Error('No Domain mutation is allowed'); } },
      fileCleanupHandler: async () => {
        calls++;
        const disk = createWebsiteRemovalOperationRegistry({ filePath: f.filePath });
        await disk.init();
        const checkpoint = (await disk.get(f.operation.id)).steps.find(value => value.kind === 'file_cleanup');
        assert.equal(checkpoint.status, 'running');
        assert.equal(checkpoint.result.terminalDrain.verified, true);
        assert.equal(checkpoint.result.terminalDrain.operationId, f.operation.id);
        // Real EISDIR, without deleting the owned sentinel or claiming a host PASS.
        await readFile(directory);
      } });
    const current = await runtime.get(f.operation.id);
    const result = await runtime.continueStep({ websiteId: current.websiteId, operationId: current.id,
      stepId: current.steps[0].id, expectedUpdatedAt: current.updatedAt, confirmation: current.actions.stepContinuationConfirmation });
    assert.equal(result.status, 'failed');
    assert.equal(calls, 1);
    assert.equal(await readFile(sentinel, 'utf8'), 'unchanged');
    assert.equal((await f.registry.get(current.id)).steps[0].result.terminalDrain.verified, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('T898 actual EISDIR checkpoint failure prevents any file cleanup and preserves the same journal', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-t898-disk-'));
  try {
    const f = await actualJournal(directory, { pending: true });
    let calls = 0;
    const runtime = createWebsiteRemovalRuntime({ ...f,
      previewProvider: async () => { throw new Error('No new preview or operation is allowed'); },
      domainRemovalRuntime: { start: async () => { throw new Error('No Domain mutation is allowed'); } },
      fileCleanupHandler: async () => { calls++; throw new Error('Destructive cleanup must not be entered'); } });
    const current = await runtime.get(f.operation.id);
    await assert.rejects(runtime.continueStep({ websiteId: current.websiteId, operationId: current.id,
      stepId: current.steps[0].id, expectedUpdatedAt: current.updatedAt, confirmation: current.actions.stepContinuationConfirmation }), { code: 'EISDIR' });
    assert.equal(calls, 0);
    const prior = JSON.parse(await readFile(f.filePath + '.before-disk-fault', 'utf8'));
    assert.equal(prior.length, 1);
    assert.equal(prior[0].id, current.id);
    assert.equal(prior[0].steps[0].result, null);
    assert.throws(() => f.liveSessions.assertWebsiteOpen(current.websiteId), { code: 'terminal_website_removing' });
    // Repair only the test's owned disk fault, then restart from the actual old
    // journal. No new operation or forced step state is introduced.
    await rmdir(f.filePath);
    await rename(f.filePath + '.before-disk-fault', f.filePath);
    const restartedLifecycle = createLiveSessionRegistry();
    const restarted = createWebsiteRemovalRuntime({ registry: f.registry, domainRegistry: f.domainRegistry,
      liveSessions: restartedLifecycle,
      previewProvider: async () => { throw new Error('No new operation'); },
      domainRemovalRuntime: { start: async () => { throw new Error('No Domain mutation'); } },
      fileCleanupHandler: async () => { calls++; await readFile(directory); } });
    await restarted.init();
    const recovered = await restarted.get(current.id);
    const continued = await restarted.continueStep({ websiteId: recovered.websiteId, operationId: recovered.id,
      stepId: recovered.steps[0].id, expectedUpdatedAt: recovered.updatedAt, confirmation: recovered.actions.stepContinuationConfirmation });
    assert.equal(continued.id, current.id);
    assert.equal(continued.steps[0].result.terminalDrain.verified, true);
    assert.equal(calls, 1);
    assert.equal((await f.registry.listForWebsite(current.websiteId)).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('T898 actual unfinished legacy journal restores a fence but cannot attest absence from empty memory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-t898-legacy-'));
  try {
    const registry = createWebsiteRemovalOperationRegistry({ filePath: path.join(directory, 'removals.json') });
    await registry.init();
    const operation = await registry.create({ operation: 'website_remove', readyToStart: true,
      website: { id: 'site-a', serverId: 'server-a', applicationId: null, systemUser: null },
      previewDigest: 'a'.repeat(64), confirmation: 'policy-only', plan: { domainIds: [], additional: {} } });
    const domainRegistry = createDomainRegistry({ filePath: path.join(directory, 'domains.json') }); await domainRegistry.init();
    const liveSessions = createLiveSessionRegistry(); let calls = 0;
    const runtime = createWebsiteRemovalRuntime({ registry, domainRegistry, liveSessions,
      previewProvider: async () => { throw new Error('No new operation'); },
      domainRemovalRuntime: { start: async () => { throw new Error('No Domain mutation'); } },
      fileCleanupHandler: async () => { calls++; throw new Error('Destructive cleanup must not run'); } });
    await runtime.init();
    const current = await runtime.get(operation.id);
    const result = await runtime.continueStep({ websiteId: current.websiteId, operationId: current.id,
      stepId: current.steps[0].id, expectedUpdatedAt: current.updatedAt, confirmation: current.actions.stepContinuationConfirmation });
    assert.equal(result.status, 'blocked'); assert.equal(result.error.code, 'terminal_drain_evidence_unavailable');
    assert.equal(calls, 0); assert.equal((await registry.listForWebsite(current.websiteId)).length, 1);
    assert.throws(() => liveSessions.assertWebsiteOpen(current.websiteId), { code: 'terminal_website_removing' });
    assert.doesNotThrow(() => liveSessions.assertWebsiteOpen('site-b'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
