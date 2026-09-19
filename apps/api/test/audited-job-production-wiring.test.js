import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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
