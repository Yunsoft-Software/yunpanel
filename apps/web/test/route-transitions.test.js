import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  normalizeSiteTab,
  safeReturnHref,
  siteHref,
} from '../src/workspace/site-model.js';
import { resolveSiteToolEntry } from '../src/workspace/site-tool-entry-model.js';
import { navigationItemActive } from '../src/workspace/ui/ux-model.js';
import { siteListFilterParams, clearSiteListFilters } from '../src/workspace/website-task-model.js';

const source = (path) => readFile(new URL(`../src/workspace/${path}`, import.meta.url), 'utf8');

// --- 1. Tab Normalization & Deep Link Fallbacks ---

test('normalizeSiteTab: normalizes all legacy and variant deep link aliases to canonical tabs', () => {
  // Analytics / Statistics
  assert.equal(normalizeSiteTab('statistics'), 'analytics');
  assert.equal(normalizeSiteTab('stats'), 'analytics');
  assert.equal(normalizeSiteTab('analytics'), 'analytics');

  // Cron / Scheduled Tasks
  assert.equal(normalizeSiteTab('scheduled-tasks'), 'cron');
  assert.equal(normalizeSiteTab('tasks'), 'cron');
  assert.equal(normalizeSiteTab('crons'), 'cron');
  assert.equal(normalizeSiteTab('task'), 'cron');
  assert.equal(normalizeSiteTab('cron'), 'cron');

  // Backup / Restore
  assert.equal(normalizeSiteTab('backups'), 'backup');
  assert.equal(normalizeSiteTab('restore'), 'backup');
  assert.equal(normalizeSiteTab('restores'), 'backup');
  assert.equal(normalizeSiteTab('backup-restore'), 'backup');
  assert.equal(normalizeSiteTab('backup'), 'backup');

  // Git / Deploy
  assert.equal(normalizeSiteTab('git'), 'deploy');
  assert.equal(normalizeSiteTab('deploy'), 'deploy');
  assert.equal(normalizeSiteTab('deployment'), 'deploy');

  // Access / SFTP / SSH
  assert.equal(normalizeSiteTab('sftp'), 'access');
  assert.equal(normalizeSiteTab('ssh'), 'access');
  assert.equal(normalizeSiteTab('access-accounts'), 'access');
  assert.equal(normalizeSiteTab('security'), 'access');
  assert.equal(normalizeSiteTab('access'), 'access');

  // PHP / WordPress
  assert.equal(normalizeSiteTab('wp'), 'php');
  assert.equal(normalizeSiteTab('wordpress'), 'php');
  assert.equal(normalizeSiteTab('php'), 'php');

  // Files
  assert.equal(normalizeSiteTab('file-manager'), 'files');
  assert.equal(normalizeSiteTab('file'), 'files');
  assert.equal(normalizeSiteTab('files'), 'files');

  // Databases
  assert.equal(normalizeSiteTab('database'), 'databases');
  assert.equal(normalizeSiteTab('databases'), 'databases');
  assert.equal(normalizeSiteTab('db'), 'databases');

  // Mail
  assert.equal(normalizeSiteTab('mail'), 'mail');
  assert.equal(normalizeSiteTab('mailbox'), 'mail');
  assert.equal(normalizeSiteTab('mailboxes'), 'mail');
  assert.equal(normalizeSiteTab('email'), 'mail');

  // SSL
  assert.equal(normalizeSiteTab('ssl'), 'ssl');
  assert.equal(normalizeSiteTab('certificate'), 'ssl');
  assert.equal(normalizeSiteTab('certificates'), 'ssl');
  assert.equal(normalizeSiteTab('ssl-tls'), 'ssl');

  // Logs
  assert.equal(normalizeSiteTab('log'), 'logs');
  assert.equal(normalizeSiteTab('logs'), 'logs');

  // Node / App
  assert.equal(normalizeSiteTab('node'), 'node');
  assert.equal(normalizeSiteTab('application'), 'node');
  assert.equal(normalizeSiteTab('app'), 'node');

  // Settings & Config
  assert.equal(normalizeSiteTab('settings'), 'settings');
  assert.equal(normalizeSiteTab('configuration'), 'settings');
  assert.equal(normalizeSiteTab('config'), 'settings');

  // DNS
  assert.equal(normalizeSiteTab('dns'), 'dns');
  assert.equal(normalizeSiteTab('dns-records'), 'dns');

  // Domains
  assert.equal(normalizeSiteTab('domains'), 'domains');
  assert.equal(normalizeSiteTab('alias'), 'domains');

  // Unknown fallback
  assert.equal(normalizeSiteTab('non-existent-tab'), 'overview');
  assert.equal(normalizeSiteTab(''), 'overview');
  assert.equal(normalizeSiteTab(null), 'overview');
  assert.equal(normalizeSiteTab(undefined), 'overview');
});

test('siteHref: safely produces canonical links with tab normalization', () => {
  assert.equal(siteHref('dom-123', 'statistics'), '/websites/dom-123/analytics');
  assert.equal(siteHref('dom-123', 'file-manager'), '/websites/dom-123/files');
  assert.equal(siteHref('dom-123', 'scheduled-tasks'), '/websites/dom-123/cron');
  assert.equal(siteHref('dom-123', 'unknown'), '/websites/dom-123/overview');
  assert.equal(siteHref('dom-123', 'overview'), '/websites/dom-123/overview');
  assert.equal(siteHref('dom-123'), '/websites/dom-123/overview');
  assert.equal(siteHref(null, 'files'), '/websites');
});

// --- 2. Safe Return URL Sanitation ---

test('safeReturnHref: prevents open redirects while preserving valid internal panel paths', () => {
  // Valid internal paths
  assert.equal(safeReturnHref('/websites'), '/websites');
  assert.equal(safeReturnHref('/websites/dom-1/files?path=src'), '/websites/dom-1/files?path=src');
  assert.equal(safeReturnHref('/databases?site=xyz'), '/databases?site=xyz');
  assert.equal(safeReturnHref('/mail'), '/mail');
  assert.equal(safeReturnHref('/customers'), '/customers');

  // Open redirects and external URLs -> rejected, returns fallback
  assert.equal(safeReturnHref('https://evil.com'), '/websites');
  assert.equal(safeReturnHref('http://attacker.com/steal'), '/websites');
  assert.equal(safeReturnHref('//evil.com/phish'), '/websites');
  assert.equal(safeReturnHref('javascript:alert(1)'), '/websites');
  assert.equal(safeReturnHref('data:text/html,hack'), '/websites');
  assert.equal(safeReturnHref(''), '/websites');
  assert.equal(safeReturnHref(null), '/websites');
  assert.equal(safeReturnHref(undefined), '/websites');
  assert.equal(safeReturnHref({}, '/fallback'), '/fallback');
  assert.equal(safeReturnHref('relative/path/no/slash', '/fallback'), '/fallback');
});

// --- 3. Functional Site Tool Entry Resolution ---

test('resolveSiteToolEntry: supports all 12 tools and resolves domain ID / domain name queries', () => {
  const site1 = { id: 'site-uuid-1', serverId: 'srv-1', runtimeType: 'php' };
  const domain1 = { id: 'domain-uuid-1', websiteId: 'site-uuid-1', serverId: 'srv-1', primaryDomain: 'example.com' };
  const ready = (items) => ({ status: 'ready', items });

  // Resolving by domain.id
  const byDomainId = resolveSiteToolEntry({
    tool: 'cron',
    websites: ready([site1]),
    domains: ready([domain1]),
    canManage: true,
    requestedSiteId: 'domain-uuid-1',
  });
  assert.equal(byDomainId.state, 'ready');
  assert.equal(byDomainId.target.href, '/websites/domain-uuid-1/cron');

  // Resolving by domain.primaryDomain (domain name)
  const byDomainName = resolveSiteToolEntry({
    tool: 'backup',
    websites: ready([site1]),
    domains: ready([domain1]),
    canManage: true,
    requestedSiteId: 'example.com',
  });
  assert.equal(byDomainName.state, 'ready');
  assert.equal(byDomainName.target.href, '/websites/domain-uuid-1/backup');

  // Resolving by site.id
  const bySiteId = resolveSiteToolEntry({
    tool: 'ssl',
    websites: ready([site1]),
    domains: ready([domain1]),
    canManage: true,
    requestedSiteId: 'site-uuid-1',
  });
  assert.equal(bySiteId.state, 'ready');
  assert.equal(bySiteId.target.href, '/websites/domain-uuid-1/ssl');

  // Resolving all supported tools
  for (const tool of ['mail', 'databases', 'statistics', 'analytics', 'backup', 'backups', 'cron', 'scheduled-tasks', 'logs', 'php', 'access', 'ssl']) {
    const res = resolveSiteToolEntry({
      tool,
      websites: ready([site1]),
      domains: ready([domain1]),
      canManage: true,
    });
    assert.equal(res.state, 'ready');
    assert.ok(res.target.href.startsWith('/websites/domain-uuid-1/'));
  }
});

// --- 4. Navigation Item Active Highlighting for Route Aliases ---

test('navigationItemActive: highlights active navigation item for legacy aliases', () => {
  // Statistics aliases
  assert.equal(navigationItemActive('/statistics', '/stats'), true);
  assert.equal(navigationItemActive('/statistics', '/analytics'), true);
  assert.equal(navigationItemActive('/statistics', '/stats?site=1'), true);

  // Files aliases
  assert.equal(navigationItemActive('/files', '/file-manager'), true);
  assert.equal(navigationItemActive('/files', '/file'), true);
  assert.equal(navigationItemActive('/files', '/file?path=src'), true);

  // Mail aliases
  assert.equal(navigationItemActive('/mail', '/email'), true);
  assert.equal(navigationItemActive('/mail', '/mailboxes'), true);
  assert.equal(navigationItemActive('/mail', '/mailbox'), true);

  // Databases aliases
  assert.equal(navigationItemActive('/databases', '/database'), true);
  assert.equal(navigationItemActive('/databases', '/db'), true);

  // Negative checks
  assert.equal(navigationItemActive('/files', '/databases'), false);
  assert.equal(navigationItemActive('/mail', '/websites'), false);
});

// --- 5. Filter Parameters Cleanup & Alias Handling ---

test('siteListFilterParams: cleans up legacy parameter aliases when filters update', () => {
  const initial = new URLSearchParams('search=old&query=test&state=active&sort=desc');
  const updated = siteListFilterParams(initial, 'q', 'new-term');
  assert.equal(updated.get('q'), 'new-term');
  assert.equal(updated.has('search'), false);
  assert.equal(updated.has('query'), false);
  assert.equal(updated.get('sort'), 'desc');

  const cleared = clearSiteListFilters(new URLSearchParams('q=term&search=s&query=q&type=static&status=active&state=draft&page=2&custom=keep'));
  assert.equal(cleared.has('q'), false);
  assert.equal(cleared.has('search'), false);
  assert.equal(cleared.has('query'), false);
  assert.equal(cleared.has('status'), false);
  assert.equal(cleared.has('state'), false);
  assert.equal(cleared.has('page'), false);
  assert.equal(cleared.get('custom'), 'keep');
});

// --- 6. Source Wiring & Lossless State Transition Verification ---

test('source: WorkspaceApp wires RedirectWithSearch and compatibility routes', async () => {
  const appSrc = await source('WorkspaceApp.jsx');
  assert.match(appSrc, /function RedirectWithSearch\(\{ to \}\)/);
  assert.match(appSrc, /path: 'file-manager', element: <RedirectWithSearch to="\/files" \/>/);
  assert.match(appSrc, /path: 'stats', element: <RedirectWithSearch to="\/statistics" \/>/);
  assert.match(appSrc, /path: 'analytics', element: <RedirectWithSearch to="\/statistics" \/>/);
  assert.match(appSrc, /path: 'email', element: <RedirectWithSearch to="\/mail" \/>/);
  assert.match(appSrc, /path: 'database', element: <RedirectWithSearch to="\/databases" \/>/);
  assert.match(appSrc, /path: 'cron', element: manage\(<SiteToolEntryPage tool="cron" \/>\)/);
  assert.match(appSrc, /path: 'scheduled-tasks', element: <RedirectWithSearch to="\/cron" \/>/);
  assert.match(appSrc, /path: 'backup', element: manage\(<SiteToolEntryPage tool="backup" \/>\)/);
  assert.match(appSrc, /path: 'ssl', element: manage\(<SiteToolEntryPage tool="ssl" \/>\)/);
  assert.match(appSrc, /isOwner && !params\.has\('site'\) \? ownerView : <SiteToolEntryPage/);
});

test('source: SiteDetailPage handles domain resolution fallback and URL canonicalization', async () => {
  const siteDetailSrc = await source('SiteDetailPage.jsx');
  assert.match(siteDetailSrc, /safeReturnHref/);
  assert.match(siteDetailSrc, /window\.history\.replaceState/);
  assert.match(siteDetailSrc, /domains\.items\.find\(\(item\) => item\.websiteId === websiteId/);
  assert.match(siteDetailSrc, /domains\.items\.find\(\(item\) => item\.primaryDomain\?\.toLowerCase\(\) === websiteId\?\.toLowerCase\(\)\)/);
});

test('source: FilesPanel synchronizes searchParams for path, file, query, hidden, sort, and back/forward', async () => {
  const filesPanelSrc = await source('FilesPanel.jsx');
  assert.match(filesPanelSrc, /validRelativePath/);
  assert.match(filesPanelSrc, /searchParams\.get\('path'\)/);
  assert.match(filesPanelSrc, /searchParams\.get\('file'\)/);
  assert.match(filesPanelSrc, /targetPath !== lastLoadedPath\.current/);
  assert.match(filesPanelSrc, /next\.set\('file', entry\.name\)/);
  assert.match(filesPanelSrc, /next\.delete\('file'\)/);
});
