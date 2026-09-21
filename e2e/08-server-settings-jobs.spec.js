import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from './helpers.js';

test.describe('Module 8: Server, System Settings & Jobs', () => {
  test('8.1. Server Overview & Managed Services on /servers', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    await page.goto('/servers');
    await expect(page.locator('h1:has-text("Sunucu")')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=YunPanel yalnızca kurulu olduğu yerel sunucuyu yönetir')).toBeVisible();

    // Verify server metrics / summary cards
    const summaryCard = page.locator('article');
    await expect(summaryCard).toBeVisible({ timeout: 10000 });
    await expect(summaryCard).toContainText('CPU');
    await expect(summaryCard).toContainText('Bellek');
    await expect(summaryCard).toContainText('Disk');
    await expect(summaryCard).toContainText('Ubuntu');

    // Verify Managed Services panel and Root Terminal exist
    await expect(page.locator('h2:has-text("Sistem servisleri")')).toBeVisible();
    await expect(page.locator('h2:has-text("Sunucu terminali")')).toBeVisible();
    await expect(page.locator('text=Owner root PTY')).toBeVisible();
  });

  test('8.2. System Settings & Architectural Policies on /settings', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    await page.goto('/settings');
    await expect(page.locator('h1:has-text("Ayarlar")')).toBeVisible({ timeout: 10000 });

    // Verify Account & Access section
    await expect(page.locator('h2:has-text("Hesap ve erişim")')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('a[href="/settings/users"]:has-text("Kullanıcıları yönet")')).toBeVisible();

    // Verify Panel & Server section
    await expect(page.locator('h2:has-text("Panel ve sunucu")')).toBeVisible();
    await expect(page.locator('text=YunPanel v')).toBeVisible();
    await expect(page.locator('text=Yerel yönetim (Agentless Root)')).toBeVisible();

    // Verify Site Defaults & Isolation section
    await expect(page.locator('h2:has-text("Site varsayılanları ve izolasyon")')).toBeVisible();
    await expect(page.locator('text=Site başına bağımsız Unix kullanıcısı ve grubu')).toBeVisible();
  });

  test('8.3. Jobs History & Filter Lifecycle on /jobs', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    await page.goto('/jobs');
    await expect(page.locator('h1:has-text("İşler")')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Sunucuda sıraya alınan ve tamamlanan işlemler')).toBeVisible();

    // Verify filter controls
    const searchInput = page.locator('.ws-filter-search input');
    await expect(searchInput).toBeVisible({ timeout: 10000 });

    const statusSelect = page.locator('label:has-text("Durum") select');
    await expect(statusSelect).toBeVisible();

    // Filter by succeeded
    await statusSelect.selectOption('succeeded');

    // Filter by all
    await statusSelect.selectOption('all');

    // Verify table or empty state or pagination footer
    const jobsContent = page.locator('table.ws-table, .ws-empty, .ws-pagination');
    await expect(jobsContent.first()).toBeVisible({ timeout: 10000 });
  });
});
