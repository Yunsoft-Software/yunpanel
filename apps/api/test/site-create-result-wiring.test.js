import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Run web result wiring test suite as baseline
import '../../web/test/site-create-result-wiring.test.js';

const source = (file) => readFile(new URL(file, import.meta.url), 'utf8');

test('API site-create HTTP routes enforce panel route access and strict body validation', async () => {
  const code = await source('../src/site-create-http.js');

  // Verify requirePanelRouteAccess guard on all create and recovery routes
  assert.match(code, /app\.post\('\/api\/sites\/create-preview',\s*requirePanelRouteAccess/);
  assert.match(code, /app\.post\('\/api\/sites',\s*requirePanelRouteAccess/);
  assert.match(code, /app\.post\('\/api\/sites\/hosted\/create-preview',\s*requirePanelRouteAccess/);
  assert.match(code, /app\.post\('\/api\/sites\/hosted',\s*requirePanelRouteAccess/);
  assert.match(code, /app\.post\('\/api\/sites\/hosted\/recover-reservation',\s*requirePanelRouteAccess/);
  assert.match(code, /app\.post\('\/api\/sites\/recover-reservation',\s*requirePanelRouteAccess/);

  // Exact body validators
  assert.match(code, /const PREVIEW_FIELDS = new Set\(\['input'\]\)/);
  assert.match(code, /const APPLY_FIELDS = new Set\(\['input', 'previewDigest', 'confirmation'\]\)/);
  assert.match(code, /const HOSTED_PREVIEW_FIELDS = new Set\(\['customerId', 'input'\]\)/);
  assert.match(code, /const HOSTED_APPLY_FIELDS = new Set\(\['customerId', 'input', 'previewDigest', 'confirmation'\]\)/);
});

test('API site-create HTTP preserves 201/200 response with provisioningError when provisioning fails', async () => {
  const code = await source('../src/site-create-http.js');

  // Standard site creation handles provisioning errors without failing 201/200 create
  assert.match(code, /provisioningError = Object\.freeze\(\{/);
  assert.match(code, /code: err\?\.code \?\? 'provisioning_registration_failed'/);
  assert.match(code, /response\.status\(result\.created \? 201 : 200\)\.json\(\{/);
  assert.match(code, /\.\.\.result,/);
  assert.match(code, /\.\.\.\(provisioning \? \{ provisioning \} : \{\}\),/);
  assert.match(code, /\.\.\.\(provisioningError \? \{ provisioningError \} : \{\}\),/);

  // Hosted site creation handles provisioning errors similarly
  assert.match(code, /response\.status\(result\.created \? 201 : 200\)\.json\(\{[\s\S]*?\.\.\.result,[\s\S]*?\.\.\.\(provisioningError \? \{ provisioningError \} : \{\}\)/);
});

test('hosting site create service preserves verified website and allocation when provisioning registration fails', async () => {
  const serviceCode = await source('../src/hosting-site-create-service.js');

  // Re-verifies website persistence before completing allocation
  assert.match(serviceCode, /const website = await websiteRegistry\.getWebsite\(reserved\.websiteId\)/);
  assert.match(serviceCode, /if \(!website\) \{[\s\S]*?hosting_site_persistence_unverified/);
  assert.match(serviceCode, /const allocation = allocations\.complete\(rawToken, policy, prepared\.allocationInput, website\)/);

  // Captures provisioning failure into provisioningError with failed stage, keeping provisioningReady false
  assert.match(serviceCode, /stage = 'provisioning_registration_failed'/);
  assert.match(serviceCode, /code: err\?\.code \?\? 'provisioning_registration_failed'/);
  assert.match(serviceCode, /provisioningReady = Boolean\(provisioning\?\.ready\)/);
  assert.match(serviceCode, /stage,[\s\S]*?provisioningReady,[\s\S]*?\.\.\.\(provisioningError \? \{ provisioningError \} : \{\}\)/);
});

test('web site-create-submission preserves steps and created site on provisioning failure, timeout, and interrupted states', async () => {
  const subCode = await source('../../web/src/workspace/site-create-submission.js');

  // Includes interrupted in STEP_STATES
  assert.match(subCode, /STEP_STATES = new Set\(\['pending', 'applying', 'succeeded', 'failed', 'blocked', 'interrupted', 'compensating', 'compensated'\]\)/);

  // expectedResult captures initialSteps from preview
  assert.match(subCode, /initialSteps = parsed\.steps/);
  assert.match(subCode, /initialSteps: Object\.freeze\(initialSteps\)/);

  // Preserves steps when result.provisioningError is encountered
  assert.match(subCode, /if \(result\.provisioningError\) \{/);
  assert.match(subCode, /\.\.\.\(initialSteps\.length > 0 \? \{ steps: initialSteps \} : \{\}\)/);

  // Preserves steps and created record on catch (timeout, bad response, network failure)
  assert.match(subCode, /let recoveredSteps = state\.steps/);
  assert.match(subCode, /\.\.\.\(recoveredSteps\?\.length \? \{ steps: recoveredSteps \} : \{\}\)/);

  // Never leaks raw responses or forbidden objects
  assert.doesNotMatch(subCode, /localStorage|sessionStorage|console\.|\.\.\.result|\.\.\.domain/);
});

test('SiteCreateResult component uses Domain-ID for navigation and labels interrupted state without fake readiness', async () => {
  const resultCode = await source('../../web/src/workspace/SiteCreateResult.jsx');

  // Uses Domain ID for overview and files links, never Website ID
  assert.match(resultCode, /siteHref\(domain\.id, 'overview'\)/);
  assert.match(resultCode, /siteHref\(domain\.id, 'files'\)/);
  assert.doesNotMatch(resultCode, /siteHref\(domain\.websiteId/);

  // Supports interrupted state label alongside failed and blocked
  assert.match(resultCode, /interrupted: 'Kesintiye uğradı'/);
  assert.match(resultCode, /failed: 'Başarısız', blocked: 'Engel var'/);

  // Separates registration success from running service success
  assert.match(resultCode, /Kayıt oluşturma ile servislerin çalışır duruma gelmesi ayrı aşamalardır\./);
  assert.match(resultCode, /Site kaydı korundu\. Tamamlanmayan veya doğrulanamayan adımları Genel Bakış bölümünden inceleyin\./);
  assert.match(resultCode, /Kurulum planındaki zorunlu adımlar tamamlandı\. Yayın, SSL ve posta durumunu ilgili site araçlarından doğrulayın\./);
});

test('SiteCreateResult and shared-site result containers wire keyboard focus, screen reader live regions, and theme focus styles', async () => {
  const resultCode = await source('../../web/src/workspace/SiteCreateResult.jsx');
  const pageCode = await source('../../web/src/workspace/NewWebsitePage.jsx');
  const consoleCss = await source('../../web/src/workspace/ui/console-theme.css');
  const emberCss = await source('../../web/src/workspace/ui/ember-theme.css');

  // Accessible focus and screen reader regions on SiteCreateResult
  assert.match(resultCode, /ref=\{resultRef\}/);
  assert.match(resultCode, /tabIndex=\{-1\}/);
  assert.match(resultCode, /aria-live="polite"/);
  assert.match(resultCode, /aria-atomic="true"/);
  assert.match(resultCode, /resultRef\.current\?\.focus\(\)/);

  // Shared site connection also receives accessible focus and live announcement
  assert.match(pageCode, /ref=\{sharedResultRef\}/);
  assert.match(pageCode, /sharedResultRef\.current\?\.focus\(\)/);

  // Theme styling ensures keyboard focus indication in both themes
  assert.match(consoleCss, /\.ws-site-create-result:focus/);
  assert.match(consoleCss, /\.ws-site-create-result:focus-visible/);
  assert.match(emberCss, /\.workspace-shell \.ws-site-create-result:focus/);
  assert.match(emberCss, /\.workspace-shell \.ws-site-create-result:focus-visible/);
});

test('NewWebsitePage and site-create-submission guarantee password clearing and zero memory retention on create, error, and abort', async () => {
  const pageCode = await source('../../web/src/workspace/NewWebsitePage.jsx');
  const subCode = await source('../../web/src/workspace/site-create-submission.js');

  // Password cleared on confirmed created, uncertain, error, and catch
  assert.match(pageCode, /if \(state\.created \|\| state\.phase === 'uncertain'\) \{\s+setDirty\(false\);\s+setForm\(\(value\) => \(\{ \.\.\.value, adminPassword: '' \}\)\);\s+\} else if \(state\.phase === 'error' \|\| state\.error\) \{\s+setForm\(\(value\) => \(\{ \.\.\.value, adminPassword: '' \}\)\);/);
  assert.match(pageCode, /setForm\(\(value\) => \(\{ \.\.\.value, adminPassword: '' \}\)\);\s*\}\s*finally \{ pending\.current = false; \}/);

  // StrictMode effect unmount cleanup disconnects controller and flow without leaking into new mount
  assert.match(pageCode, /return \(\) => \{ flow\.dispose\(\); controller\.abort\(\); \};/);
  assert.match(subCode, /if \(!disposed && isCurrent\(\) === true\) \{\s+onState\(state\);\s+\}/);
});
