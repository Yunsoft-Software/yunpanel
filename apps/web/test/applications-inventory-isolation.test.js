import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  navigationGroups,
  navigationItemActive,
  TOOLS_SETTINGS_GROUPS,
  commandEntries,
} from '../src/workspace/ui/ux-model.js';

const source = (relPath) => readFile(new URL(`../src/workspace/${relPath}`, import.meta.url), 'utf8');

// --- 1. Global Application Page as Owner Diagnostic Inventory Only ---

test('ApplicationsPage: acts strictly as an Owner diagnostic inventory without operational controls', async () => {
  const appPageSource = await source('ApplicationsPage.jsx');

  // Breadcrumb navigation points to Tools & Settings -> Diagnostics
  assert.match(appPageSource, /<Link to="\/tools-settings">Araçlar ve Ayarlar<\/Link>/);
  assert.match(appPageSource, /<span>Tanılama<\/span>/);
  assert.match(appPageSource, /<span>Uygulama envanteri<\/span>/);

  // Title and description specify diagnostic inventory
  assert.match(appPageSource, /title="Uygulama envanteri"/);
  assert.match(appPageSource, /Owner tanılama envanteri/);

  // Standalone creation form NewApplication is removed; create prop redirects to /websites/new
  assert.match(appPageSource, /if \(create\) return <Navigate to="\/websites\/new" replace \/>;/);
  assert.doesNotMatch(appPageSource, /function NewApplication/);
  assert.doesNotMatch(appPageSource, /<LinkButton to="\/applications\/new"/);

  // Operational controls are removed from global inventory (runJob, rollback modal, Env editor)
  assert.doesNotMatch(appPageSource, /runJob\(/);
  assert.doesNotMatch(appPageSource, /<EnvironmentPanel/);
  assert.doesNotMatch(appPageSource, /ConfirmDialog.*rollback/);
  assert.doesNotMatch(appPageSource, />Deploy<\/Button>/);
  assert.doesNotMatch(appPageSource, />Restart<\/Button>/);

  // Rows link to site workspace or /websites
  assert.match(appPageSource, /siteHref\(boundDomain\.id/);
  assert.match(appPageSource, />\s*Siteye git\s*<\/LinkButton>/);
  assert.match(appPageSource, />\s*Web sitelerine git\s*<\/LinkButton>/);
});

// --- 2. Site Operations Removes Stray Global Applications Link ---

test('SiteOperations: empty application state keeps user in site context without linking to global applications', async () => {
  const siteOpsSource = await source('SiteOperations.jsx');

  // Must not link to global /applications in daily site operations
  assert.doesNotMatch(siteOpsSource, /<Link to="\/applications">/);
  assert.doesNotMatch(siteOpsSource, /Uygulama yönetimine git/);

  // Must retain site-scoped fallback navigation
  assert.match(siteOpsSource, /siteHref\(domain\?\.id, 'overview'\)/);
  assert.match(siteOpsSource, /Site genel bakışına dön/);
});

// --- 3. Navigation Hierarchy & Role Isolation ---

test('Navigation: applications is never in daily user menus, only in Owner diagnostics', () => {
  // Daily menus must never include /applications
  for (const [canManage, isOwner, isReseller, isCustomer] of [
    [true, true, false, false],   // Owner daily menu
    [true, false, false, false],  // Site manager daily menu
    [true, false, true, false],   // Reseller daily menu
    [true, false, false, true],   // Customer daily menu
  ]) {
    const dailyPaths = navigationGroups(canManage, isOwner, isReseller, isCustomer)
      .flatMap((g) => g.items)
      .map(([to]) => to);
    assert.ok(!dailyPaths.includes('/applications'), 'Applications must never be in daily navigation menu');
  }

  // Diagnostics in Tools & Settings includes /applications as Uygulama envanteri
  const diagGroup = TOOLS_SETTINGS_GROUPS.find((g) => g.id === 'diagnostics');
  assert.ok(diagGroup);
  const appItem = diagGroup.items.find(([to]) => to === '/applications');
  assert.ok(appItem);
  assert.equal(appItem[1], 'Uygulama envanteri');

  // Active state: /applications activates Tools & Settings
  assert.equal(navigationItemActive('/tools-settings', '/applications'), true);
});
