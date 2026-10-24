import fs from 'node:fs';
import path from 'node:path';
import { test, expect, ORIGIN, manifest, ready, main } from './support.js';

test.beforeEach(async ({ context }) => {
  const dist = path.resolve('apps/web/dist');
  await context.route(url => url.origin === ORIGIN && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/tools/'), async route => {
    const url = new URL(route.request().url()), file = route.request().isNavigationRequest() ? path.join(dist, 'index.html') : path.join(dist, url.pathname);
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.continue();
    const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }[path.extname(file)] ?? 'application/octet-stream';
    return route.fulfill({ body: fs.readFileSync(file), contentType, headers: { 'Cache-Control': 'no-store' } });
  });
});
function owned() {
  const m = manifest();
  if (!/^[a-f0-9]{64}$/.test(process.env.YUNPANEL_AUDIT_ACCEPTANCE_SHA ?? '') || !m.fixture.createdDomainIds.includes(m.fixture.domainId)) throw new Error('Exact owned native source fixture required');
  return m.fixture;
}
test('@native-ui mobile keyboard navigation preserves the return filter and asks before discarding an actual hosting draft', async ({ page }) => {
  const target = owned(), returnTo = '/websites?q=tenant'; await page.setViewportSize({ width: 390, height: 1000 });
  await ready(page, '/websites/' + target.domainId + '/hosting?returnTo=' + encodeURIComponent(returnTo));
  const select = page.getByRole('combobox', { name: 'Site aracı', exact: true });
  const body = page.getByLabel('En büyük yükleme boyutu (MB)', { exact: true }); await body.fill('2');
  await select.selectOption('wordpress');
  const dialog = page.getByRole('dialog', { name: 'Kaydedilmemiş değişiklikler var' }); await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
  expect(new URL(page.url()).pathname).toBe('/websites/' + target.domainId + '/hosting'); await expect(body).toHaveValue('2');
  await select.selectOption('wordpress'); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Değişiklikleri bırak', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('/websites/' + target.domainId + '/wordpress\\?'));
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe(returnTo);
  await expect(select).toHaveValue('wordpress');
  await select.press('ArrowUp');
  await expect(page).toHaveURL(new RegExp('/websites/' + target.domainId + '/php\\?'));
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe(returnTo);
  expect(page.auditTraffic.filter(item => item.method === 'PATCH' || item.path.endsWith('/stage') || item.path.endsWith('/activate'))).toEqual([]);
  expect(page.auditErrors).toEqual([]);
});
for (const width of [320, 390, 834, 1440]) {
  test('@native-ui site navigation keeps the actual form reachable and one canonical tool at width ' + width, async ({ page }) => {
    const target = owned(); await page.setViewportSize({ width, height: 1000 });
    await ready(page, '/websites/' + target.domainId + '/hosting');
    const nav = page.getByRole('navigation', { name: 'Site araçları', exact: true });
    const select = nav.getByRole('combobox', { name: 'Site aracı', exact: true });
    if (width <= 600) {
      await expect(select).toBeVisible(); await expect(select).toHaveValue('hosting');
      await expect(nav.getByRole('link')).toHaveCount(0);
      const box = await main(page).getByRole('heading', { name: 'Barındırma ayarları', exact: true }).boundingBox();
      expect(box.y, 'The tool menu must not push the form below the first screen').toBeLessThan(850);
      await select.selectOption('wordpress'); await expect(page).toHaveURL(new RegExp('/websites/' + target.domainId + '/wordpress$'));
      await expect(select).toHaveValue('wordpress'); await page.reload(); await expect(select).toHaveValue('wordpress');
      await select.selectOption('hosting'); await expect(page).toHaveURL(new RegExp('/websites/' + target.domainId + '/hosting$'));
    } else {
      await expect(select).toBeHidden();
      await expect(nav.getByRole('link', { name: 'Barındırma ayarları', exact: true })).toHaveAttribute('aria-current', 'page');
      await nav.getByRole('link', { name: 'WordPress', exact: true }).click();
      await expect(page).toHaveURL(new RegExp('/websites/' + target.domainId + '/wordpress$'));
      await nav.getByRole('link', { name: 'Barındırma ayarları', exact: true }).click();
    }
    await expect(page.getByLabel('En büyük yükleme boyutu (MB)', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    expect(page.auditTraffic.filter(item => item.method === 'PATCH' || item.path.endsWith('/stage') || item.path.endsWith('/activate'))).toEqual([]);
    expect(page.auditErrors).toEqual([]);
  });
}
