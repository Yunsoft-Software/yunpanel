import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('PHP HTTP exposes preview but no reviewed action execution endpoint yet', async () => {
  const source = await readFile(new URL('../src/website-php-tools-http.js', import.meta.url), 'utf8');
  assert.match(source, /router\.post\('\/actions\/preview'/);
  assert.doesNotMatch(source, /router\.post\('\/actions\/run'/);
  assert.doesNotMatch(source, /router\.post\('\/actions\/:actionId'/);
});

test('legacy raw run endpoints require Owner after panel auth', async () => {
  const source = await readFile(new URL('../src/website-php-tools-http.js', import.meta.url), 'utf8');
  assert.match(source, /php_tool_raw_run_owner_only/);
  assert.match(source, /\/wp-cli\/run', requirePanelRouteAccess, requireOwnerMutation/);
  assert.match(source, /\/composer\/run', requirePanelRouteAccess, requireOwnerMutation/);
});

test('review preview accepts exactly one actionId field', async () => {
  const source = await readFile(new URL('../src/website-php-tools-http.js', import.meta.url), 'utf8');
  assert.match(source, /Object\.keys\(body\)\.length !== 1/);
  assert.match(source, /typeof body\.actionId !== 'string'/);
});
