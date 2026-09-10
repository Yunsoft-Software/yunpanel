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

test('production Website migration policy persists before Domain registry initialization', () => {
  assert.match(source, /import \{ createWebsiteMigrationPolicyStore \} from '\.\/website-migration-policy\.js';/);
  assert.match(source, /const websiteMigrationPolicyStorePath = process\.env\.YUNPANEL_WEBSITE_MIGRATION_POLICY_STORE \?\? path\.resolve\('\.data\/website-migration-policy\.json'\);/);
  assert.match(source, /const websiteMigrationPolicy = createWebsiteMigrationPolicyStore\(\{ filePath: websiteMigrationPolicyStorePath \}\);/);
  assert.match(source, /await websiteMigrationPolicy\.init\(\);/);

  const websiteInit = source.indexOf('await websiteRegistry.init();');
  const policyInit = source.indexOf('await websiteMigrationPolicy.init();');
  const domainCreate = source.indexOf('const domainRegistry = createDomainRegistry({');
  const domainInit = source.indexOf('await domainRegistry.init();');
  assert.ok(websiteInit >= 0 && policyInit > websiteInit && domainCreate > policyInit && domainInit > domainCreate);
  assert.match(source, /websiteBindingRequired: \(\) => websiteMigrationPolicy\.snapshot\(\)\.websiteBindingRequired,/);
  assert.match(source, /getWebsite: async \(websiteId\) => websiteRegistry\.getWebsite\(websiteId\),/);
  assert.match(source, /websiteMigrationPolicy,/);
  assert.match(source, /website migration policy store=\$\{websiteMigrationPolicyStorePath\}/);
});

test('Website stores and API composition include explicit domain migration policy dependencies', () => {
  assert.match(envExample, /^YUNPANEL_WEBSITE_STORE=\.data\/website-registry\.json$/m);
  assert.match(envExample, /^YUNPANEL_WEBSITE_MIGRATION_POLICY_STORE=\.data\/website-migration-policy\.json$/m);
  assert.match(appSource, /websiteMigrationPolicy = createWebsiteMigrationPolicyStore\(\),/);
  assert.match(appSource, /websiteBindingRequired: \(\) => websiteMigrationPolicy\.snapshot\(\)\.websiteBindingRequired,/);
  assert.match(appSource, /mountWebsiteRoutes\(app, \{ websiteRegistry, domainRegistry \}\);/);
  assert.match(appSource, /mountWebsiteMigrationRoutes\(app, \{ websiteRegistry, domainRegistry, applicationRegistry, websiteMigrationPolicy \}\);/);
  assert.match(appSource, /error instanceof WebsiteMigrationBindError/);
  assert.match(appSource, /error instanceof WebsiteMigrationPolicyError/);
  assert.match(appSource, /error instanceof WebsiteMigrationPreviewError/);
  assert.match(appSource, /error instanceof WebsiteRegistryError/);
});
