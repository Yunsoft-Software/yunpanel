import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Source integration checks, not React render or browser acceptance.
const source = (name) => readFile(new URL(`../src/workspace/${name}`, import.meta.url), 'utf8');
const [page, result, submission] = await Promise.all([
  source('NewWebsitePage.jsx'), source('SiteCreateResult.jsx'), source('site-create-submission.js'),
]);
test('form identity is bound to parent, user, role and session generation', () => {
  assert.match(page, /JSON\.stringify\(\[parentId, session\?\.user\?\.id, session\?\.user\?\.role, sessionVersion\(\)\]\)/);
  assert.match(page, /<WebsiteForm key=\{identity\} parentId=\{parentId\}/);
});
test('effect creates a fresh controller and disposes exactly that scope on cleanup', () => {
  assert.match(page, /useEffect\(\(\) => \{[\s\S]*const flow = createSiteSubmission/);
  assert.match(page, /return \(\) => \{ flow.dispose\(\); controller.abort\(\); \}/);
  assert.match(page, /version === sessionVersion\(\) && !sessionTransitionPending\(\)/);
});
test('created and uncertain states replace the create form without discarding their result', () => {
  assert.match(page, /submission.created \|\| submission.phase === 'uncertain' \? <SiteCreateResult state=\{submission\}/);
  assert.match(page, /const baseLocked = busy \|\| finishedAttempt/);
  assert.match(page, /current.flow.submit\(input, \{ signal: current.signal \}\)/);
  assert.doesNotMatch(page, /setCreated\(\{ \.\.\.result.primaryDomain/);
});
test('password field clears after confirmed record or uncertain create without entering result state', () => {
  assert.match(page, /if \(state.created \|\| state.phase === 'uncertain'\) \{\s+setDirty\(false\);\s+setForm\(\(value\) => \(\{ \.\.\.value, adminPassword: '' \}\)\)/);
  assert.match(page, /useUnsavedChanges\(dirty && !finishedAttempt\)/);
  assert.doesNotMatch(submission, /localStorage|sessionStorage|console\.|\.\.\.result|\.\.\.domain/);
});
test('real overview recovery and files use Domain ID, never Website ID', () => {
  assert.match(result, /siteHref\(domain.id, 'overview'\)/);
  assert.match(result, /siteHref\(domain.id, 'files'\)/);
  assert.doesNotMatch(result, /siteHref\(domain.websiteId/);
  assert.match(result, /Web sitelerini kontrol et/);
  assert.match(result, /<ErrorNotice error=\{state.error\}/);
});
test('progress uses actual step states and existing components without invented fractions', () => {
  assert.match(result, /failed: 'Başarısız', blocked: 'Engel var'/);
  assert.match(result, /compensated: 'Geri alındı'/);
  assert.match(result, /<KeyValues items=\{state.steps.map/);
  assert.match(result, /const busy = siteSubmissionBusy\(state\)/);
  assert.doesNotMatch(result, /#[a-f0-9]{6}|[0-9] \/ [0-9]|retry_exhausted|state.ready \? '.*Webmail/);
});
test('shared-site explicit confirmation and scoped domain API remain available', () => {
  assert.match(page, /sharedDomainCreateInput\(/);
  assert.match(page, /confirmation: sharedWebsiteConfirmation\(input.primaryDomain, input.websiteId\)/);
  assert.match(page, /panelRequest\('\/domains',/);
  assert.match(page, /onConfirm=\{confirmSharedSite\}/);
  assert.match(page, /body: sharedConfirmation.input, signal: current.signal/);
});
