import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNginxManager, NginxManagerError } from '../src/nginx-manager.js';

// T970: a removed Domain must not leave its staged Nginx config, activation
// rollback receipts or deactivation receipts behind. Real files on a private
// temporary disk; nginx -t and systemctl reload are controlled host boundaries.
function specFor(primaryDomain, upstreamPort = 3000) {
  return Object.freeze({
    primaryDomain,
    aliases: [`www.${primaryDomain}`],
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort, websocket: true },
  });
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-nginx-retire-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stagingDir = path.join(root, 'staging');
  const sitesDir = path.join(root, 'sites');
  await mkdir(sitesDir, { recursive: true });
  const manager = createNginxManager({ stagingDir, sitesDir, execFn: async () => '' });
  return { root, stagingDir, sitesDir, manager };
}

async function activate(manager, spec, activationId = null) {
  const staged = await manager.stageDomain(spec);
  await manager.activateDomain({
    primaryDomain: spec.primaryDomain,
    checksum: staged.checksum,
    ...(activationId ? { activationId } : {}),
  });
  return staged;
}

async function list(dir) {
  try { return (await readdir(dir)).sort(); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

test('removed Domain retirement deletes only its own staged config and receipts', async (t) => {
  const state = await fixture(t);
  const owned = specFor('owned.example.test');
  const other = specFor('other.example.test', 3001);
  // Two activations of the owned Domain leave two rollback receipts, then a
  // removal deactivation leaves one deactivation receipt.
  const first = await activate(state.manager, owned);
  const second = await activate(state.manager, specFor('owned.example.test', 3002),
    'b1f0c3a2-6f0e-4c2a-9d1e-2a4b6c8d0e1f');
  await state.manager.deactivateDomain({ primaryDomain: owned.primaryDomain, checksum: second.checksum });
  assert.notEqual(first.checksum, second.checksum);
  // A foreign, still active Domain keeps every artifact.
  await activate(state.manager, other);
  // A Domain whose name starts with the owned config name is not ours.
  const prefixed = specFor('owned.example.test.conf.example.test', 3003);
  await activate(state.manager, prefixed);
  await state.manager.deactivateDomain({
    primaryDomain: prefixed.primaryDomain,
    checksum: (await state.manager.inspectStagedDomain(prefixed)).result.checksum,
  });

  const beforeRollback = await list(path.join(state.stagingDir, 'rollback'));
  const beforeDeactivation = await list(path.join(state.stagingDir, 'deactivation'));
  // Two owned receipts plus one of the prefixed foreign Domain share the prefix.
  assert.equal(beforeRollback.filter((name) => name.startsWith('yunpanel-owned.example.test.conf.')).length, 3);
  assert.equal(beforeDeactivation.length, 2);

  const result = await state.manager.retireRemovedDomainArtifacts({ primaryDomain: owned.primaryDomain });
  assert.equal(result.retired, true);
  assert.equal(result.configName, 'yunpanel-owned.example.test.conf');
  assert.equal(result.removed.staged, true);
  assert.equal(result.removed.rollbackReceipts, 2);
  assert.equal(result.removed.deactivationReceipts, 1);

  assert.deepEqual(await list(state.stagingDir), [
    'deactivation',
    'rollback',
    'yunpanel-other.example.test.conf',
    'yunpanel-owned.example.test.conf.example.test.conf',
  ]);
  const afterRollback = await list(path.join(state.stagingDir, 'rollback'));
  assert.equal(afterRollback.length, 2);
  assert.ok(afterRollback.every((name) => name.startsWith('yunpanel-other.example.test.conf.')
    || name.startsWith('yunpanel-owned.example.test.conf.example.test.conf.')));
  const afterDeactivation = await list(path.join(state.stagingDir, 'deactivation'));
  assert.deepEqual(afterDeactivation, beforeDeactivation.filter((name) => name.startsWith('yunpanel-owned.example.test.conf.example.test.conf.')));
  assert.deepEqual(await list(state.sitesDir), ['yunpanel-other.example.test.conf']);

  // Repeating the retirement is idempotent and removes nothing else.
  const repeated = await state.manager.retireRemovedDomainArtifacts({ primaryDomain: owned.primaryDomain });
  assert.equal(repeated.retired, true);
  assert.deepEqual(repeated.removed, { staged: false, rollbackReceipts: 0, deactivationReceipts: 0 });
  assert.equal((await list(path.join(state.stagingDir, 'rollback'))).length, 2);
});

test('retirement refuses an active config and leaves every artifact in place', async (t) => {
  const state = await fixture(t);
  const owned = specFor('active.example.test');
  await activate(state.manager, owned);
  const stagedBefore = await list(state.stagingDir);
  const rollbackBefore = await list(path.join(state.stagingDir, 'rollback'));

  const result = await state.manager.retireRemovedDomainArtifacts({ primaryDomain: owned.primaryDomain });
  assert.equal(result.retired, false);
  assert.equal(result.reason, 'nginx_artifacts_active');
  assert.deepEqual(await list(state.stagingDir), stagedBefore);
  assert.deepEqual(await list(path.join(state.stagingDir, 'rollback')), rollbackBefore);
  assert.deepEqual(await list(state.sitesDir), ['yunpanel-active.example.test.conf']);
});

test('retirement keeps receipts it cannot prove are owned and never follows symlinks', async (t) => {
  const state = await fixture(t);
  const owned = specFor('proof.example.test');
  const staged = await activate(state.manager, owned);
  await state.manager.deactivateDomain({ primaryDomain: owned.primaryDomain, checksum: staged.checksum });
  const rollbackDir = path.join(state.stagingDir, 'rollback');
  const forged = `yunpanel-proof.example.test.conf.${'0'.repeat(64)}.json`;
  await writeFile(path.join(rollbackDir, forged), JSON.stringify({ primaryDomain: 'someone-else.example.test' }));
  const corrupt = `yunpanel-proof.example.test.conf.${'1'.repeat(64)}.json`;
  await writeFile(path.join(rollbackDir, corrupt), 'not json');
  const outside = path.join(state.root, 'outside.json');
  await writeFile(outside, JSON.stringify({ primaryDomain: owned.primaryDomain, configName: 'yunpanel-proof.example.test.conf' }));
  const linked = `yunpanel-proof.example.test.conf.${'2'.repeat(64)}.json`;
  await symlink(outside, path.join(rollbackDir, linked));

  const result = await state.manager.retireRemovedDomainArtifacts({ primaryDomain: owned.primaryDomain });
  assert.equal(result.retired, true);
  assert.equal(result.removed.staged, true);
  assert.equal(result.removed.rollbackReceipts, 1);
  assert.equal(result.removed.deactivationReceipts, 1);
  assert.equal(result.kept, 3);
  assert.deepEqual(await list(rollbackDir), [forged, corrupt, linked].sort());
  assert.ok(await readFile(outside, 'utf8'));
});

test('retirement rejects an invalid Domain name before touching the disk', async (t) => {
  const state = await fixture(t);
  await assert.rejects(
    state.manager.retireRemovedDomainArtifacts({ primaryDomain: '../etc' }),
    (error) => error instanceof NginxManagerError || error instanceof Error,
  );
});
