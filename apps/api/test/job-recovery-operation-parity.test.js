import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { jobRecoveryCliInternals, parseJobRecoveryArguments } from '../../../scripts/job-recovery.mjs';

const apiSource = (name) => new URL(`../src/${name}`, import.meta.url);
const jobRegistryUrl = apiSource('job-registry.js');
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
  'job-running-database-backup-recovery.js',
  'job-running-database-restore-recovery.js',
  'job-running-database-credential-recovery.js',
  'job-running-dns-record-recovery.js',
  'job-running-service-recovery.js',
  'job-running-service-receipt-recovery.js',
  'job-running-system-upgrade-recovery.js',
  'job-running-certificate-recovery.js',
  'job-running-mail-config-recovery.js',
  'job-running-mail-config-rollback-recovery.js',
  'job-running-mail-dkim-recovery.js',
  'job-running-mail-data-recovery.js',
  'job-running-roundcube-config-recovery.js',
  'job-running-cron-recovery.js',
  'job-running-python-recovery.js',
  'job-running-php-tool-recovery.js',
  'website-backup-operation-service.js',
  'website-static-copy-service.js',
  'php-site-copy-service.js',
  'application-passenger-migration-reconciliation.js',
  'passenger-release-recovery.js',
  'passenger-release-reconciliation.js',
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

test('packaged recovery CLI exposes only explicit operation families and no force/retry escape hatch', () => {
  const expected = [
    'reconcile',
    'recover-readonly',
    'recover-domain-stage',
    'recover-domain-activate',
    'recover-static-deploy',
    'recover-static-rollback',
    'recover-node-deploy',
    'recover-passenger-release',
    'compensate-passenger-release',
    'recover-node-restart',
    'recover-node-process',
    'recover-node-runtime-install',
    'recover-node-rollback',
    'recover-python-deploy',
    'recover-python-rollback',
    'recover-python-restart',
    'recover-system-upgrade',
    'recover-certificate',
    'recover-database-create',
    'recover-database-delete',
    'recover-database-backup',
    'recover-database-restore',
    'recover-database-credential',
    'recover-dns-record',
    'recover-service-control',
    'recover-service-mutation',
    'recover-mail-config',
    'recover-mail-dkim',
    'recover-mail-data',
    'recover-roundcube-config',
    'recover-php-tool',
    'recover-cron',
  ];
  assert.deepEqual([...jobRecoveryCliInternals.recoveryActions].sort(), [...expected].sort());
  for (const action of expected) {
    assert.deepEqual(parseJobRecoveryArguments([action, 'server-1', 'job-00000001', '--confirm']).action, action);
  }
  for (const action of ['force-success', 'force-failed', 'retry-mutation', 'clear-journal']) {
    assert.throws(() => parseJobRecoveryArguments([action, 'server-1', 'job-00000001', '--confirm']), /Usage:/);
  }
});
