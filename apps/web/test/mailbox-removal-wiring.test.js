import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const source = (file) => readFile(new URL(`../src/workspace/${file}`, import.meta.url), 'utf8');
const [list, panel, flow] = await Promise.all([source('MailboxesPanel.jsx'), source('MailboxRemovalPanel.jsx'), source('mailbox-removal-controller.js')]);

// Source wiring checks only, not React rendering or browser acceptance.
test('delete entry is visible beside existing mailbox actions and preserves their forms', () => {
  assert.match(list, />Sil…<\/Button>/);
  for (const action of ['setCreating(true)', 'setPasswordFor(mailbox)', 'setSelected((current)', 'setMailboxEnabled']) assert.ok(list.includes(action));
  for (const name of ['MailboxCreateModal', 'PasswordModal', 'PolicyPanel']) assert.ok(list.includes(`<${name}`));
  assert.match(list, /domain.managementMode === 'local'/);
});

test('parent selection is actor scoped before rendering and is not discarded when mailbox leaves the list', () => {
  assert.match(list, /JSON\.stringify\(\[domain.id, session\?\.user\?\.id, session\?\.user\?\.role, sessionVersion\(\), canManage\]\)/);
  assert.match(list, /removing\?\.scope === removalScope && <MailboxRemovalPanel/);
  const entry = list.slice(list.indexOf('{removing?.scope'), list.indexOf('{creating && <MailboxCreateModal'));
  assert.doesNotMatch(entry, /mailboxes.some/);
});

test('new flow is lifetime scoped and uses the existing authenticated transport', () => {
  assert.match(panel, /request: panelRequest/);
  assert.match(panel, /version === sessionVersion\(\) && !sessionTransitionPending\(\)/);
  assert.match(panel, /flow.dispose\(\)/);
  assert.match(panel, /const timer = setTimeout\(\(\) => \{ void client.current\?\.refresh\(\); \}, 2000\)/);
  assert.doesNotMatch(panel, /setTimeout[^\n]*(?:confirm|prepare)\(/);
});

test('explicit confirmations preserve the exact current backend token', () => {
  assert.match(panel, /confirmation=\{approval.data.confirmation\}/);
  assert.match(panel, /confirm\(approval, approval.data.confirmation\)/);
  assert.match(flow, /approval !== state.approval/);
  assert.match(flow, /signature\(view\) !== approval.snapshot/);
});

test('selected-account preparation replaces domain-wide shutdown and retains return paths', () => {
  assert.match(panel, /<MailboxAccessPreparation mailbox=\{mailbox\} domain=\{domain\}/);
  assert.doesNotMatch(panel, /diğer posta hesapları da etkilenir|Etkin — silmeden önce kapatılmalı/);
  assert.match(panel, /href\('configuration'\)/);
  assert.match(panel, /href\('aliases'\)/);
  assert.match(panel, /onClick=\{onPolicy\}/);
  assert.match(panel, /Hesap kaydı henüz kaldırılmadı/);
  assert.match(panel, /state.status === 'deleted' && !notified.current/);
});

test('no legacy metadata-only fallback, policy cleanup or alternate transport is added', () => {
  assert.match(flow, /method: 'DELETE', body: approval.data/);
  assert.match(flow, /deleteJobId: state.receipt.id/);
  for (const content of [panel, flow]) assert.doesNotMatch(content, /localStorage|sessionStorage|console\.|fetch\(|clearMailbox|setMailboxEnabled/);
  assert.match(flow, /ticket = null; publish\(\{ status: 'sending', job: null \}\)/);
});
