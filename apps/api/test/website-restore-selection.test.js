import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWebsiteRestoreSelection, assertWebsiteSnapshotContent } from '../src/website-restore-selection.js';
const app = '/var/lib/yunpanel/apps/site-a', data = '/var/lib/yunpanel/data/site-a', staged = '/var/lib/yunpanel/backups/resources/website/site-a';
const set = { targetPaths: [app, data, staged], files: { targetPaths: [app] }, data: { targetPaths: [data] }, databases: [{ dumpHook: { stagedDumpPath: staged + '/databases/main.sql' } }], mail: [], dns: [] };
test('full restore always supplies explicit Website roots, never an unfiltered repository restore', () => {
  const selection = resolveWebsiteRestoreSelection(set);
  assert.deepEqual(selection, [app, data, staged].sort());
  assert.equal(selection.length > 0, true);
  const nodes = [{ type: 'file', path: '/var/lib/yunpanel/apps/site-b/index.php' }];
  assert.throws(() => assertWebsiteSnapshotContent(nodes, set, selection), { code: 'website_restore_snapshot_content_missing' });
});
test('UI restore groups become actual website paths instead of literal restic patterns', () => {
  assert.deepEqual(resolveWebsiteRestoreSelection(set, ['paths']), [app, data]);
  assert.deepEqual(resolveWebsiteRestoreSelection(set, ['databases']), [staged + '/databases/main.sql']);
});
test('restore rejects sibling roots, relative patterns and traversal before side effects', () => {
  for (const value of ['/var/lib/yunpanel/apps/site-b', app + '/../site-b', '*', 'paths/*', '/']) assert.throws(() => resolveWebsiteRestoreSelection(set, [value]));
  assert.throws(() => resolveWebsiteRestoreSelection(set, ['mail']), e => e.code === 'website_restore_selection_empty');
});
test('an old symlink-only snapshot cannot report a successful site restore', () => {
  const nodes = [{ type: 'symlink', path: app + '/current' }, { type: 'file', path: data + '/.profile' }];
  assert.throws(() => assertWebsiteSnapshotContent(nodes, set, []), e => e.code === 'website_restore_snapshot_content_missing');
  assert.throws(() => assertWebsiteSnapshotContent(nodes, set, [app + '/current/public/index.php']));
});
test('real release files satisfy content validation and empty selections fail', () => {
  const nodes = [{ type: 'file', path: app + '/releases/release-a/public/index.php' }];
  assert.equal(assertWebsiteSnapshotContent(nodes, set, []), 1);
  assert.throws(() => assertWebsiteSnapshotContent(nodes, set, [app + '/releases/missing']));
});
