import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const source = await readFile(new URL('../src/workspace/DatabasesPage.jsx', import.meta.url), 'utf8');

test('database console retains search, pagination and explicit access alternatives', () => {
  assert.match(source, /useSearchParams/);
  assert.match(source, /filterConsoleDatabases/);
  assert.match(source, /paginateConsoleItems/);
  assert.match(source, /view\.canOpen/);
  assert.match(source, /view\.siteHref/);
  assert.match(source, /Erişimi yapılandır/);
  assert.match(source, /Siteye bağla/);
});
test('database create form is opt-in; technical security facts remain available', () => {
  assert.match(source, /createOpen && <Modal/);
  assert.match(source, /<details className="ws-section ws-disclosure ws-database-diagnostics"/);
  for (const label of ['Engine', 'DB güvenlik baseline', 'Admin socket auth', 'Website bağı', 'Credential', 'Eksik schema bağı']) assert.ok(source.includes(label));
});
test('database failed and cancelled jobs cannot report successful creation', () => {
  assert.match(source, /terminal\?\.status !== 'succeeded'/);
  assert.match(source, /terminal\?\.status === 'cancelled'/);
  assert.match(source, /scope !== scopeGeneration\.current/);
  assert.match(source, /if \(terminal\) \{ setName\(''\); setCreateOpen\(false\);/);
});
test('database mutations and handoff require fresh inventory and explicit identity', () => {
  assert.match(source, /servers\.status === 'ready' && status === 'ready' && !busy/);
  assert.match(source, /if \(!canAct \|\| pending\.current\)/);
  assert.match(source, /!ownership\?\.websiteId \|\| !ownership\?\.credential\?\.id/);
  assert.match(source, /issueHandoff: createPhpMyAdminHandoff/);
  assert.match(source, /observe\(queued\)/);
  assert.match(source, /waitForJob\(queued\.id\)/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|window\.open|innerHTML|inspectDatabases/);
});
