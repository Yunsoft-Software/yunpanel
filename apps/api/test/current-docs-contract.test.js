import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../../', import.meta.url);
const currentDocs = [
  'README.md',
  'plan.md',
  'todo.md',
  'agents.md',
  'docs/development.md',
  'docs/domain-hierarchy.md',
  'docs/local-executor-safety.md',
  'docs/local-migration-backup.md',
  'docs/local-runtime-migration.md',
  'docs/website-workspace.md',
];

async function loadCurrentDocs() {
  const entries = await Promise.all(currentDocs.map(async (path) => [
    path,
    await readFile(new URL(path, root), 'utf8'),
  ]));
  return new Map(entries);
}

test('current architecture docs do not advertise retired ownership or enrollment paths', async () => {
  const docs = await loadCurrentDocs();
  const combined = [...docs.entries()].map(([path, content]) => `\n--- ${path} ---\n${content}`).join('\n');

  for (const retired of [
    'local-runtime.mjs create --confirm',
    'local-runtime.mjs bind <server-uuid> --confirm',
    'local-runtime.mjs release <server-uuid> --confirm',
    'YUNPANEL_ENROLLMENT_TOKEN=',
    'apps/api/src/index.js still does not start the local executor',
    'Node deploy/restart/rollback and environment materialization have not been connected locally',
    'existing advanced enrollment',
    'user administration source, route, password-helper refactor, tests or UI was committed',
  ]) {
    assert.equal(combined.includes(retired), false, `current docs still contain retired statement: ${retired}`);
  }
});

test('current docs expose the implemented agentless migration and deferred-design boundaries', async () => {
  const docs = await loadCurrentDocs();

  assert.match(docs.get('README.md'), /local-runtime\.mjs validate <server-uuid>/);
  assert.match(docs.get('README.md'), /create --backup-dir \/var\/backups\/yunpanel\/migration-<timestamp> --confirm/);
  assert.match(docs.get('plan.md'), /Migration live-apply katmanını yalnız gerçek test-host kabulünden sonra aç/);
  assert.match(docs.get('todo.md'), /`local-runtime validate <id>`/);
  assert.doesNotMatch(docs.get('plan.md'), /Kalan legacy hata yollarını güvenli tanı kataloğuna bağla/);
  assert.match(docs.get('agents.md'), /DEFERRED — Enterprise UI\/UX standardı/);
  assert.match(docs.get('docs/development.md'), /New enrollment is retired/);
  assert.match(docs.get('docs/local-executor-safety.md'), /Production enters through `apps\/api\/src\/index\.js`/);
  assert.match(docs.get('docs/local-executor-safety.md'), /There is no generic `force-success`/);
  assert.match(docs.get('docs/local-migration-backup.md'), /Metadata plan for future live apply/);
  assert.match(docs.get('docs/local-runtime-migration.md'), /local-runtime\.mjs validate <server-uuid>/);
  assert.match(docs.get('docs/website-workspace.md'), /common audit and Owner user administration/);
  assert.match(docs.get('docs/domain-hierarchy.md'), /Website identity is independent from hostname\/domain IDs/);
});
