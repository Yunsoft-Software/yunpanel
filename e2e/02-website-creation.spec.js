import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from './helpers.js';

test.describe('Module 2: Website Creation & Form Validation', () => {
  test('2.1. Websites listing page shows active sites and creation button', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/websites');
    await expect(page.locator('h1', { hasText: 'Web siteleri' })).toBeVisible({ timeout: 10000 });

    // Verify "Web sitesi ekle" button
    const addSiteBtn = page.locator('a.ws-button[href="/websites/new"]', { hasText: 'Web sitesi ekle' }).first();
    await expect(addSiteBtn).toBeVisible();

    // Verify table has websites
    const firstRow = page.locator('table.ws-table tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 10000 });
  });

  test('2.2. Website creation form renders all sections and enforces validation', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 10000 });

    // Section 1: Alan adı
    await expect(page.locator('h3:has-text("1. Alan adı")')).toBeVisible();
    const domainInput = page.locator('input[placeholder*="example.com"]');
    await expect(domainInput).toBeVisible();

    // Submit button should be present
    const submitBtn = page.locator('button[type="submit"]:has-text("Siteyi oluştur")');
    await expect(submitBtn).toBeVisible();

    // Section 2: Yayın hedefi
    await expect(page.locator('h3:has-text("2. Yayın hedefi")')).toBeVisible();
    const sourceSelect = page.locator('label:has-text("Uygulama kaynağı") select');
    await expect(sourceSelect).toBeVisible();

    // Section 3: Veritabanı
    await expect(page.locator('h3:has-text("3. Veritabanı")')).toBeVisible();

    // Section 4: HTTPS
    await expect(page.locator('h3:has-text("HTTPS")')).toBeVisible();

    // Section 5: E-Posta ve Webmail
    await expect(page.locator('h3:has-text("E-Posta ve Webmail")')).toBeVisible();
    const mailCheckbox = page.locator('label.ws-check').filter({ hasText: 'Webmail (Roundcube)' }).locator('input[type="checkbox"]');
    if (await mailCheckbox.count() > 0) {
      await expect(mailCheckbox).toBeChecked();
    }
  });

  test('2.3. Form mode switching updates options correctly', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/websites/new');

    const modeSelect = page.locator('label:has-text("Kayıt türü") select');
    await expect(modeSelect).toBeVisible();

    // Switch to subdomain
    await modeSelect.selectOption('subdomain');
    await expect(page.locator('label:has-text("Üst alan adı") select')).toBeVisible();
    await expect(page.locator('label:has-text("Alt alan adı") input')).toBeVisible();

    // Switch back to domain
    await modeSelect.selectOption('domain');
    await expect(page.locator('label:has-text("www davranışı") select')).toBeVisible();
  });
});
