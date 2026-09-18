import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexUrl = new URL('../src/index.js', import.meta.url);
const appUrl = new URL('../src/app.js', import.meta.url);

test('production boot creates elFinder handoff state from Website registry and live Owner sessions', async () => {
  const source = await readFile(indexUrl, 'utf8');
  assert.match(source, /createElFinderHandoffService/);
  assert.match(source, /startElFinderHandoffSocket/);
  assert.match(source, /createElFinderHandoffService\(\{[\s\S]*websiteRegistry,[\s\S]*localServerId,[\s\S]*runtimeInspector:[\s\S]*websiteProvisioningRuntime\.handlers\.elfinder\.inspect[\s\S]*liveSessions/);
  assert.match(source, /elFinderHandoffRuntime = await startElFinderHandoffSocket\(\{ elFinderHandoffService \}\)/);
  assert.match(
    source,
    /elFinderHandoffService: elFinderHandoffRuntime \? elFinderHandoffService : null/,
  );
  assert.match(source, /elFinder handoff=\$\{elFinderHandoffRuntime \? 'enabled' : 'disabled'\}/);
  assert.match(source, /if \(elFinderHandoffRuntime\) \{[\s\S]*await elFinderHandoffRuntime\.close\(\)/);
});

test('production app mounts Owner elFinder handoff route only when the private runtime is enabled', async () => {
  const source = await readFile(appUrl, 'utf8');
  assert.match(source, /mountElFinderHandoffRoutes/);
  assert.match(source, /elFinderHandoffService = null/);
  assert.match(source, /if \(elFinderHandoffService\) \{[\s\S]*mountElFinderHandoffRoutes\(app, \{[\s\S]*registry: localRegistry,[\s\S]*elFinderHandoffService/);
  assert.match(source, /error instanceof ElFinderHandoffError/);
});
