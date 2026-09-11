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

test('production API persists and initializes Website registry explicitly', () => {
  assert.match(source, /import \{ createWebsiteRegistry \} from '\.\/website-registry\.js';/);
  assert.match(source, /const websiteStorePath = process\.env\.YUNPANEL_WEBSITE_STORE \?\? path\.resolve\('\.data\/website-registry\.json'\);/);
  assert.match(source, /const websiteRegistry = createWebsiteRegistry\(\{/);
  assert.match(source, /filePath: websiteStorePath,/);
  assert.match(source, /serverExists: async \(serverId\) => Boolean\(await registry\.getServer\(serverId\)\),/);
  assert.match(source, /getApplication: async \(applicationId\) => applicationRegistry\.getApplication\(applicationId\),/);
  assert.match(source, /getDockerWorkload: async \(workloadId\) => dockerWorkloadRegistry\.getWorkload\(workloadId\),/);
  assert.match(source, /await websiteRegistry\.init\(\);/);
  assert.match(source, /website store=\$\{websiteStorePath\}/);
});

test('production migration policy and ledger initialize before Domain registry', () => {
  assert.match(source, /import \{ createWebsiteMigrationPolicyStore \} from '\.\/website-migration-policy\.js';/);
  assert.match(source, /import \{ createWebsiteMigrationLedger \} from '\.\/website-migration-ledger\.js';/);
  assert.match(source, /const websiteMigrationPolicyStorePath = process\.env\.YUNPANEL_WEBSITE_MIGRATION_POLICY_STORE \?\? path\.resolve\('\.data\/website-migration-policy\.json'\);/);
  assert.match(source, /const websiteMigrationLedgerStorePath = process\.env\.YUNPANEL_WEBSITE_MIGRATION_LEDGER_STORE \?\? path\.resolve\('\.data\/website-migration-ledger\.json'\);/);
  assert.match(source, /const websiteMigrationPolicy = createWebsiteMigrationPolicyStore\(\{ filePath: websiteMigrationPolicyStorePath \}\);/);
  assert.match(source, /const migrationLedger = createWebsiteMigrationLedger\(\{ filePath: websiteMigrationLedgerStorePath \}\);/);
  assert.match(source, /await websiteMigrationPolicy\.init\(\);/);
  assert.match(source, /await migrationLedger\.init\(\);/);

  const websiteInit = source.indexOf('await websiteRegistry.init();');
  const policyInit = source.indexOf('await websiteMigrationPolicy.init();');
  const ledgerInit = source.indexOf('await migrationLedger.init();');
  const domainCreate = source.indexOf('const domainRegistry = createDomainRegistry({');
  const domainInit = source.indexOf('await domainRegistry.init();');
  assert.ok(websiteInit >= 0 && policyInit > websiteInit && ledgerInit > policyInit && domainCreate > ledgerInit && domainInit > domainCreate);
  assert.match(source, /websiteBindingRequired: \(\) => websiteMigrationPolicy\.snapshot\(\)\.websiteBindingRequired,/);
  assert.match(source, /getWebsite: async \(websiteId\) => websiteRegistry\.getWebsite\(websiteId\),/);
  assert.match(source, /websiteMigrationPolicy,/);
  assert.match(source, /migrationLedger,/);
  assert.match(source, /website migration ledger store=\$\{websiteMigrationLedgerStorePath\}/);
});

test('Website migration stores and API composition expose explicit dependencies', () => {
  assert.match(envExample, /^YUNPANEL_WEBSITE_STORE=\.data\/website-registry\.json$/m);
  assert.match(envExample, /^YUNPANEL_WEBSITE_MIGRATION_POLICY_STORE=\.data\/website-migration-policy\.json$/m);
  assert.match(envExample, /^YUNPANEL_WEBSITE_MIGRATION_LEDGER_STORE=\.data\/website-migration-ledger\.json$/m);
  assert.match(appSource, /websiteMigrationPolicy = createWebsiteMigrationPolicyStore\(\),/);
  assert.match(appSource, /migrationLedger = createWebsiteMigrationLedger\(\),/);
  assert.match(appSource, /websiteBindingRequired: \(\) => websiteMigrationPolicy\.snapshot\(\)\.websiteBindingRequired,/);
  assert.match(appSource, /mountWebsiteRoutes\(app, \{ websiteRegistry, domainRegistry \}\);/);
  assert.match(appSource, /mountWebsiteMigrationRoutes\(app, \{[\s\S]*websiteMigrationPolicy,[\s\S]*migrationLedger,[\s\S]*\}\);/);
  assert.match(appSource, /error instanceof WebsiteMigrationBindError/);
  assert.match(appSource, /error instanceof WebsiteMigrationCreateError/);
  assert.match(appSource, /error instanceof WebsiteMigrationLedgerError/);
  assert.match(appSource, /error instanceof WebsiteMigrationPolicyError/);
  assert.match(appSource, /error instanceof WebsiteMigrationPreviewError/);
  assert.match(appSource, /error instanceof WebsiteRegistryError/);
});
