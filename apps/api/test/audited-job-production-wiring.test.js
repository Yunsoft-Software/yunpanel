import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createApplicationRegistry } from '../src/application-registry.js';
import { createWebsiteCachePolicyRegistry } from '../src/website-cache-policy-registry.js';
import { createWebsiteCacheService } from '../src/website-cache-service.js';
import { createWebsitePhpToolsService } from '../src/website-php-tools-service.js';
import { createWebsiteRegistry } from '../src/website-registry.js';

const indexUrl = new URL('../src/index.js', import.meta.url);

test('production wraps the durable registry with the common audit store before exposing jobs', async () => {
  const source = await readFile(indexUrl, 'utf8');
  assert.match(source, /const durableJobRegistry = createDurableJobRegistry\(/);
  assert.match(source, /await durableJobRegistry\.init\(\)/);
  assert.match(source, /const authStore = createAuthStore\(/);
  assert.match(source, /const auditedJobRegistry = createAuditedJobRegistry\(\{[\s\S]*registry: durableJobRegistry,[\s\S]*audit: authStore\.audit,/);
  assert.match(source, /const jobRegistry = createDomainStageTargetJobRegistry\(\{[\s\S]*registry: auditedJobRegistry,/);
  assert.doesNotMatch(source, /createApp\([^)]*jobRegistry:\s*durableJobRegistry/);
});

test('production constructs job-backed services only after the audited job registry', async () => {
  const source = await readFile(indexUrl, 'utf8');
  const jobRegistryDeclaration = source.indexOf('const jobRegistry = createDomainStageTargetJobRegistry({');
  const cronServiceDeclaration = source.indexOf('const websiteCronApplyService = createWebsiteCronApplyService({');
  const settingsServiceDeclaration = source.indexOf('const panelSettingsService = createPanelSettingsService({');

  assert.ok(jobRegistryDeclaration >= 0);
  assert.ok(cronServiceDeclaration > jobRegistryDeclaration);
  assert.ok(settingsServiceDeclaration > jobRegistryDeclaration);
});

test('new Website services accept the production registry contracts', () => {
  const applicationRegistry = createApplicationRegistry({
    serverExists: async () => true,
  });
  const websiteRegistry = createWebsiteRegistry({
    serverExists: async () => true,
    getApplication: (applicationId) => applicationRegistry.getApplication(applicationId),
  });
  const cachePolicyRegistry = createWebsiteCachePolicyRegistry({
    masterKey: 'production-composition-test-key-0001',
  });

  assert.doesNotThrow(() => createWebsitePhpToolsService({
    websiteRegistry,
    applicationRegistry,
    phpCliToolManager: {},
  }));
  assert.doesNotThrow(() => createWebsiteCacheService({
    websiteRegistry,
    applicationRegistry,
    cachePolicyRegistry,
    cacheIsolationManager: {},
  }));
});

test('production mounts Website service routes through the shared panel guard', async () => {
  const source = await readFile(indexUrl, 'utf8');
  const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');

  assert.match(source, /websitePhpToolsService,[\s\S]*websiteCacheService,/);
  assert.doesNotMatch(appSource, /core\.requirePanelRouteAccess/);
});

test('API local executor and renewal scheduler share the audited registry', async () => {
  const source = await readFile(indexUrl, 'utf8');
  assert.match(source, /createHandler: \(\) => createDockerComposeApiHandler\(\{[\s\S]*?baseHandler: createApp\(\{[\s\S]*?\n\s*jobRegistry,[\s\S]*?\n\s*dnsProviderCredentialRegistry,/);
  assert.match(source, /startConfiguredLocalRuntime\(\{[\s\S]*\n\s*jobRegistry,[\s\S]*\n\s*dnsProviderCredentialRegistry,/);
  assert.match(source, /startCertificateRenewalScheduler\(\{[\s\S]*?\n\s*certificateRegistry,[\s\S]*?\n\s*jobRegistry,[\s\S]*?\n\s*dnsProviderCredentialRegistry,/);
});

test('production audit fault logging is bounded to safe phase and job identity', async () => {
  const source = await readFile(indexUrl, 'utf8');
  assert.match(source, /function reportAuditFault\(metadata\)/);
  assert.match(source, /audit write failed phase=\$\{phase\} job=\$\{jobId\}/);
  assert.doesNotMatch(source, /audit write failed[^\n]*(error\.message|error\.stack|JSON\.stringify)/);
});
