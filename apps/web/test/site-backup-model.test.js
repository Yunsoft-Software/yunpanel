import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSiteBackupAccess, siteBackupBrowser } from '../src/workspace/site-backup-model.js';

const scope = { websiteId: '11111111-1111-4111-8111-111111111111', serverId: '22222222-2222-4222-8222-222222222222' };
const value = {
  schemaVersion: 1,
  ...scope,
  backupSet: { digest: 'a'.repeat(64), runtimeType: 'php', databaseCount: 1, mailCount: 0, dnsCount: 1, pathCount: 3, composeHooksEnabled: false },
  repositories: [{ id: '33333333-3333-4333-8333-333333333333', name: 'primary', backend: 'local', status: 'ready',
    retentionPolicy: { keepLast: 5 }, lastCheckedAt: null, lastSnapshotAt: '2026-09-25T00:00:00.000Z', snapshotStatus: 'ready',
    snapshots: [{ id: 'b'.repeat(64), shortId: 'bbbbbbbb', time: '2026-09-25T00:00:00.000Z', kind: 'backup' }] }],
  inspectedAt: '2026-09-25T00:01:00.000Z',
};

test('browser accepts only exact Website/server scope', () => {
  assert.equal(siteBackupBrowser(value, scope).repositories[0].snapshots.length, 1);
  assert.throws(() => siteBackupBrowser({ ...value, websiteId: '44444444-4444-4444-8444-444444444444' }, scope));
});
test('access resolves Domain to explicit Website without fallback', () => {
  const input = { domainId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', canManage: true,
    domains: { status: 'ready', items: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', websiteId: scope.websiteId, serverId: scope.serverId }] },
    websites: { status: 'ready', items: [{ id: scope.websiteId, serverId: scope.serverId }] } };
  assert.deepEqual(resolveSiteBackupAccess(input), { state: 'ready', scope });
});
test('unsafe repository/snapshot metadata is rejected by model', () => {
  assert.throws(() => siteBackupBrowser({ ...value, repositories: [{ ...value.repositories[0], name: '../secret' }] }, scope));
  assert.throws(() => siteBackupBrowser({ ...value, repositories: [{ ...value.repositories[0], snapshots: [{ ...value.repositories[0].snapshots[0], time: 'bad' }] }] }, scope));
});
