import assert from 'node:assert/strict';
import test from 'node:test';
import { createNginxManager } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';
import { createLocalHostOperations } from '../src/local-host-operations.js';
import { createJobRegistry } from '../src/job-registry.js';
import { reconcileCompletedJob } from '../src/job-reconciliation.js';

const certificate = { certName: 'example.com', certificatePath: '/etc/letsencrypt/live/example.com/cert.pem',
  fullchainPath: '/etc/letsencrypt/live/example.com/fullchain.pem', privateKeyPath: '/etc/letsencrypt/live/example.com/privkey.pem',
  fingerprint256: Array(32).fill('AB').join(':'), validFrom: '2026-10-12T00:00:00.000Z', validTo: '2027-01-10T00:00:00.000Z', dryRun: false };

for (const status of ['renewed', 'unchanged']) test(`${status} certificate reloads native Nginx only after its configuration test passes`, async () => {
  const calls = [], nginx = createNginxManager({ execFn: async (file, args) => { calls.push([file, args]); return ''; } });
  const operations = createLocalHostOperations({ nginxManager: nginx,
    acmeManager: { renewCertificate: async () => { calls.push(['acme']); return { ...certificate, status }; } } });
  const result = await operations.executeOperation(OPERATIONS.SSL_RENEW, { certName: 'example.com', dryRun: false });
  assert.deepEqual(calls, [['acme'], ['/usr/sbin/nginx', ['-t']], ['/usr/bin/systemctl', ['reload', 'nginx']]]);
  assert.deepEqual(result.reloadOutcome, { service: 'nginx', status: 'succeeded', stage: 'reload' });
});

test('ACME dry-run leaves active Nginx workers alone', async () => {
  const operations = createLocalHostOperations({ nginxManager: { reloadConfiguration: () => { throw new Error('must not reload'); } },
    acmeManager: { renewCertificate: async () => ({ certName: 'example.com', dryRun: true, status: 'validated' }) } });
  assert.deepEqual(await operations.executeOperation(OPERATIONS.SSL_RENEW, { certName: 'example.com', dryRun: true }),
    { certName: 'example.com', dryRun: true, status: 'validated' });
});

for (const failedPhase of ['configtest', 'reload']) test(`${failedPhase} failure preserves renewed metadata and reaches a masked durable partial outcome`, async () => {
  const calls = [], nginx = createNginxManager({ execFn: async (file, args) => {
    calls.push(args); if (args[0] === (failedPhase === 'configtest' ? '-t' : 'reload')) throw new Error('PRIVATE_NATIVE_ERROR=/sensitive/path'); return ''; } });
  const operations = createLocalHostOperations({ nginxManager: nginx, acmeManager: { renewCertificate: async () => ({ ...certificate, status: 'renewed' }) } });
  const native = await operations.executeOperation(OPERATIONS.SSL_RENEW, { certName: 'example.com', dryRun: false });
  assert.equal(native.reloadOutcome.status, 'failed'); assert.equal(JSON.stringify(native).includes('PRIVATE_NATIVE_ERROR'), false);
  if (failedPhase === 'configtest') assert.deepEqual(calls, [['-t']]);
  const jobs = createJobRegistry({ serverExists: async () => true });
  const job = await jobs.enqueue({ serverId: 'server-1', type: 'ssl.renew', operation: OPERATIONS.SSL_RENEW,
    resourceType: 'certificate', resourceId: 'certificate-1', payload: { certName: 'example.com', dryRun: false } });
  await jobs.claimNext('server-1'); const completed = await jobs.complete({ serverId: 'server-1', jobId: job.id, status: 'succeeded', result: native });
  assert.deepEqual(completed.result.reloadOutcome, native.reloadOutcome);
  let recorded;
  const outcome = await reconcileCompletedJob({ certificateRegistry: {
    markActive: async () => ({ id: 'certificate-1', staging: false, purpose: 'web' }), commitSelection: async () => {},
    recordReloadOutcome: async (id, result) => { recorded = result; },
  }, job: completed });
  assert.equal(outcome.outcome, 'partial'); assert.deepEqual(recorded, native.reloadOutcome);
});

test('native certificate reloads serialize with the existing Nginx mutation chain', async () => {
  let entered, release;
  const started = new Promise(resolve => entered = resolve), blocker = new Promise(resolve => release = resolve);
  const calls = [];
  const nginx = createNginxManager({ execFn: async (file,args) => { calls.push(args[0]); if (calls.length === 1) { entered(); await blocker; } return ''; } });
  const first = nginx.reloadConfiguration(); await started;
  const second = nginx.reloadConfiguration(); await Promise.resolve(); assert.deepEqual(calls, ['-t']);
  release(); await Promise.all([first,second]); assert.deepEqual(calls, ['-t','reload','-t','reload']);
});
