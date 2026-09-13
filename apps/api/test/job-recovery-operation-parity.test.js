import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const apiSource = (name) => new URL(`../src/${name}`, import.meta.url);
const jobRegistryUrl = apiSource('job-registry.js');
const cliUrl = new URL('../../../scripts/job-recovery.mjs', import.meta.url);
const recoverySources = [
  'job-running-recovery.js',
  'job-running-domain-recovery.js',
  'job-running-domain-activation-recovery.js',
  'job-running-static-recovery.js',
  'job-running-static-rollback-recovery.js',
  'job-running-node-deployment-recovery.js',
  'job-running-node-restart-recovery.js',
  'job-running-node-process-recovery.js',
  'job-running-node-runtime-recovery.js',
  'job-running-node-rollback-recovery.js',
  'job-running-database-recovery.js',
  'job-running-database-delete-recovery.js',
  'job-running-database-credential-recovery.js',
  'job-running-dns-record-recovery.js',
  'job-running-service-recovery.js',
  'job-running-service-receipt-recovery.js',
  'job-running-system-upgrade-recovery.js',
  'job-running-certificate-recovery.js',
  'job-running-mail-config-recovery.js',
  'job-running-mail-dkim-recovery.js',
  'job-running-mail-data-recovery.js',
  'job-running-roundcube-config-recovery.js',
].map(apiSource);

function operationNames(source, pattern = /OPERATIONS\.([A-Z0-9_]+)/g) {
  return new Set([...source.matchAll(pattern)].map((entry) => entry[1]));
}

function queuedOperationNames(source) {
  const match = source.match(/const ASYNC_OPERATIONS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(match, 'Expected durable async queue operation collection was not found');
  return operationNames(match[1]);
}

test('every durable async queue operation is referenced by an explicit recovery implementation', async () => {
  const [jobSource, ...recoveryContents] = await Promise.all([
    readFile(jobRegistryUrl, 'utf8'),
    ...recoverySources.map((url) => readFile(url, 'utf8')),
  ]);
  const queued = queuedOperationNames(jobSource);
  const recovered = new Set();
  for (const source of recoveryContents) {
    for (const operation of operationNames(source)) {
      if (queued.has(operation)) recovered.add(operation);
    }
  }
  assert.deepEqual([...recovered].sort(), [...queued].sort());
});

test('packaged recovery CLI exposes only explicit operation families and no force/retry escape hatch', async () => {
  const source = await readFile(cliUrl, 'utf8');
  for (const action of [
    'recover-readonly',
    'recover-domain-stage',
    'recover-domain-activate',
    'recover-static-deploy',
    'recover-static-rollback',
    'recover-node-deploy',
    'recover-node-restart',
    'recover-node-process',
    'recover-node-runtime-install',
    'recover-node-rollback',
    'recover-system-upgrade',
    'recover-certificate',
    'recover-database-create',
    'recover-database-delete',
    'recover-database-credential',
    'recover-dns-record',
    'recover-service-control',
    'recover-service-mutation',
    'recover-mail-config',
    'recover-mail-dkim',
    'recover-mail-data',
    'recover-roundcube-config',
  ]) {
    assert.match(source, new RegExp(`['\"]${action}['\"]`));
  }
  assert.doesNotMatch(source, /force-success|force-failed|retry-mutation|clear-journal/);
});