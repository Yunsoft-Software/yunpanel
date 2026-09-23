import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Source checks supplement controller tests; they are not React rendering tests.
const source = (path) => readFile(new URL(`../src/workspace/${path}`, import.meta.url), 'utf8');
const [panel, client, controller] = await Promise.all([
  source('ProvisioningRecoveryPanel.jsx'), source('provisioning-client.js'), source('provisioning-recovery.js'),
]);
test('recovery component scope changes with website, user, role, session and capability', () => {
  assert.match(panel, /JSON\.stringify\(\[websiteId, session\?\.user\?\.id, session\?\.user\?\.role, sessionVersion\(\), canManage\]\)/);
  assert.match(panel, /<RecoveryPanel key=\{identity\}/);
  assert.match(panel, /version === sessionVersion\(\) && !sessionTransitionPending\(\)/);
  assert.match(panel, /return \(\) => \{ flow.dispose\(\)/);
});
test('existing API helpers receive cancellation without altering confirmation bodies or automatic sequence', () => {
  assert.match(client, /continueWebsiteProvisioning\(operationId, \{ signal \} = \{\}\)/);
  for (const name of ['retryWebsiteProvisioningStep', 'compensateWebsiteProvisioningStep']) {
    assert.ok(client.includes(`${name}(operationId, provisioningStepId, { signal } = {})`));
  }
  assert.equal((client.match(/\.\.\.\(signal \? \{ signal \} : \{\}\)/g) ?? []).length, 3);
  for (const action of ['continue', 'retry', 'compensate']) assert.ok(client.includes(`confirmation: provisioningConfirmation('${action}', id`));
  assert.match(client, /return advanceProvisioning\(/);
});
test('refresh is read-only and old data cannot enable buttons', () => {
  assert.match(panel, /const available = canManage && state.status === 'ready' && !busy/);
  assert.match(panel, /onClick=\{\(\) => client.current\?\.load\(\)\}/);
  assert.equal((panel.match(/disabled=\{!available\}/g) ?? []).length, 3);
  assert.match(panel, /Son doğrulanmış kayıt/);
  assert.match(panel, /<ErrorNotice error=\{error\}/);
});
test('confirmation comes from captured approval, never a retargeted current operation', () => {
  assert.match(panel, /confirmation=\{approval.confirmation\}/);
  assert.match(panel, /perform\(approval, approval.confirmation\)/);
  assert.doesNotMatch(panel, /provisioningConfirmation\(.*operation.operationId/);
  assert.match(controller, /approval !== state.approval/);
});
test('all recovery actions, step diagnostics and backend change refresh remain wired', () => {
  for (const action of ['continue', 'retry', 'compensate']) assert.ok(panel.includes(`prepare('${action}'`));
  assert.match(panel, /provisioningRemediation\(item\)/);
  assert.match(panel, /<details><summary>Teknik bilgiler/);
  assert.match(panel, /state.changes > 0/);
  assert.match(panel, /getLatestWebsiteProvisioning\(websiteId, options\)/);
});
test('no raw storage, secret dumps or alternate transport was added', () => {
  for (const value of [panel, controller]) assert.doesNotMatch(value, /localStorage|sessionStorage|console\.|fetch\(|setTimeout/);
  assert.match(controller, /const latest = recoveryOperation\(value, websiteId\)/);
  assert.match(controller, /stamp\(latest\) !== approval.snapshot/);
});
