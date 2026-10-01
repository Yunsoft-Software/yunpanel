import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('site overview binds provisioning recovery to the persistent Website identity', async () => {
  const [site, panel, flow] = await Promise.all([
    readFile(new URL('../src/workspace/SiteDetailPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/ProvisioningRecoveryPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/provisioning-recovery.js', import.meta.url), 'utf8'),
  ]);

  assert.match(site, /ProvisioningRecoveryPanel/);
  assert.match(site, /websiteId=\{website\.id\}/);
  assert.doesNotMatch(site, /ProvisioningRecoveryPanel websiteId=\{domain\.id\}/);

  assert.match(panel, /ConfirmDialog/);
  assert.match(flow, /confirmation = `\$\{action\}-site-provisioning:\$\{operationId\}/);
  assert.match(flow, /approval !== state\.approval/);
  assert.match(flow, /stamp\(latest\) !== approval\.snapshot/);
  assert.match(panel, /perform\(approval, approval\.confirmation\)/);
  assert.match(panel, /provisioningRemediation\(item\)/);
  assert.match(flow, /step\?\.canRetry === true/);
  assert.match(panel, /canManage && item\.canRetry/);
  assert.match(flow, /step\?\.canCompensate === true/);
  assert.match(panel, /canManage && item\.canCompensate/);
  assert.doesNotMatch(panel, /step\.intent|step\.evidence|operation\.resources/);
  assert.doesNotMatch(panel, /window\.prompt|window\.confirm|window\.alert|localStorage|sessionStorage/);
});
