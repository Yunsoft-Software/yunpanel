import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApplicationEnvironmentRegistry } from '../src/application-environment-registry.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yp-env-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ids = [randomUUID(), randomUUID()], filePath = path.join(root, 'environment.json');
  const options = { filePath, masterKey: Buffer.alloc(32, 11), applicationExists: async id => ids.includes(id) };
  return { root, ids, filePath, options, registry: createApplicationEnvironmentRegistry(options) };
}
test('private environment snapshot restores encrypted secrets and plain values for one Application and keeps sibling state', async t => {
  const f = await fixture(t), [id, sibling] = f.ids;
  await f.registry.setVariable({ applicationId: id, key: 'SERVICE_URL', value: 'https://before.example', secret: false });
  await f.registry.setVariable({ applicationId: id, key: 'SERVICE_TOKEN', value: 'private original fixture token', secret: true });
  await f.registry.setVariable({ applicationId: sibling, key: 'SERVICE_TOKEN', value: 'private sibling fixture token', secret: true });
  const saved = await f.registry.exportApplicationBackup(id), siblingBefore = await f.registry.exportApplicationBackup(sibling);
  assert.doesNotMatch(JSON.stringify(saved), /private original fixture token/);
  const before = await f.registry.environmentStatus(id);
  await f.registry.setVariable({ applicationId: id, key: 'SERVICE_TOKEN', value: 'changed private fixture token', secret: true });
  await f.registry.setVariable({ applicationId: id, key: 'NEW_VARIABLE', value: 'remove on restore', secret: false });
  const restored = await f.registry.restoreApplicationBackup(id, saved);
  assert.ok(restored.savedRevision > before.savedRevision);
  assert.equal(restored.appliedRevision, null);
  assert.deepEqual(await f.registry.materialize(id), { SERVICE_URL: 'https://before.example', SERVICE_TOKEN: 'private original fixture token' });
  assert.deepEqual(await f.registry.exportApplicationBackup(sibling), siblingBefore);
  await assert.rejects(f.registry.materialize(id, { expectedRevision: before.savedRevision }), { code: 'environment_revision_conflict' });
  assert.doesNotMatch(await readFile(f.filePath, 'utf8'), /private original fixture token|private sibling fixture token/);
  const reopened = createApplicationEnvironmentRegistry(f.options); await reopened.init();
  assert.deepEqual(await reopened.materialize(id), await f.registry.materialize(id));
});
test('foreign Application and tampered credential envelopes stop before changing committed environment values', async t => {
  const f = await fixture(t), [id, sibling] = f.ids;
  await f.registry.setVariable({ applicationId: id, key: 'SERVICE_TOKEN', value: 'original fixture token', secret: true });
  const saved = await f.registry.exportApplicationBackup(id), before = await readFile(f.filePath, 'utf8');
  await assert.rejects(f.registry.restoreApplicationBackup(sibling, saved), { code: 'environment_backup_invalid' });
  const damaged = structuredClone(saved); damaged.variables[0].tag = Buffer.alloc(16).toString('base64');
  await assert.rejects(f.registry.restoreApplicationBackup(id, damaged), { code: 'environment_backup_invalid' });
  assert.equal(await readFile(f.filePath, 'utf8'), before);
});
test('a failed physical environment write remains absent from readers and a later valid write can commit', async t => {
  const f = await fixture(t), id = f.ids[0], parent = path.join(f.root, 'blocked-parent');
  const registry = createApplicationEnvironmentRegistry({ ...f.options, filePath: path.join(parent, 'environment.json') });
  await registry.init(); await writeFile(parent, 'block directory creation');
  await assert.rejects(registry.setVariable({ applicationId: id, key: 'FAILED_VALUE', value: 'must not look saved', secret: false }));
  assert.deepEqual(await registry.listVariables(id), []);
  assert.equal((await registry.environmentStatus(id)).savedRevision, 0);
  await rm(parent);
  await registry.setVariable({ applicationId: id, key: 'VALID_VALUE', value: 'committed after recovery', secret: false });
  assert.deepEqual(await registry.materialize(id), { VALID_VALUE: 'committed after recovery' });
  assert.match(await readFile(path.join(parent, 'environment.json'), 'utf8'), /committed after recovery/);
});

test('a reader awaiting Application scope sees one committed revision and queued input cannot be edited afterward', async t => {
  const f = await fixture(t), id = f.ids[0];
  let block = false, release;
  const registry = createApplicationEnvironmentRegistry({ ...f.options, applicationExists: async candidate => {
    if (block) { block = false; await new Promise(resolve => { release = resolve; }); }
    return f.ids.includes(candidate);
  } });
  await registry.setVariable({ applicationId: id, key: 'VALUE', value: 'first committed value', secret: false });
  block = true;
  const reading = registry.materialize(id);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const input = { applicationId: id, key: 'VALUE', value: 'captured second value', secret: false };
  const writing = registry.setVariable(input); input.value = 'must not replace captured input';
  release();
  assert.deepEqual(await reading, { VALUE: 'first committed value' });
  await writing;
  assert.deepEqual(await registry.materialize(id), { VALUE: 'captured second value' });
});
