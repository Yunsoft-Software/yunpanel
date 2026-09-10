import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSystemUpgradeReceiptStore, SystemUpgradeReceiptError } from '../src/system-upgrade-receipt.js';

const serverId = 'server-1';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-system-upgrade-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o755);
  return { root, store: createSystemUpgradeReceiptStore({ root, now: () => Date.parse('2026-09-10T12:00:00Z') }) };
}

function upgradedResult(extra = {}) {
  return {
    packageName: 'yunpanel',
    installed: true,
    installedVersion: '0.4.0',
    candidateVersion: '0.4.0',
    updateAvailable: false,
    previousVersion: '0.3.0',
    upgraded: true,
    restartScheduled: true,
    ...extra,
  };
}

function noOpResult(extra = {}) {
  return {
    packageName: 'yunpanel',
    installed: true,
    installedVersion: '0.4.0',
    candidateVersion: '0.4.0',
    updateAvailable: false,
    previousVersion: '0.4.0',
    upgraded: false,
    restartScheduled: false,
    ...extra,
  };
}

test('system upgrade receipt persists only bounded version transition metadata with private modes', async (t) => {
  const fx = await fixture(t);
  const receipt = await fx.store.write({ serverId, jobId, result: upgradedResult({ stdout: 'SECRET' }) });
  assert.deepEqual(await fx.store.read(serverId, jobId), receipt);
  assert.equal((await stat(fx.root)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(fx.root, serverId))).mode & 0o777, 0o700);
  assert.equal((await stat(fx.store.receiptPath(serverId, jobId))).mode & 0o777, 0o600);
  const raw = await readFile(fx.store.receiptPath(serverId, jobId), 'utf8');
  assert.doesNotMatch(raw, /SECRET|stdout|command|environment/i);
  assert.match(raw, /"previousVersion":"0.3.0"/);
});

test('no-op system upgrade receipt preserves the exact no-change transition', async (t) => {
  const fx = await fixture(t);
  const receipt = await fx.store.write({ serverId, jobId, result: noOpResult() });
  assert.equal(receipt.previousVersion, receipt.installedVersion);
  assert.equal(receipt.upgraded, false);
  assert.equal(receipt.restartScheduled, false);
});

test('system upgrade receipt rejects inconsistent transition metadata', async (t) => {
  const fx = await fixture(t);
  await assert.rejects(
    fx.store.write({ serverId, jobId, result: upgradedResult({ restartScheduled: false }) }),
    (error) => error instanceof SystemUpgradeReceiptError && error.code === 'system_upgrade_receipt_transition_invalid',
  );
  await assert.rejects(
    fx.store.write({ serverId, jobId, result: noOpResult({ previousVersion: '0.3.0' }) }),
    (error) => error instanceof SystemUpgradeReceiptError && error.code === 'system_upgrade_receipt_transition_invalid',
  );
  await assert.rejects(
    fx.store.write({ serverId, jobId, result: upgradedResult({ updateAvailable: true }) }),
    (error) => error instanceof SystemUpgradeReceiptError && error.code === 'system_upgrade_receipt_state_invalid',
  );
});
