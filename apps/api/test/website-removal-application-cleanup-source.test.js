import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Website removal journals Application cleanup after Website metadata finalization', async () => {
  const source=await readFile(new URL('../src/website-removal-operation-registry.js',import.meta.url),'utf8');
  assert.ok(source.indexOf("add('metadata_finalization'") < source.indexOf("add('application_cleanup'"));
});
test('Website removal production wiring supplies Application environment cleanup dependency', async () => {
  const source=await readFile(new URL('../src/index.js',import.meta.url),'utf8');
  const start=source.indexOf('createWebsiteRemovalRuntime({');
  const block=source.slice(start,start+1600);
  assert.match(block,/applicationEnvironmentRegistry/);
});
