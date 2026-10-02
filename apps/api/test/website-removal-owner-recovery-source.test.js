import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('all Website removal endpoints use the route and Website tenant guards', async () => {
  const source=await readFile(new URL('../src/website-removal-http.js',import.meta.url),'utf8');
  assert.match(source,/requirePanelRouteAccess/);
  assert.ok((source.match(/requireWebsiteAccess/g) ?? []).length >= 8);
  assert.match(source,/actorTenant\.websiteIds\.includes\(targetWebsiteId\)/);
  assert.match(source,/auth\?\.security\?\.managementAllowed !== true/);
});

test('global removal recovery endpoints survive Website metadata deletion', async () => {
  const source=await readFile(new URL('../src/website-removal-http.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/website-removal-operations'/);
  assert.match(source,/\/api\/website-removal-operations\/:operationId'/);
  const runtime=await readFile(new URL('../src/website-removal-runtime.js',import.meta.url),'utf8');
  assert.match(runtime,/async function list\(\)/);
});

test('global Owner continuation does not depend on Website metadata route', async () => {
  const source=await readFile(new URL('../src/website-removal-http.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/website-removal-operations\/:operationId\/continue/);
  const block=source.slice(source.indexOf("app.post('/api/website-removal-operations/:operationId/continue"), source.indexOf("app.get('/api/websites/:websiteId/removal"));
  assert.match(block,/runtime\.get\(request\.params\.operationId\)/);
  assert.match(block,/websiteId: operation\.websiteId/);
  assert.doesNotMatch(block,/request\.params\.websiteId/);
});
