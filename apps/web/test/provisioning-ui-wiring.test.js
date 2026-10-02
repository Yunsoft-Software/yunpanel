import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('site overview binds provisioning recovery to the persistent Website identity', async () => {
  const [site, panel, client] = await Promise.all([
    readFile(new URL('../src/workspace/SiteDetailPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/ProvisioningRecoveryPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/provisioning-client.js', import.meta.url), 'utf8'),
  ]);

  assert.match(site, /ProvisioningRecoveryPanel/);
  assert.match(site, /websiteId=\{website\.id\}/);
  assert.doesNotMatch(site, /ProvisioningRecoveryPanel websiteId=\{domain\.id\}/);

  assert.match(panel, /ConfirmDialog/);
  assert.match(client, /export function provisioningConfirmation\(action, operationId/);
  assert.match(panel, /provisioningRemediation\(step\)/);
  assert.match(panel, /step\.canRetry === true/);
  assert.match(panel, /step\.canCompensate === true/);
  assert.doesNotMatch(panel, /step\.intent|step\.evidence|operation\.resources/);
  assert.doesNotMatch(panel, /window\.prompt|window\.confirm|window\.alert|localStorage|sessionStorage/);
});
