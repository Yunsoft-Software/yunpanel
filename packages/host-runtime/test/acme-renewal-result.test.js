import test from 'node:test';
import assert from 'node:assert/strict';
import { createAcmeManager } from '../src/acme-manager.js';

const before = { certName: 'example.com', fingerprint256: 'AA', validFrom: '2026-10-01T00:00:00Z', validTo: '2026-12-30T00:00:00Z' };
function fixture(after) {
  const calls = []; let reads = 0;
  return { calls, manager: createAcmeManager({ certbotPaths: ['/usr/bin/certbot'], accessFn: async () => {},
    inspectCertificateFn: async () => reads++ === 0 ? before : after,
    run: async (_file, args) => { calls.push(args); return { stdout: '' }; } }) };
}
test('automatic renewal returns unchanged without forcing certificate replacement', async () => {
  const { manager, calls } = fixture({ ...before });
  assert.equal((await manager.renewCertificate({ certName: 'example.com' })).status, 'unchanged');
  assert.equal(calls[0].includes('--force-renewal'), false);
});
test('explicit manual renewal forces Certbot and verifies newer material', async () => {
  const { manager, calls } = fixture({ ...before, fingerprint256: 'BB', validFrom: '2026-10-10T00:00:00Z', validTo: '2027-01-08T00:00:00Z' });
  assert.equal((await manager.renewCertificate({ certName: 'example.com', forceRenewal: true })).status, 'renewed');
  assert.equal(calls[0].includes('--force-renewal'), true);
});
test('dry run cannot force production renewal or report replacement', async () => {
  const { manager, calls } = fixture(null);
  assert.equal((await manager.renewCertificate({ certName: 'example.com', dryRun: true, forceRenewal: true })).status, 'validated');
  assert.equal(calls[0].includes('--force-renewal'), false);
});
test('contradictory fingerprint and dates fail renewal verification', async () => {
  const { manager } = fixture({ ...before, validTo: '2027-01-08T00:00:00Z' });
  await assert.rejects(manager.renewCertificate({ certName: 'example.com' }), { code: 'ssl_renewal_unverified' });
});
