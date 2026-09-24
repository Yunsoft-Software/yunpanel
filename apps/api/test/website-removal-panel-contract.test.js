import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Website removal preview stays blocked without Application cleanup lifecycle', async () => {
  const source = await readFile(new URL('../src/website-removal-runtime.js', import.meta.url), 'utf8');
  assert.match(source, /application_cleanup_unavailable/);
  assert.match(source, /applicationRegistry\?\.deleteApplication/);
});

test('Website removal routes expose panel data envelopes without dropping legacy fields', async () => {
  const source = await readFile(new URL('../src/website-removal-http.js', import.meta.url), 'utf8');
  assert.match(source, /preview, operations, data/);
  assert.match(source, /preview, data: preview/);
  assert.match(source, /operation, data: operation/);
  assert.match(source, /operations, data: operations/);
});
