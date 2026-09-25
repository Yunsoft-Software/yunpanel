import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('all Website removal endpoints use Owner-only guard', async () => {
  const source=await readFile(new URL('../src/website-removal-http.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/removal[^\n]*requirePanelRouteAccess/);
  assert.ok((source.match(/requireRemovalOwner/g) ?? []).length >= 8);
});

test('global removal recovery endpoints survive Website metadata deletion', async () => {
  const source=await readFile(new URL('../src/website-removal-http.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/website-removal-operations'/);
  assert.match(source,/\/api\/website-removal-operations\/:operationId'/);
  const runtime=await readFile(new URL('../src/website-removal-runtime.js',import.meta.url),'utf8');
  assert.match(runtime,/async function list\(\)/);
});
