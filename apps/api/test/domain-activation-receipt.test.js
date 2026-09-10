import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDomainActivationReceiptStore } from '../src/domain-activation-receipt.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';
const checksum = 'a'.repeat(64);

test('domain activation receipt persists only exact identity and checksum with private modes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-domain-activation-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o755);
  const store = createDomainActivationReceiptStore({ root });

  const receipt = await store.write({
    serverId,
    jobId,
    primaryDomain: 'Example.COM',
    checksum,
    result: { raw: 'must-not-persist' },
  });
  assert.equal(receipt.primaryDomain, 'example.com');
  assert.deepEqual(await store.read(serverId, jobId), receipt);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(root, serverId))).mode & 0o777, 0o700);
  assert.equal((await stat(store.receiptPath(serverId, jobId))).mode & 0o777, 0o600);
  const raw = await readFile(store.receiptPath(serverId, jobId), 'utf8');
  assert.doesNotMatch(raw, /must-not-persist|result|raw/i);
});

test('domain activation receipt rejects unsafe hostname or checksum before persistence', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-domain-activation-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createDomainActivationReceiptStore({ root });

  await assert.rejects(
    store.write({ serverId, jobId, primaryDomain: '../etc/passwd', checksum }),
    { code: 'domain_activation_receipt_domain_invalid' },
  );
  await assert.rejects(
    store.write({ serverId, jobId, primaryDomain: 'example.com', checksum: 'bad' }),
    { code: 'domain_activation_receipt_checksum_invalid' },
  );
});
