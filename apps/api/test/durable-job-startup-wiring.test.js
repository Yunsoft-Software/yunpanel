import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexUrl = new URL('../src/index.js', import.meta.url);

test('production API shares one durable job registry across HTTP, scheduler and local execution', async () => {
  const source = await readFile(indexUrl, 'utf8');
  assert.match(source, /import \{ createDurableJobRegistry \} from '\.\/durable-job-registry\.js';/);
  assert.match(source, /const durableJobRegistry = createDurableJobRegistry\(\{[\s\S]*?filePath: jobStorePath,[\s\S]*?registryFactory: createJobRegistry,[\s\S]*?automaticReconciliation: true,[\s\S]*?\}\);/);
  assert.match(source, /const jobRegistry = createAuditedJobRegistry\(\{[\s\S]*?registry: durableJobRegistry,/);
  assert.equal((source.match(/createDurableJobRegistry\(/g) ?? []).length, 1);
  assert.match(source, /createHandler: \(\) => createApp\(\{[\s\S]*?\n\s*jobRegistry,/);
  assert.match(source, /startConfiguredLocalRuntime\(\{[\s\S]*?jobRegistry,/);
  assert.match(source, /startCertificateRenewalScheduler\(\{[\s\S]*?\n\s*certificateRegistry,[\s\S]*?\n\s*jobRegistry,[\s\S]*?\n\s*dnsProviderCredentialRegistry,/);
});
