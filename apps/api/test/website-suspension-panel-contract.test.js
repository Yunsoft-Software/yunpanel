import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Website suspension GET preserves legacy fields and panel data envelope', async () => {
  const source = await readFile(new URL('../src/website-suspension-http.js', import.meta.url), 'utf8');
  assert.match(source, /response\.json\(\{ preview, operations, data \}\)/);
  assert.match(source, /Cache-Control/);
});

test('Website suspension mutations return operation in panel data envelope', async () => {
  const source = await readFile(new URL('../src/website-suspension-http.js', import.meta.url), 'utf8');
  assert.match(source, /status\(201\)\.json\(\{ operation, data: operation \}\)/);
  assert.ok((source.match(/json\(\{ operation, data: operation \}\)/g) ?? []).length >= 4);
});
