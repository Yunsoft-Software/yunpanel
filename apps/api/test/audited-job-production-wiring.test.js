import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexUrl = new URL('../src/index.js', import.meta.url);

test('production wraps the durable registry with the common audit store before exposing jobs', async () => {
  const source = await readFile(indexUrl, 'utf8');
  assert.match(source, /const durableJobRegistry = createDurableJobRegistry\(/);
  assert.match(source, /await durableJobRegistry\.init\(\)/);
  assert.match(source, /const authStore = createAuthStore\(/);
  assert.match(source, /const jobRegistry = createAuditedJobRegistry\(\{[\s\S]*registry: durableJobRegistry,[\s\S]*audit: authStore\.audit,/);
  assert.doesNotMatch(source, /createApp\([^)]*jobRegistry:\s*durableJobRegistry/);
});

test('API local executor and renewal scheduler share the audited registry', async () => {
  const source = await readFile(indexUrl, 'utf8');
  assert.match(source, /createHandler: \(\) => createApp\(\{[\s\S]*?\n\s*jobRegistry,[\s\S]*?\n\s*dnsProviderCredentialRegistry,/);
  assert.match(source, /startConfiguredLocalRuntime\(\{[\s\S]*\n\s*jobRegistry,[\s\S]*\n\s*dnsProviderCredentialRegistry,/);
  assert.match(source, /startCertificateRenewalScheduler\(\{[\s\S]*?\n\s*certificateRegistry,[\s\S]*?\n\s*jobRegistry,[\s\S]*?\n\s*dnsProviderCredentialRegistry,/);
});

test('production audit fault logging is bounded to safe phase and job identity', async () => {
  const source = await readFile(indexUrl, 'utf8');
  assert.match(source, /function reportAuditFault\(metadata\)/);
  assert.match(source, /audit write failed phase=\$\{phase\} job=\$\{jobId\}/);
  assert.doesNotMatch(source, /audit write failed[^\n]*(error\.message|error\.stack|JSON\.stringify)/);
});
