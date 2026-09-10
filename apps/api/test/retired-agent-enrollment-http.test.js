import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const coreAppUrl = new URL('../src/core-app.js', import.meta.url);

test('core API does not expose new legacy agent enrollment routes', async () => {
  const source = await readFile(coreAppUrl, 'utf8');
  assert.doesNotMatch(source, /\/api\/servers\/enrollment-tokens/);
  assert.doesNotMatch(source, /app\.post\(['"]\/api\/servers\/enroll['"]/);
});
