import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { SITE_TABS, siteHref } from '../src/workspace/site-model.js';
import { groupSiteTabs, navigationGroups } from '../src/workspace/ui/ux-model.js';
import { workspaceResources } from '../src/workspace/workspace-resources.js';
const source = (name) => readFile(new URL(`../src/workspace/${name}`, import.meta.url), 'utf8');

test('cron is an addressable site tool without losing old URLs', () => {
  assert.equal(siteHref('domain-id', 'cron'), '/websites/domain-id/cron');
  for (const tab of ['overview', 'resources', 'node', 'deploy', 'hosting', 'domains', 'dns', 'ssl', 'files', 'databases', 'mail', 'logs', 'terminal', 'settings']) {
    assert.ok(SITE_TABS.some(([key]) => key === tab)); assert.equal(siteHref('domain-id', tab), `/websites/domain-id/${tab}`);
  }
});
test('cron belongs to Hosting & DNS, not a new workspace group', () => {
  const groups = groupSiteTabs(SITE_TABS);
  assert.deepEqual(groups.map((group) => group.id), ['dashboard', 'hosting', 'mail']);
  assert.ok(groups.find((group) => group.id === 'hosting').tabs.some(([key]) => key === 'cron'));
});
test('cron route requests existing jobs and explicit Website inventory', () => {
  const resources = workspaceResources('/websites/domain-id/cron');
  assert.equal(resources.jobs, true); assert.equal(resources.domains, true); assert.equal(resources.websites, true);
});
test('global Files entry remains present for owner and site manager', () => {
  for (const owner of [true, false]) assert.ok(navigationGroups(true, owner).flatMap((group) => group.items).some(([path]) => path === '/files'));
  assert.equal(workspaceResources('/files').websites, true);
});
test('site route exposes cron links and preserves the actual File Manager mount', async () => {
  const text = await source('SiteDetailPage.jsx');
  assert.match(text, /tab === 'cron' && <SiteCronPanel domainId=\{domain.id\}/);
  assert.equal((text.match(/\['cron', 'Zamanlanmış Görevler', 'clock'\]/g) ?? []).length, 2);
  assert.match(text, /tab === 'files' && <SiteFilesPanel domainId=\{domain.id\}/);
  assert.match(text, /if \(key === 'cron'\) return canManage/);
});
test('native modals keep explicit review and named destructive confirmation', async () => {
  const text = await source('SiteCronPanel.jsx');
  assert.match(text, /editor.review/); assert.match(text, /confirmation=\{removeTarget.name\}/);
  assert.match(text, /Kaydet ve sunucuya uygula/); assert.match(text, /useUnsavedChanges\(isDirty\(editor\)\)/);
});
test('session/Website binding changes and unmount are guarded', async () => {
  const text = await source('SiteCronPanel.jsx');
  assert.match(text, /sessionVersion\(\) === generation/); assert.match(text, /!sessionTransitionPending\(\)/);
  assert.match(text, /instance.dispose\(\)/); assert.match(text, /scope.applicationId, scope.unixUser/);
  assert.match(text, /retained.current\?\.identity !== identity/);
});
test('jobs are observed through existing drawer and only read for polling', async () => {
  const text = await source('SiteCronPanel.jsx');
  assert.match(text, /live.current.observe\(job\)/); assert.match(text, /live.current.updateJob\(job\)/);
  assert.match(text, /client.current\?\.refreshOperation\(\)/); assert.match(text, /<LinkButton to="\/jobs"/);
  assert.doesNotMatch(text, /runJob\(|fetch\(|localStorage|sessionStorage/);
});
test('host evidence and command execution are visibly distinguished', async () => {
  const text = await source('SiteCronPanel.jsx');
  assert.match(text, /komutun başarıyla çalıştığı anlamına gelmez/);
  assert.match(text, /missing_host_file/); assert.match(text, /drifted/); assert.match(text, /Doğrulanmadı/);
  assert.match(text, /sunucunun saat dilimini/);
});
test('other active cron jobs and stale collections block writes, not only buttons', async () => {
  const text = await source('SiteCronPanel.jsx');
  const checks = text.slice(text.indexOf('const canWrite'), text.indexOf('useEffect', text.indexOf('const canWrite')));
  assert.match(checks, /live.current.ready/); assert.match(checks, /live.current.jobs.status === 'ready'/);
  assert.match(checks, /resourceBusy\('website_cron', entry.id\)/);
});
test('clock icon uses the existing navigation component', async () => {
  assert.match(await source('ui/SiteNavigation.jsx'), /cron: 'clock'/);
});
test('cron styling does not change a theme, font or global element', async () => {
  const css = await source('ui/cron-tasks.css');
  assert.doesNotMatch(css, /@import|font-family|background|color\s*:/);
  assert.ok(css.trim().split('\n').every((line) => line.startsWith('.ws-cron-')));
});
