import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Website removal journals Application cleanup after Website metadata finalization', async () => {
  const source=await readFile(new URL('../src/website-removal-operation-registry.js',import.meta.url),'utf8');
  assert.ok(source.indexOf("add('metadata_finalization'") < source.indexOf("add('application_cleanup'"));
});
test('source declaration retains environment cleanup and Domain inventory dependencies in Website removal composition', async () => {
  const source=await readFile(new URL('../src/index.js',import.meta.url),'utf8');
  const start=source.indexOf('createWebsiteRemovalRuntime({');
  const end=source.indexOf('\n  })\n  : null;',start);
  assert.ok(start>=0&&end>start,'The complete Website removal composition must be identifiable');
  const block=source.slice(start,end);
  assert.match(block,/applicationEnvironmentRegistry/);
  assert.match(block,/domainRegistry/);
});

test('Website removal preview journals Application revision separately from Website revision', async () => {
  const source=await readFile(new URL('../src/website-removal-plan.js',import.meta.url),'utf8');
  assert.match(source,/applicationRevision:/);
  assert.match(source,/application\.desiredRevision/);
  const runtime=await readFile(new URL('../src/website-removal-runtime.js',import.meta.url),'utf8');
  assert.match(runtime,/expectedDesiredRevision: op\.applicationRevision/);
  assert.doesNotMatch(runtime,/expectedDesiredRevision: op\.websiteRevision/);
});
