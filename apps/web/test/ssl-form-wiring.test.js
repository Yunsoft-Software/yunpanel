import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../src/workspace/SiteOperations.jsx', import.meta.url), 'utf8');
const ssl = source.slice(source.indexOf('export function SslOperations'));

test('SSL reads the actual panel session, not a missing workspace field or global settings', () => {
  assert.match(source, /import \{ usePanelSession \} from '\.\.\/panel-session.jsx'/);
  assert.match(ssl, /const \{ session \} = usePanelSession\(\)/);
  assert.doesNotMatch(ssl, /\{[^\n}]*session[^\n}]*\} = useWorkspace/);
  assert.doesNotMatch(source, /getPanelSettings|system-settings-client|dnsSsl\.acmeEmail/);
});
test('form identity changes across actor, site and session generation before rendering input', () => {
  assert.match(source, /import \{ sessionVersion \} from '\.\.\/session-client.js'/);
  assert.match(ssl, /<SslOperationForm key=\{sslDraftKey\(domain, session, sessionVersion\(\)\)\} domain=\{domain\} session=\{session\}/);
  assert.match(ssl, /useReducer\(sslRequestDraftReducer, defaultEmail, createSslRequestDraft\)/);
});
test('all input changes use the reducer and late defaults use the non-overwriting action', () => {
  assert.match(ssl, /dispatchDraft\(\{ type: 'email-default', email: defaultEmail \}\)/);
  assert.match(ssl, /onChange=\{\(event\) => edit\('email', event.target.value\)\}/);
  for (const field of ['includeWww', 'includeWebmail', 'includeMail', 'assignToMail', 'includeWildcard']) {
    assert.ok(ssl.includes(`edit('${field}', e.target.checked)`), field);
  }
  assert.doesNotMatch(ssl, /setRequested|setEmail|setIncludeWww|Boolean\(email.trim\(\)\)/);
});
test('unsaved changes are real draft differences, not populated defaults or server jobs', () => {
  assert.match(ssl, /const dirty = sslDraftDirty\(draft\)/);
  assert.match(ssl, /useUnsavedChanges\(!domain.certificateId && dirty\)/);
  assert.doesNotMatch(ssl, /useUnsavedChanges\([^\n]*busy/);
});
test('reset is explicit, disabled during work, and confirmation cancellation preserves the draft', () => {
  assert.match(ssl, /disabled=\{locked \|\| !dirty\} onClick=\{\(\) => dispatchDraft\(\{ type: 'reset' \}\)\}/);
  assert.match(ssl, /onCancel=\{\(\) => setConfirm\(null\)\}/);
  assert.match(ssl, /confirmation=\{domain.primaryDomain\}/);
});
test('email validation happens before a mutation and both request buttons share validation', () => {
  const issue = ssl.slice(ssl.indexOf('async function issue'), ssl.indexOf('return <Section'));
  assert.ok(issue.indexOf('!validSslContactEmail(submitted.email)') < issue.indexOf('await panelRequest('));
  assert.match(issue, /if \(!canIssue\) return/);
  assert.match(ssl, /const locked = !canManage \|\| operation.busy/);
  assert.equal((ssl.match(/disabled=\{!canIssue \|\| !validSslContactEmail\(email\)\}/g) ?? []).length, 2);
  assert.match(ssl, /type="email"[^>]*required[^>]*aria-describedby=\{emailHintId\}/);
});
test('submitted intent is captured before async preparation and only real completion acknowledges it', () => {
  const issue = ssl.slice(ssl.indexOf('async function issue'), ssl.indexOf('return <Section'));
  assert.ok(issue.indexOf('sslDraftSnapshot(draft)') < issue.indexOf('await operation.perform'));
  assert.ok(issue.indexOf('buildRequestedDomains(submitted)') < issue.indexOf('await operation.perform'));
  assert.match(issue, /email: submitted.email/);
  assert.match(issue, /assignToMail: submitted.assignToMail/);
  assert.match(issue, /if \(ok\) \{\s+if \(!staging && completed\) dispatchDraft\(\{ type: 'submitted', values: submitted \}\)/);
  assert.ok(issue.indexOf("finished?.status === 'succeeded'") < issue.indexOf('completed = true'));
  assert.ok(issue.indexOf('await waitForJob(postActivate.id)') < issue.indexOf('completed = true'));
});
test('scope controls and existing domain/job/renewal paths stay present without invented engines', () => {
  for (const value of ['/update-preview', '/certificates/issue', '/stage', '/activate', '/renew', 'previewDigest: preview.previewDigest', 'confirmation: preview.confirmation', 'dryRun: true', 'dryRun: false']) assert.ok(ssl.includes(value), value);
  assert.match(ssl, /Korunacak alan adları:/);
  assert.match(ssl, /domain.aliases.join\(', '\)/);
  assert.doesNotMatch(ssl, /Plesk Obsidian standardı|localStorage|sessionStorage|\.github\/workflows/);
  assert.match(source, /export function ApplicationOperations/);
  assert.match(source, /export function DomainOperations/);
});
