import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD } from '../helpers.js';

const owner = JSON.parse(readFileSync('.local/yunpanel-owner-password-only.json', 'utf8'));
const baseURL = new URL(owner.url).origin;
const preferenceKey = 'yunpanel.ui.preferences.v1';
const themeToggle = 'Gece ve Açık tema arasında geçiş yap';
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
test.use({ baseURL, trace: 'off', screenshot: 'off', video: 'off', actionTimeout: 15_000, navigationTimeout: 30_000 });

test.describe('UX-04 real appearance and personalization', () => {
  test.setTimeout(120_000);

  test.beforeAll(() => {
    const config = Object.fromEntries(readFileSync('.local/test-server.env', 'utf8').split('\n')
      .filter((line) => /^[A-Z_]+=/.test(line)).map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, '')];
      }));
    const resolved = execFileSync('ssh', ['-G', config.YUNPANEL_TEST_SERVER_SSH_ALIAS], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(config.YUNPANEL_TEST_SERVER_HOST.endsWith('.28')
      && resolved.match(/^hostname (.+)$/m)?.[1] === config.YUNPANEL_TEST_SERVER_HOST).toBe(true);
  });

  async function login(page) {
    await page.goto('/');
    const form = page.locator('form.auth-form');
    await expect(form).toBeVisible({ timeout: 30_000 });
    await form.locator('[name="username"]').fill(OWNER_USERNAME);
    try { await form.locator('[name="password"]').fill(OWNER_PASSWORD); }
    catch { throw new Error('Owner password field could not be filled'); }
    await form.locator('button.auth-primary').click();
    await expect(page.locator('.auth-sessionbar')).toContainText(OWNER_USERNAME, { timeout: 30_000 });
    await expect(page.locator('.workspace-shell')).toBeVisible();
  }

  async function appearance(page) {
    const details = page.locator('.ws-appearance');
    await expect(details).toBeVisible();
    if (!(await details.evaluate((element) => element.open))) await details.locator('summary').click();
    await expect(page.locator('#ws-theme-preference')).toBeVisible();
    return { theme: page.locator('#ws-theme-preference'), density: page.locator('#ws-density-preference') };
  }

  const stored = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), preferenceKey);
  const shellColor = (page) => page.locator('.workspace-shell').evaluate((element) => getComputedStyle(element).backgroundColor);

  test.afterEach(async ({ page }) => {
    if (page.isClosed()) return;
    const navigation = page.locator('.ws-sidebar[aria-modal="true"]');
    if (await navigation.count()) await navigation.getByRole('button', { name: 'Menüyü kapat', exact: true }).click();
    const bar = page.locator('.auth-sessionbar');
    if (await bar.isVisible()) {
      await bar.getByRole('button', { name: 'Çıkış yap', exact: true }).click();
      await expect(page.locator('form.auth-form')).toBeVisible({ timeout: 30_000 });
    }
    await page.evaluate((key) => localStorage.removeItem(key), preferenceKey);
  });

  test('a fresh login screen starts dark, changes its real colors and preserves the selected theme after reload', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('form.auth-form')).toBeVisible();
    await expect(page.locator('.auth-brand')).toContainText('YunPanel');
    await expect(page.locator('html')).toHaveAttribute('data-ws-theme', 'dark');
    const dark = await page.locator('.auth-form').evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.getByRole('button', { name: themeToggle, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-ws-theme', 'light');
    const light = await page.locator('.auth-form').evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(light).not.toBe(dark);
    expect((await stored(page)).theme).toBe('light');
    await page.reload();
    await expect(page.locator('form.auth-form')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-ws-theme', 'light');
    expect((await stored(page)).theme).toBe('light');
  });

  test('theme and density persist, native system colors respond, and real tabs synchronize through storage events', async ({ page, context }) => {
    await login(page);
    let controls = await appearance(page);
    const dark = await shellColor(page);
    await controls.theme.selectOption('light');
    await controls.density.selectOption('compact');
    await expect(page.locator('html')).toHaveAttribute('data-ws-theme', 'light');
    await expect(page.locator('html')).toHaveAttribute('data-ws-density', 'compact');
    expect(await shellColor(page)).not.toBe(dark);
    expect(await stored(page)).toEqual({ theme: 'light', density: 'compact' });
    await page.reload();
    await expect(page.locator('.workspace-shell')).toBeVisible();
    controls = await appearance(page);
    await expect(controls.theme).toHaveValue('light');
    await expect(controls.density).toHaveValue('compact');
    await page.emulateMedia({ colorScheme: 'dark' });
    await controls.theme.selectOption('system');
    await expect(page.locator('html')).toHaveAttribute('data-ws-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-ws-theme', 'light');
    const second = await context.newPage();
    try {
      await second.goto('/settings');
      await expect(second.locator('.workspace-shell')).toBeVisible();
      const secondControls = await appearance(second);
      await controls.theme.selectOption('dark');
      await expect(second.locator('html')).toHaveAttribute('data-ws-theme', 'dark');
      await expect(secondControls.theme).toHaveValue('dark');
      await secondControls.theme.selectOption('light');
      await expect(page.locator('html')).toHaveAttribute('data-ws-theme', 'light');
      await expect(controls.theme).toHaveValue('light');
      expect(await stored(page)).toEqual({ theme: 'light', density: 'compact' });
    } finally { await second.close(); }
  });

  test('malformed and unsupported values in real browser storage fall back safely and a UI choice repairs the record', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.name));
    await page.goto('/');
    await expect(page.locator('form.auth-form')).toBeVisible();
    await page.evaluate((key) => localStorage.setItem(key, '{'), preferenceKey);
    await page.reload();
    await expect(page.locator('form.auth-form')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-ws-theme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-ws-density', 'comfortable');
    await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ theme: 'sepia', density: 'giant' })), preferenceKey);
    await page.reload();
    await expect(page.locator('form.auth-form')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-ws-theme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-ws-density', 'comfortable');
    await page.getByRole('button', { name: themeToggle, exact: true }).click();
    expect(await stored(page)).toEqual({ theme: 'light', density: 'comfortable' });
    expect(errors).toEqual([]);
  });

  test('appearance controls remain reachable at 360, 768 and 1280 pixels without horizontal overflow', async ({ page }) => {
    await login(page);
    for (const width of [360, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const menu = page.getByRole('button', { name: 'Ana menüyü aç', exact: true });
      await expect(menu).toBeVisible();
      if (width < 900 && await menu.getAttribute('aria-expanded') !== 'true') await menu.click();
      const controls = await appearance(page);
      await controls.theme.selectOption('light');
      await controls.density.selectOption('compact');
      await expect(page.locator('html')).toHaveAttribute('data-ws-theme', 'light');
      await expect(page.locator('html')).toHaveAttribute('data-ws-density', 'compact');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      expect(overflow, `Horizontal overflow at ${width}px`).toBe(false);
      if (width < 900) await page.locator('.ws-sidebar').getByRole('button', { name: 'Menüyü kapat', exact: true }).click();
    }
  });

  test('the toolbar action label follows a theme selected in appearance preferences', async ({ page }) => {
    await login(page);
    const controls = await appearance(page);
    await controls.theme.selectOption('light');
    await expect(page.locator('html')).toHaveAttribute('data-ws-theme', 'light');
    test.fail(true, 'UX-04-D: Görünüm tercihi değişince üst tema düğmesinin metni güncellenmiyor.');
    await expect(page.getByRole('button', { name: themeToggle, exact: true })).toContainText('Gece Modu', { timeout: 3000 });
  });

  test('the Owner can choose a panel language from settings', async ({ page }) => {
    await login(page);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Ayarlar', exact: true })).toBeVisible();
    test.fail(true, 'UX-04-A: Panel dili seçimi sunulmuyor; metinler Türkçe.');
    await expect(page.getByRole('combobox', { name: /^(Panel dili|Dil|Language)$/i })).toBeVisible({ timeout: 3000 });
  });

  test('the Owner can manage the panel name and login logo from settings', async ({ page }) => {
    await login(page);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Ayarlar', exact: true })).toBeVisible();
    test.fail(true, 'UX-04-B: Panel marka/ad/logo ve giriş ekranı özelleştirme yönetimi bulunmuyor.');
    await expect(page.getByRole('button', { name: /^(Marka ayarları|Logo değiştir|Marka ve logo)$/i })
      .or(page.getByRole('link', { name: /^(Marka ayarları|Marka ve logo)$/i }))).toBeVisible({ timeout: 3000 });
  });

  test('the Owner can manage custom navigation links from settings', async ({ page }) => {
    await login(page);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Ayarlar', exact: true })).toBeVisible();
    test.fail(true, 'UX-04-C: Kullanıcı tanımlı panel menü bağlantısı yönetimi bulunmuyor.');
    await expect(page.getByRole('button', { name: /^(Özel bağlantı ekle|Bağlantı ekle)$/i })
      .or(page.getByRole('link', { name: /^Özel bağlantılar$/i }))).toBeVisible({ timeout: 3000 });
  });
});
