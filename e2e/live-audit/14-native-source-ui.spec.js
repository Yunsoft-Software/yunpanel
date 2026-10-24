import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test,expect,manifest,saveManifest,apiCall,waitJob,RUN_DIR,ORIGIN,ready,main } from './support.js';
test.beforeEach(async({context})=>{
 const dist=path.resolve('apps/web/dist');
 await context.route(url=>url.origin===ORIGIN&&!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/tools/'),async route=>{
  const u=new URL(route.request().url());const file=route.request().isNavigationRequest()?path.join(dist,'index.html'):path.join(dist,u.pathname);
  if(!file.startsWith(dist+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return route.continue();
  const type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml'}[path.extname(file)]??'application/octet-stream';
  await route.fulfill({body:fs.readFileSync(file),contentType:type,headers:{'Cache-Control':'no-store'}});
 });
});
function owned(){const m=manifest();expect(m.fixture.provisioningReady).toBe(true);expect(m.fixture.createdWebsiteIds).toContain(m.fixture.websiteId);if(!process.env.YUNPANEL_AUDIT_ACCEPTANCE_SHA)throw new Error('Exact native source identity is required');return m;}
function record(action,data){const m=manifest();m.fixture.operations.push({action,...data,at:new Date().toISOString()});saveManifest(m);}
function check(r,label,status=200){record(label,{status:r.status,code:r.body.error?.code});if (Array.isArray(status)) expect(status,label).toContain(r.status); else expect(r.status,label).toBe(status);return r.data;}
test('@native-ui source mail task opens one dialog, contains keyboard focus and returns focus to its trigger', async ({ page }) => {
 const m = owned();
 await ready(page, '/mail/' + m.fixture.mailDomainId);
 const trigger = main(page).getByRole('button', { name: 'E-posta hesabı oluştur', exact: true }).first();
 await trigger.click();
 const dialog = page.getByRole('dialog');
 await expect(dialog).toHaveCount(1);
 await expect(dialog.getByLabel('Adres', { exact: true })).toBeFocused();
 for (const key of ['Tab', 'Shift+Tab']) for (let step = 0; step < 16; step++) {
   await page.keyboard.press(key);
   expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
 await page.keyboard.press('Escape');
 await expect(dialog).toHaveCount(0);
 await expect(trigger).toBeFocused();
 record('mail.native-keyboard-dialog', { verified: true });
});

test('@native-ui source database export downloads real SQL for the selected owned database', async ({ page }) => {
 const m = owned();
 page.on('response', response => { const url = new URL(response.url()); if (url.pathname.startsWith('/tools/phpmyadmin/')) {
  const request = response.request(), headers = request.headers();
  record('phpmyadmin.actual-tool-response', { path: url.pathname, method: request.method(), status: response.status(),
   ...(response.headers()['content-type']?.includes('text/html') ? { referrerPolicy: response.headers()['referrer-policy'] ?? null } : {}),
   ...(request.method() !== 'GET' ? { origin: headers.origin ?? null, fetchSite: headers['sec-fetch-site'] ?? null } : {}) });
 } });
 await ready(page, '/websites/' + m.fixture.domainId + '/databases');
 const row = main(page).getByRole('row').filter({ hasText: m.fixture.databaseName });
 await row.getByRole('button', { name: 'SQL dışa aktar', exact: true }).click();
 await expect(page).toHaveURL(/\/tools\/phpmyadmin\/index.php\?/);
 const selected = new URL(page.url());
 expect(selected.searchParams.get('db')).toBe(m.fixture.databaseName);
 expect(selected.searchParams.get('route')).toBe('/database/export');
 await expect(page.locator('form#dump, form[name="dump"]')).toBeVisible();
 expect(page.url()).not.toContain('capability');
 record('database.actual-phpmyadmin-export-screen', { verified: true });
 const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.getByRole('button', { name: 'Export', exact: true }).click(),
 ]);
 expect(await download.failure()).toBe(null);
 const destination = path.join(RUN_DIR, 'owned-database-export.sql');
 await download.saveAs(destination); fs.chmodSync(destination, 0o600);
 const bytes = fs.readFileSync(destination), sql = bytes.toString('utf8');
 expect(sql).toContain(m.fixture.databaseName);
 expect(sql).toContain('yp_native_proof');
 expect(sql).toContain(m.runId);
 record('database.actual-phpmyadmin-sql-download', { verified: true, bytes: bytes.length,
   sha256: createHash('sha256').update(bytes).digest('hex') });
});
