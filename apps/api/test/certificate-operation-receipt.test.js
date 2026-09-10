import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  CertificateOperationReceiptError,
  createCertificateOperationReceiptStore,
} from '../src/certificate-operation-receipt.js';

const serverId = 'server-1';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';
const certificateId = '2f334b35-03ce-4aa0-a8e4-b2ad4f592541';
const fingerprint = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, '0')).join(':').toUpperCase();

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-certificate-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o755);
  return { root, store: createCertificateOperationReceiptStore({ root, now: () => Date.parse('2026-09-10T14:00:00Z') }) };
}

const productionMetadata = {
  fingerprint256: fingerprint,
  validFrom: '2026-09-10T00:00:00.000Z',
  validTo: '2026-12-09T00:00:00.000Z',
};

for (const scenario of [
  {
    name: 'staging issue',
    operation: OPERATIONS.SSL_ISSUE,
    result: { certName: 'example.com', domains: ['example.com', 'www.example.com'], staging: true, status: 'validated' },
  },
  {
    name: 'production issue',
    operation: OPERATIONS.SSL_ISSUE,
    result: { certName: 'example.com', domains: ['example.com', 'www.example.com'], staging: false, status: 'issued', ...productionMetadata },
  },
  {
    name: 'renew dry-run',
    operation: OPERATIONS.SSL_RENEW,
    result: { certName: 'example.com', dryRun: true, status: 'validated' },
  },
  {
    name: 'production renewal',
    operation: OPERATIONS.SSL_RENEW,
    result: { certName: 'example.com', dryRun: false, status: 'renewed', ...productionMetadata },
  },
]) {
  test(`certificate receipt persists bounded ${scenario.name} evidence privately`, async (t) => {
    const fx = await fixture(t);
    const receipt = await fx.store.write({ serverId, jobId, certificateId, operation: scenario.operation, result: scenario.result });
    assert.deepEqual(await fx.store.read(serverId, jobId), receipt);
    assert.equal((await stat(fx.root)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(fx.root, serverId))).mode & 0o777, 0o700);
    assert.equal((await stat(fx.store.receiptPath(serverId, jobId))).mode & 0o777, 0o600);
    const raw = await readFile(fx.store.receiptPath(serverId, jobId), 'utf8');
    assert.doesNotMatch(raw, /email|privateKeyPath|fullchainPath|certificatePath|pem|certbot|stdout/i);
  });
}

test('certificate receipt rejects unsupported or inconsistent variants', async (t) => {
  const fx = await fixture(t);
  await assert.rejects(
    fx.store.write({
      serverId,
      jobId,
      certificateId,
      operation: OPERATIONS.SSL_ISSUE,
      result: { certName: 'example.com', domains: ['example.com'], staging: false, status: 'issued' },
    }),
    (error) => error instanceof CertificateOperationReceiptError && error.code === 'certificate_receipt_metadata_invalid',
  );
  await assert.rejects(
    fx.store.write({
      serverId,
      jobId,
      certificateId,
      operation: OPERATIONS.SSL_RENEW,
      result: { certName: 'example.com', dryRun: true, status: 'renewed' },
    }),
    (error) => error instanceof CertificateOperationReceiptError && error.code === 'certificate_receipt_variant_invalid',
  );
});
