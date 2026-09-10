import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '../../..');
const source = readFileSync(path.join(repositoryRoot, 'apps/api/src/index.js'), 'utf8');
const envExample = readFileSync(path.join(repositoryRoot, '.env.example'), 'utf8');
const appSource = readFileSync(path.join(repositoryRoot, 'apps/api/src/app.js'), 'utf8');

test('production API persists and initializes the Website registry explicitly', () => {
  assert.match(source, /import \{ createWebsiteRegistry \} from '\.\/website-registry\.js';/);
  assert.match(source, /const websiteStorePath = process\.env\.YUNPANEL_WEBSITE_STORE \?\? path\.resolve\('\.data\/website-registry\.json'\);/);
  assert.match(source, /const websiteRegistry = createWebsiteRegistry\(\{/);
  assert.match(source, /filePath: websiteStorePath,/);
  assert.match(source, /serverExists: async \(serverId\) => Boolean\(await registry\.getServer\(serverId\)\),/);
  assert.match(source, /getApplication: async \(applicationId\) => applicationRegistry\.getApplication\(applicationId\),/);
  assert.match(source, /await websiteRegistry\.init\(\);/);
  assert.match(source, /websiteRegistry,/);
  assert.match(source, /website store=\$\{websiteStorePath\}/);
});

test('Website store has an explicit environment contract and API composition mount', () => {
  assert.match(envExample, /^YUNPANEL_WEBSITE_STORE=\.data\/website-registry\.json$/m);
  assert.match(appSource, /mountWebsiteRoutes\(app, \{ websiteRegistry \}\);/);
  assert.match(appSource, /error instanceof WebsiteRegistryError/);
});
