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

test('production Domain registry validates explicit Website links after Website initialization', () => {
  const websiteInit = source.indexOf('await websiteRegistry.init();');
  const domainCreate = source.indexOf('const domainRegistry = createDomainRegistry({');
  const domainInit = source.indexOf('await domainRegistry.init();');
  assert.ok(websiteInit >= 0 && domainCreate > websiteInit && domainInit > domainCreate);
  assert.match(source, /getWebsite: async \(websiteId\) => websiteRegistry\.getWebsite\(websiteId\),/);
});

test('Website store and API composition include explicit domain and migration dependencies', () => {
  assert.match(envExample, /^YUNPANEL_WEBSITE_STORE=\.data\/website-registry\.json$/m);
  assert.match(appSource, /mountWebsiteRoutes\(app, \{ websiteRegistry, domainRegistry \}\);/);
  assert.match(appSource, /mountWebsiteMigrationRoutes\(app, \{ websiteRegistry, domainRegistry, applicationRegistry \}\);/);
  assert.match(appSource, /error instanceof WebsiteMigrationBindError/);
  assert.match(appSource, /error instanceof WebsiteMigrationPreviewError/);
  assert.match(appSource, /error instanceof WebsiteRegistryError/);
});
