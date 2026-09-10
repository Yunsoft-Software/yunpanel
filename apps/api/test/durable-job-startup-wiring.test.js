import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexUrl = new URL('../src/index.js', import.meta.url);

test('production API shares one durable job registry across HTTP, scheduler and local execution', async () => {
  const source = await readFile(indexUrl, 'utf8');
  assert.match(source, /import \{ createDurableJobRegistry \} from '\.\/durable-job-registry\.js';/);
  assert.match(source, /const jobRegistry = createDurableJobRegistry\(\{ filePath: jobStorePath, registryFactory: createJobRegistry \}\);/);
  assert.equal((source.match(/const jobRegistry =/g) ?? []).length, 1);
  assert.match(source, /createApp\(\{ registry, domainRegistry, jobRegistry,/);
  assert.match(source, /startConfiguredLocalRuntime\(\{[\s\S]*?jobRegistry,/);
  assert.match(source, /startCertificateRenewalScheduler\(\{ certificateRegistry, jobRegistry,/);
});
