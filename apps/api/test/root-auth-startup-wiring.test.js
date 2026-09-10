import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexUrl = new URL('../src/index.js', import.meta.url);

test('production entry point prepares legacy private auth ownership before opening the auth store', async () => {
  const source = await readFile(indexUrl, 'utf8');
  const prepareIndex = source.indexOf('await prepareRootAuthStateOwnership({ filePath: authStorePath });');
  const openIndex = source.indexOf('const authStore = createAuthStore({ filePath: authStorePath });');
  assert.ok(prepareIndex >= 0);
  assert.ok(openIndex > prepareIndex);
});
