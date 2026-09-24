import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const source = (name) => readFile(new URL(`../src/workspace/${name}`, import.meta.url), 'utf8');
const [page, panel, workspace, controller] = await Promise.all([
  source('SiteOperations.jsx'), source('SslRenewalPanel.jsx'), source('WorkspaceContext.jsx'), source('ssl-renewal.js'),
]);
// These source wiring checks are not React/browser rendering tests.
test('renewal remains mounted while inventory refreshes or certificate state changes', () => {
  assert.match(page, /\{domain.certificateId \? <SslRenewalPanel/);
  assert.match(page, /JSON.stringify\(\[domain.id, domain.certificateId, domain.serverId, domain.websiteId, session\?\.user\?\.id, session\?\.user\?\.role, sessionVersion\(\)\]\)/);
  assert.doesNotMatch(page, /setConfirm\('renew'\)|\/renew`/);
});
test('existing issuance contact defaults, drafts and explicit production confirmation stay connected', () => {
  assert.match(page, /useUnsavedChanges\(!domain.certificateId && dirty\)/);
  assert.match(page, /const defaultEmail = sslContactEmail\(session\)/);
  assert.match(page, /sslDraftSnapshot\(draft\)/);
  assert.match(page, /confirm === 'issue' && <ConfirmDialog/);
  assert.match(page, /certificates\/issue/);
});
test('existing job drawer remains accessible and terminal plus verified metadata refresh shared inventories', () => {
  assert.match(panel, /callbacks.current.observe\(state.job\)/);
  assert.match(panel, /callbacks.current.updateJob\(state.job\)/);
  assert.match(panel, /callbacks.current.refreshAll\(\)/);
  assert.match(panel, /\[state.terminalVersion, state.syncVersion\]/);
  assert.match(workspace, /sslJobRefresh\(Object.values\(tracked\)\)/);
  assert.match(workspace, /domains.refresh\(\); websites.refresh\(\); certificates.refresh\(\)/);
});
test('status polling and result re-read never dispatch another POST', () => {
  assert.match(panel, /setTimeout\(\(\) => \{ void flow.current\?\.refresh\(\); \}, 2000\)/);
  assert.match(panel, /if \(!\['waiting', 'syncing'\].includes\(state.status\)\)/);
  assert.equal((controller.match(/method: 'POST'/g) ?? []).length, 1);
  assert.match(controller, /body: \{ dryRun: approval.dryRun \}/);
});
test('session and permission gates plus exact captured confirmation guard the existing endpoint', () => {
  assert.match(panel, /version === sessionVersion\(\) && !sessionTransitionPending\(\)/);
  assert.match(panel, /client.dispose\(\)/);
  assert.match(panel, /confirmation=\{approval.confirmation\}/);
  assert.match(controller, /approval !== state.approval/);
  assert.match(controller, /check\(true\); requireValue\(canStart\(\) === true\)/);
});
test('success text requires complete verified state and shows actual dates and fingerprints without theme changes', () => {
  assert.match(panel, /state.status === 'complete' && OUTCOMES\[state.outcome\]/);
  assert.match(panel, /formatDate\(state.certificate.validTo\)/);
  assert.match(panel, /state.before.fingerprint256/);
  assert.match(panel, /state.certificate.fingerprint256/);
  assert.doesNotMatch(panel, /#[a-fA-F0-9]{6}|fontFamily|localStorage|sessionStorage/);
});
