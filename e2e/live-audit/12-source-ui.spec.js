import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test, expect, ORIGIN, RUN_DIR, main, manifest } from './support.js';

// Candidate UI over the real authenticated .28 API. No API response is mocked
// and no bundle is deployed; evidence explicitly identifies this source lane.
const dist = path.resolve('apps/web/dist');
test.beforeEach(async ({ context }) => {
  await context.route((url) => url.origin === ORIGIN && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/tools/'), async (route) => {
    const request = route.request(), url = new URL(request.url());
    let file = request.isNavigationRequest() ? path.join(dist, 'index.html') : path.join(dist, url.pathname);
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.continue();
    const contentType = ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(file)] ?? 'application/octet-stream';
    await route.fulfill({ body: fs.readFileSync(file), contentType, headers: { 'Cache-Control': 'no-store' } });
  });
});

test('candidate PHP has actual settings and a single WordPress destination', async ({ page }) => {
  const m = manifest();
  await page.goto(`/websites/${m.existingPhpDomainId}/php`);
  await expect(main(page).getByRole('heading', { name: 'PHP Ayarları', exact: true })).toBeVisible();
  await expect(page.getByLabel('Bellek sınırı (MB)')).toBeVisible();
  await expect(page.getByLabel('Çalışma süresi (saniye)')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Site araçları' }).getByRole('link', { name: 'WordPress', exact: true })).toHaveCount(1);
  await expect(main(page).getByText('Başlangıç komutu', { exact: true })).toHaveCount(0);
  await expect(main(page).getByText('PHP / WordPress', { exact: true })).toHaveCount(0);
  expect(page.auditErrors).toEqual([]);
});

test('candidate legacy PHP node link redirects and browser history remains usable', async ({ page }) => {
  const m = manifest();
  await page.goto('/websites');
  await page.goto(`/websites/${m.existingPhpDomainId}/node`);
  await expect(page).toHaveURL(new RegExp(`/websites/${m.existingPhpDomainId}/php$`));
  await page.goBack(); await expect(page).toHaveURL(/\/websites$/);
  await page.goForward(); await expect(page.getByLabel('Bellek sınırı (MB)')).toBeVisible();
});

for (const tool of ['ssl', 'cron', 'backup', 'backups', 'logs', 'php', 'access', 'wordpress']) {
  test(`candidate direct /${tool} loads real site choices`, async ({ page }) => {
    await page.goto('/' + tool);
    await expect(main(page)).toBeVisible();
    await expect(main(page).getByRole('heading', { name: 'Site listesi doğrulanamadı' })).toHaveCount(0);
    await expect(main(page).locator('a[href^="/websites/"]').first()).toBeVisible();
    expect(page.auditTraffic.some((entry) => entry.path === '/api/panel/websites' && entry.status === 200)).toBe(true);
    expect(page.auditTraffic.some((entry) => entry.path === '/api/panel/domains' && entry.status === 200)).toBe(true);
    expect(page.auditErrors).toEqual([]);
  });
}

for (const width of [320, 390, 834, 1440]) {
  test(`candidate compact site list at ${width}px has readable shortcuts and no overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/websites?q=' + encodeURIComponent(manifest().existingPhpDomain));
    await expect(main(page).locator('.ws-website-task-card').first()).toBeVisible();
    await expect(main(page).locator('.ws-website-task-quick').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const card = main(page).locator('.ws-website-task-card').filter({ has: page.getByRole('heading', { name: manifest().existingPhpDomain, exact: true }) });
    await card.getByRole('button', { name: 'Tüm araçlar', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Araçları daralt', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(card.getByRole('link', { name: /Yedekleme/ })).toBeVisible();
  });
}

test('candidate optional site login has native validation, unique descriptions and preserves the draft across wizard steps', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 }); await page.goto('/websites/new');
  await page.getByLabel('Alan adı', { exact: true }).fill('yp2-login-design.157.180.11.28.sslip.io');
  await page.getByLabel('Site sahibi', { exact: true }).selectOption('new_admin');
  const email = page.getByLabel('Yönetici e-posta adresi', { exact: true });
  const password = page.getByLabel('Yönetici parolası', { exact: true });
  await expect(email).toHaveAttribute('autocomplete', 'email');
  await expect(password).toHaveAttribute('autocomplete', 'new-password');
  await expect(password).toHaveAttribute('minlength', '12');
  expect(await email.evaluate(input => input.checkValidity())).toBe(false);
  const descriptions = await Promise.all([email.getAttribute('aria-describedby'), password.getAttribute('aria-describedby')]);
  expect(descriptions[0]).not.toBe(descriptions[1]);
  for (const id of descriptions) expect(await page.evaluate(value => Boolean(document.getElementById(value)?.textContent), id)).toBe(true);
  await email.fill('design@example.com'); await password.fill('UI fixture password 123!');
  await main(page).getByRole('button', { name: 'Devam et', exact: true }).click();
  await expect(page.getByLabel('Site türü', { exact: true })).toBeVisible();
  await main(page).getByRole('button', { name: 'Geri', exact: true }).click();
  await expect(email).toHaveValue('design@example.com'); await expect(password).toHaveValue('UI fixture password 123!');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

for (const [path, heading, action] of [['/customers', 'Müşteriler', 'Müşteri ekle'], ['/resellers', 'Bayiler', 'Bayi ekle']]) {
  test(`candidate Owner ${path} has its own task screen and one accessible creation form`, async ({ page }) => {
    await page.goto(path);
    await expect(main(page).getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await main(page).getByRole('button', { name: action, exact: true }).click();
    const dialog = page.getByRole('dialog'); await expect(dialog).toHaveCount(1);
    await expect(dialog.getByLabel('Kullanıcı adı', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('İlk parola', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Rol', { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Hesabı oluştur', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Vazgeç', exact: true }).click();
    await expect(dialog).toHaveCount(0); expect(page.auditErrors).toEqual([]);
  });
}

test('candidate hosting opens the actual settings form once and keeps advanced site management separate', async ({ page }) => {
  const m = manifest(); await page.goto(`/websites/${m.existingPhpDomainId}/hosting`);
  await expect(main(page).getByRole('heading', { name: 'Barındırma ayarları', exact: true })).toBeVisible();
  await expect(main(page).getByRole('button', { name: 'Kaydet ve uygula', exact: true })).toBeVisible();
  await expect(main(page).getByRole('link', { name: 'Yayın yönetimine git', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(page.auditErrors).toEqual([]);
});

for (const width of [320, 390, 834, 1440]) {
  test(`candidate site creation at ${width}px has three steps, a usable PHP default and no mandatory Git or extra login`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 }); await page.goto('/websites/new');
    await expect(page.getByLabel('Site sahibi', { exact: true })).toHaveValue('owner');
    await expect(page.getByLabel('Yönetici parolası', { exact: true })).toHaveCount(0);
    await page.getByLabel('Alan adı', { exact: true }).fill('yp2-design.157.180.11.28.sslip.io');
    await main(page).getByRole('button', { name: 'Devam et', exact: true }).click();
    await expect(page.getByLabel('Site türü', { exact: true })).toHaveValue('new_php');
    await expect(page.getByLabel('GitHub repository', { exact: true })).toHaveCount(0);
    await main(page).getByRole('button', { name: 'Devam et', exact: true }).click();
    await expect(main(page).getByRole('heading', { name: 'Son kontrol ve kurulum', exact: true })).toBeVisible();
    await expect(main(page).getByRole('button', { name: 'Siteyi oluştur', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await main(page).getByRole('button', { name: 'Geri', exact: true }).click();
    await expect(page.getByLabel('Site türü', { exact: true })).toHaveValue('new_php');
    expect(page.auditTraffic.some(entry => entry.method === 'POST' && /\/sites(?:\/|$)/.test(entry.path))).toBe(false);
    expect(page.auditErrors).toEqual([]);
  });
}

test.afterAll(() => {
  fs.writeFileSync(path.join(RUN_DIR, 'candidate-ui-identity.json'), JSON.stringify({
    sourceLane: 'local production bundle with live .28 API', deployed: false, target: '157.180.11.28',
    indexSha256: createHash('sha256').update(fs.readFileSync(path.join(dist, 'index.html'))).digest('hex'), testedAt: new Date().toISOString(),
  }, null, 2), { mode: 0o600 });
});
