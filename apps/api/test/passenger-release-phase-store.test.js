import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path'; import test from 'node:test';
import { createPassengerReleasePhaseStore } from '../src/passenger-release-phase-store.js';
import { createWebsiteResourceBackupCodec } from '../src/website-resource-backup-codec.js';
import { OPERATIONS } from '@yunpanel/protocol';
const uuid = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const identity = { serverId: uuid(1), jobId: uuid(2), websiteId: uuid(3), applicationId: uuid(4), operation: OPERATIONS.APP_NODE_PASSENGER_DEPLOY, payloadSha256: 'a'.repeat(64) };
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'yp-passenger-phase-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const codec = createWebsiteResourceBackupCodec({ masterKey: 'ab'.repeat(32) });
  return { root, store: createPassengerReleasePhaseStore({ root, codec }), codec };
}
test('Passenger phase recovery encrypts private environment and binds it to exact Website/job identity', async t => {
  const { store } = await fixture(t), secret = 'private-environment-for-source-test';
  await store.save(identity, { phase: 'preflight' });
  const record = await store.save(identity, { phase: 'captured', protectedState: store.protect(identity, { before: { content: secret }, desired: { revision: 2, values: { API_SECRET: secret } } }) }, { expectedPhase: 'preflight' });
  assert.equal((await readFile(store.file(identity), 'utf8')).includes(secret), false);
  assert.equal(store.unprotect(identity, record).before.content, secret);
  await assert.rejects(store.read({ ...identity, websiteId: uuid(5) }), error => error.code === 'passenger_release_phase_invalid');
  assert.throws(() => store.unprotect({ ...identity, websiteId: uuid(5) }, record));
  await assert.rejects(store.save(identity, { before: { content: secret } }), error => error.code === 'passenger_release_phase_invalid');
  await assert.rejects(store.save(identity, { result: { password: secret } }), error => error.code === 'passenger_release_phase_invalid');
});
test('Passenger phase writers reject stale compare-and-swap without overwriting recovery evidence', async t => {
  const { store, root, codec } = await fixture(t);
  await store.save(identity, { phase: 'preflight' });
  await store.save(identity, { phase: 'captured' }, { expectedPhase: 'preflight' });
  const other = createPassengerReleasePhaseStore({ root, codec });
  const writes = await Promise.allSettled([store.save(identity, { phase: 'preparing' }, { expectedPhase: 'captured' }), other.save(identity, { phase: 'preparing' }, { expectedPhase: 'captured' })]);
  assert.equal(writes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(writes.filter(r => r.status === 'rejected').length, 1);
});
test('Passenger phase storage preserves a pre-existing temporary artifact and refuses a linked receipt', async t => {
  const { store } = await fixture(t); await store.save(identity, { phase: 'preflight' });
  const temporary = `${store.file(identity)}.${process.pid}.tmp`; await writeFile(temporary, 'requires-inspection', { mode: 0o600 });
  await assert.rejects(store.save(identity, { phase: 'captured' }));
  assert.equal(await readFile(temporary, 'utf8'), 'requires-inspection');
  await rm(temporary); const target = store.file(identity); await rm(target); await symlink('/dev/null', target);
  await assert.rejects(store.read(identity), error => error.code === 'passenger_release_phase_invalid');
});

test('Passenger phase transitions cannot skip preparation or overwrite a terminal proof without compare-and-swap',async t=>{
 const {store}=await fixture(t);
 await assert.rejects(store.save(identity,{phase:'reconciled'}));
 await store.save(identity,{phase:'preflight'});
 await assert.rejects(store.save(identity,{phase:'published'},{expectedPhase:'preflight'}));
 await assert.rejects(store.save(identity,{phase:'captured'}));
 assert.equal((await store.read(identity)).phase,'preflight');
});
