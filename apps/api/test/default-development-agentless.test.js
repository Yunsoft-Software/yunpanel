import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const devScriptUrl = new URL('../../../scripts/dev.mjs', import.meta.url);
const packageUrl = new URL('../../../package.json', import.meta.url);

test('default development launcher starts only API and web', async () => {
  const source = await readFile(devScriptUrl, 'utf8');
  assert.match(source, /name: 'api'/);
  assert.match(source, /name: 'web'/);
  assert.doesNotMatch(source, /dev:agent|name: 'agent'|YUN_AGENT_MODE/);
});

test('legacy agent development stays explicit instead of being removed before rollback acceptance', async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, 'utf8'));
  assert.equal(packageJson.scripts.dev, 'node scripts/dev.mjs');
  assert.equal(packageJson.scripts['dev:agent'], 'npm run dev --workspace @yunpanel/agent');
});
