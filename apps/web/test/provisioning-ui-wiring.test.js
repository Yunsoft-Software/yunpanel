import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('site overview binds provisioning recovery to the persistent Website identity', async () => {
  const [site, panel] = await Promise.all([
    readFile(new URL('../src/workspace/SiteDetailPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/ProvisioningRecoveryPanel.jsx', import.meta.url), 'utf8'),
  ]);

  assert.match(site, /ProvisioningRecoveryPanel/);
  assert.match(site, /websiteId=\{website\.id\}/);
  assert.doesNotMatch(site, /ProvisioningRecoveryPanel websiteId=\{domain\.id\}/);

  assert.match(panel, /ConfirmDialog/);
  assert.match(panel, /provisioningConfirmation\(confirm\.action, operation\.operationId/);
  assert.match(panel, /step\.canRetry === true/);
  assert.match(panel, /step\.canCompensate === true/);
  assert.doesNotMatch(panel, /step\.intent|step\.evidence|operation\.resources/);
  assert.doesNotMatch(panel, /window\.prompt|window\.confirm|window\.alert|localStorage|sessionStorage/);
});
