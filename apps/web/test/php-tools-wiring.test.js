import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const source = (name) => readFile(new URL(`../src/workspace/${name}`, import.meta.url), 'utf8');
test('PHP overview uses the existing application route and keeps runtime operations', async () => {
  const text = await source('SiteDetailPage.jsx');
  assert.match(text, /tab === 'node' && canManage && .*<SitePhpToolsPanel domainId=\{domain.id\}/);
  assert.match(text, /application\?\.type === 'php' \? 'PHP \/ WordPress'/);
  assert.match(text, /<ApplicationOperations domain=\{domain\} application=\{application\}/);
  assert.match(text, /<EnvironmentPanel key=\{application.id\}/);
});
test('existing File Manager, cron and SSL mounts are unchanged', async () => {
  const text = await source('SiteDetailPage.jsx');
  assert.match(text, /tab === 'files' && <SiteFilesPanel domainId=\{domain.id\}/);
  assert.match(text, /tab === 'cron' && <SiteCronPanel domainId=\{domain.id\}/);
  assert.equal((text.match(/\['cron', 'Zamanlanmış Görevler', 'clock'\]/g) ?? []).length, 2);
  assert.match(text, /<SslOperations key=\{domain.id\}/);
});
test('PHP panel retains session and binding guard plus cleanup', async () => {
  const text = await source('SitePhpToolsPanel.jsx');
  assert.match(text, /resolvePhpToolsAccess\(/); assert.match(text, /generation === sessionVersion\(\)/);
  assert.match(text, /!sessionTransitionPending\(\)/); assert.match(text, /client.dispose\(\)/);
  assert.match(text, /scope.applicationId, scope.unixUser/);
});
test('status panels are independent and have no install/run or periodic poll', async () => {
  const text = await source('SitePhpToolsPanel.jsx');
  assert.match(text, /tool="wordpress"/); assert.match(text, /tool="composer"/);
  assert.match(text, /client.current\?\.load\(tool\)/);
  assert.doesNotMatch(text, /setInterval|setTimeout|\/run|method:\s*['"]POST|dangerouslySetInnerHTML/);
});
test('long plugin/theme inventories are paginated and failed lists are not empty', async () => {
  const text = await source('SitePhpToolsPanel.jsx');
  assert.match(text, /const size = 20/); assert.match(text, /items.slice\(current \* size, \(current \+ 1\) \* size\)/);
  assert.match(text, /Liste alınamadı; boş olduğu varsayılmadı/);
  assert.match(text, /Önceki kontrol; güncel durumu doğrulanmadı/);
});
test('existing site-scoped Files and terminal routes remain usable', async () => {
  const text = await source('SitePhpToolsPanel.jsx');
  assert.match(text, /siteHref\(domainId, 'files'\)/); assert.match(text, /siteHref\(domainId, 'terminal'\)/);
  assert.doesNotMatch(text, /window.location|localStorage|sessionStorage/);
});
test('status routes add a data envelope while preserving legacy top-level fields', async () => {
  const text = await readFile(new URL('../../api/src/website-php-tools-http.js', import.meta.url), 'utf8');
  assert.equal((text.match(/res.json\(\{ \.\.\.status, data: status \}\)/g) ?? []).length, 2);
  for (const path of ['wp-cli/status', 'composer/status']) assert.ok(text.includes(`router.get('/${path}', requirePanelRouteAccess`));
  assert.match(text, /app.use\('\/api\/websites\/:websiteId', router\)/);
});
