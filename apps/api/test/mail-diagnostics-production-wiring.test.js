import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (name) => new URL(`../src/${name}`, import.meta.url);

async function text(name) {
  return readFile(source(name), 'utf8');
}

test('production app mounts the local mail diagnostics inspector as a read-only route', async () => {
  const appSource = await text('app.js');

  assert.match(appSource, /createMailDiagnosticsInspector/);
  assert.match(appSource, /mailDiagnosticsInspector = createMailDiagnosticsInspector\(\)/);
  assert.match(appSource, /mountMailDiagnosticsRoutes\(app,\s*\{[\s\S]*?mailDiagnosticsInspector,[\s\S]*?mailDomainRegistry,[\s\S]*?domainRegistry,[\s\S]*?localServerId,[\s\S]*?\}\)/);
  assert.match(appSource, /error instanceof MailDiagnosticsHttpError/);
  assert.match(appSource, /error instanceof MailDiagnosticsInspectorError/);
});
