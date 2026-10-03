import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  navigationGroups,
  navigationItemActive,
  TOOLS_SETTINGS_GROUPS,
  commandEntries,
} from '../src/workspace/ui/ux-model.js';
import { siteJobs, siteHref } from '../src/workspace/site-model.js';

const source = (relPath) => readFile(new URL(`../src/workspace/${relPath}`, import.meta.url), 'utf8');

// --- 1. Menu Redundancy Elimination & Deprecated Distribution Avoidance ---

test('SettingsPage: categories omit deprecated records tab, keeping only editable settings', async () => {
  const operationsSource = await source('OperationsPages.jsx');

  // Verify categories only contain actual editable settings categories
  assert.match(operationsSource, /const categories = \[\s*\['account', 'Hesap ve erişim'\],\s*\['dns', 'DNS ve SSL'\],\s*\['ai', 'AI sağlayıcıları'\],\s*\['updates', 'Güncellemeler'\],\s*\];/);
  // Verify records is NOT in categories array
  const categoriesBlock = operationsSource.slice(
    operationsSource.indexOf('const categories = ['),
    operationsSource.indexOf('];', operationsSource.indexOf('const categories = [')) + 2
  );
  assert.ok(!categoriesBlock.includes("'records'"), 'Deprecated records tab must not appear in settings navigation tabs');

  // Verify backward compatibility: section === 'records' remains handled for direct URLs and points to Tools & Settings Diagnostics
  assert.match(operationsSource, /\{section === 'records' && <Section title="İşlemler ve kayıtlar"/);
  assert.match(operationsSource, /<LinkButton to="\/tools-settings" icon="settings">Araçlar ve Ayarlar<\/LinkButton>/);
  assert.match(operationsSource, /<LinkButton to="\/jobs" icon="jobs">İşlem geçmişi<\/LinkButton>/);
  assert.match(operationsSource, /<LinkButton to="\/audit" icon="shield">Denetim kayıtları<\/LinkButton>/);
  assert.match(operationsSource, /<LinkButton to="\/logs" icon="file">Günlükler<\/LinkButton>/);
  assert.match(operationsSource, /<LinkButton to="\/servers#server-diagnostics" icon="server">Sunucu tanılama<\/LinkButton>/);
  assert.match(operationsSource, /<LinkButton to="\/applications" icon="code">Uygulama envanteri<\/LinkButton>/);
  assert.match(operationsSource, /<LinkButton to="\/domains" icon="globe">Alan adları ve sertifikalar<\/LinkButton>/);
});

// --- 2. Diagnostics Section Placement in Tools & Settings ---

test('TOOLS_SETTINGS_GROUPS: diagnostics section cleanly contains technical logs, jobs and audit', () => {
  const diagGroup = TOOLS_SETTINGS_GROUPS.find((group) => group.id === 'diagnostics');
  assert.ok(diagGroup, 'Diagnostics group must exist in TOOLS_SETTINGS_GROUPS');
  assert.equal(diagGroup.label, 'Tanılama ve kayıtlar');

  const diagRoutes = diagGroup.items.map(([to]) => to);
  assert.ok(diagRoutes.includes('/jobs'), 'Diagnostics must include /jobs');
  assert.ok(diagRoutes.includes('/audit'), 'Diagnostics must include /audit');
  assert.ok(diagRoutes.includes('/logs'), 'Diagnostics must include technical logs /logs');
  assert.ok(diagRoutes.includes('/servers#server-diagnostics'), 'Diagnostics must include /servers#server-diagnostics');
  assert.ok(diagRoutes.includes('/applications'), 'Diagnostics must include /applications');
  assert.ok(diagRoutes.includes('/domains'), 'Diagnostics must include /domains');
});

// --- 3. Preservation of Legitimate Global and Site-Scoped Entries for Shared Resources ---

test('navigationGroups: legitimate global entry points for shared resources are strictly preserved', () => {
  // Owner global navigation
  const ownerMenu = navigationGroups(true, true)[0].items.map(([to]) => to);
  assert.deepEqual(ownerMenu, [
    '/websites',
    '/mail',
    '/files',
    '/databases',
    '/statistics',
    '/tools-settings',
    '/settings/users',
  ]);

  // Site manager global navigation (site-scoped view of the 4 shared resources)
  const managerMenu = navigationGroups(true, false)[0].items.map(([to]) => to);
  assert.deepEqual(managerMenu, [
    '/websites',
    '/mail',
    '/files',
    '/databases',
    '/statistics',
  ]);

  // Reseller global navigation
  const resellerMenu = navigationGroups(true, false, true)[0].items.map(([to]) => to);
  assert.deepEqual(resellerMenu, [
    '/customers',
    '/websites',
    '/mail',
    '/files',
    '/databases',
    '/statistics',
  ]);

  // Customer global navigation
  const customerMenu = navigationGroups(true, false, false, true)[0].items.map(([to]) => to);
  assert.deepEqual(customerMenu, [
    '/websites',
    '/mail',
    '/files',
    '/databases',
    '/statistics',
  ]);
});

test('siteHref: legitimate site-scoped entry points for shared resources are strictly preserved', () => {
  assert.equal(siteHref('site-1', 'files'), '/websites/site-1/files');
  assert.equal(siteHref('site-1', 'mail'), '/websites/site-1/mail');
  assert.equal(siteHref('site-1', 'databases'), '/websites/site-1/databases');
  assert.equal(siteHref('site-1', 'analytics'), '/websites/site-1/analytics');
  assert.equal(siteHref('site-1', 'statistics'), '/websites/site-1/analytics');
  assert.equal(siteHref('site-1', 'logs'), '/websites/site-1/logs');
});

// --- 4. Technical Logs, Background Jobs and Audit from Relevant Tool Contexts ---

test('siteJobs: correctly includes website-scoped background jobs alongside domain, app and cert jobs', () => {
  const domain = {
    id: 'dom-1',
    serverId: 'local',
    websiteId: 'web-1',
    certificateId: 'cert-1',
  };
  const app = { id: 'app-1' };

  const jobs = [
    { id: 'j1', serverId: 'local', resourceType: 'domain', resourceId: 'dom-1', createdAt: '2026-10-01T10:00:00Z' },
    { id: 'j2', serverId: 'local', resourceType: 'website', resourceId: 'web-1', createdAt: '2026-10-01T11:00:00Z' },
    { id: 'j3', serverId: 'local', resourceType: 'application', resourceId: 'app-1', createdAt: '2026-10-01T12:00:00Z' },
    { id: 'j4', serverId: 'local', resourceType: 'certificate', resourceId: 'cert-1', createdAt: '2026-10-01T13:00:00Z' },
    // Foreign website job on same server
    { id: 'j5', serverId: 'local', resourceType: 'website', resourceId: 'foreign-web', createdAt: '2026-10-01T14:00:00Z' },
    // Foreign server job
    { id: 'j6', serverId: 'remote', resourceType: 'website', resourceId: 'web-1', createdAt: '2026-10-01T15:00:00Z' },
  ];

  const matched = siteJobs(domain, app, jobs);
  const matchedIds = matched.map((j) => j.id);

  assert.ok(matchedIds.includes('j1'), 'Domain job must match');
  assert.ok(matchedIds.includes('j2'), 'Website-scoped job must match domain.websiteId');
  assert.ok(matchedIds.includes('j3'), 'Application job must match');
  assert.ok(matchedIds.includes('j4'), 'Certificate job must match');
  assert.ok(!matchedIds.includes('j5'), 'Foreign website job must not match');
  assert.ok(!matchedIds.includes('j6'), 'Foreign server job must not match');

  // Verify sort order: most recent first
  assert.deepEqual(matchedIds, ['j4', 'j3', 'j2', 'j1']);
});

test('SiteDetailPage: site logs tab integrates LogsPanel, JobsTable and site audit history link', async () => {
  const detailSource = await source('SiteDetailPage.jsx');

  // LogsPanel present for live nginx / node logs
  assert.match(detailSource, /tab === 'logs' && <><LogsPanel application=\{application\} domain=\{domain\} server=\{server\} \/>/);

  // Background jobs table present for site operations
  assert.match(detailSource, /<Section title="Site işlem kayıtları"><CollectionNotice resource=\{jobs\} label="İşlem kayıtları" \/>\{.*<JobsTable jobs=\{scopedJobs\} limit=\{50\} \/>/);

  // Site audit history section present with fail-closed site_manager restriction
  assert.match(detailSource, /\{website\?\.id && !isSiteManager && <Section title="Site denetim kayıtları"/);
  assert.match(detailSource, /to=\{`\/audit\?resourceType=website&resourceId=\$\{encodeURIComponent\(website\.id\)\}`\}/);
});

// --- 5. Query Parameter Support in Audit & Jobs Pages ---

test('AuditPage: initializes search filters from query parameters for seamless deep linking', async () => {
  const auditSource = await source('AuditPage.jsx');

  assert.match(auditSource, /import \{ useSearchParams \} from 'react-router';/);
  assert.match(auditSource, /const \[params\] = useSearchParams\(\);/);
  assert.match(auditSource, /resourceType: params\.get\('resourceType'\) \?\? ''/);
  assert.match(auditSource, /resourceId: params\.get\('resourceId'\) \?\? ''/);
});

test('JobsPage: supports resourceType and resourceId query parameters for targeted inspection', async () => {
  const opsSource = await source('OperationsPages.jsx');

  assert.match(opsSource, /const resourceType = params\.get\('resourceType'\) \?\? '';/);
  assert.match(opsSource, /const resourceId = params\.get\('resourceId'\) \?\? '';/);
  assert.match(opsSource, /\(!resourceType \|\| job\.resourceType === resourceType\)/);
  assert.match(opsSource, /\(!resourceId \|\| job\.resourceId === resourceId\)/);
});

// --- 6. Active State and Search Palette Navigation ---

test('navigationItemActive: /tools-settings is active on all diagnostic routes including /logs', () => {
  assert.equal(navigationItemActive('/tools-settings', '/tools-settings'), true);
  assert.equal(navigationItemActive('/tools-settings', '/jobs'), true);
  assert.equal(navigationItemActive('/tools-settings', '/audit'), true);
  assert.equal(navigationItemActive('/tools-settings', '/logs'), true);
  assert.equal(navigationItemActive('/tools-settings', '/servers'), true);
  assert.equal(navigationItemActive('/tools-settings', '/servers#server-diagnostics'), true);
  assert.equal(navigationItemActive('/tools-settings', '/applications'), true);
  assert.equal(navigationItemActive('/tools-settings', '/domains'), true);

  // Users remains isolated under its own menu item
  assert.equal(navigationItemActive('/tools-settings', '/users'), false);
  assert.equal(navigationItemActive('/tools-settings', '/settings/users'), false);
});

test('commandEntries: owner can discover /logs under Tanılama ve kayıtlar in command palette', () => {
  const entries = commandEntries({ canManage: true, isOwner: true, query: 'günlük' });
  const logsEntry = entries.find((e) => e.to === '/logs');
  assert.ok(logsEntry, 'Command palette must surface /logs when querying günlük');
  assert.equal(logsEntry.detail, 'Tanılama ve kayıtlar');

  // Customer cannot discover /logs from command palette
  const customerEntries = commandEntries({ canManage: true, isCustomer: true, query: 'günlük' });
  assert.ok(!customerEntries.some((e) => e.to === '/logs'), 'Customer must not discover /logs in command palette');
});
