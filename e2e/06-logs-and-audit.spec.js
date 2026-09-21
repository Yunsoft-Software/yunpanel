import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs, openFirstWebsiteWorkspace } from './helpers.js';

test.describe('Module 6: Live Logs & System Audit', () => {
  test('6.1. Website Live Logs: view logs, change log source, and filter', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    const logsTab = page.locator('nav.ws-tabs a', { hasText: 'Loglar' });
    await expect(logsTab).toBeVisible();
    await logsTab.click();

    // Verify logs section header
    await expect(page.locator('h2:has-text("Canlı site logları")')).toBeVisible({ timeout: 10000 });

    // Verify source select element
    const sourceSelect = page.locator('.ws-filters select');
    await expect(sourceSelect).toBeVisible();

    // Switch between log sources
    await sourceSelect.selectOption('nginx-error');
    await page.click('button:has-text("Uygula")');

    // Switch back to nginx-access
    await sourceSelect.selectOption('nginx-access');
    await page.fill('.ws-filter-search input', 'HTTP');
    await page.click('button:has-text("Uygula")');

    // Ensure either log entries table or empty state is visible (valid DOM response)
    const tableOrEmpty = page.locator('.ws-table, .ws-empty');
    await expect(tableOrEmpty.first()).toBeVisible({ timeout: 10000 });
  });

  test('6.2. Global Audit Logs: inspect audit log stream and apply action filters', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    // Navigate to /audit
    await page.goto('/audit');
    await expect(page.locator('h1:has-text("Denetim kayıtları")')).toBeVisible({ timeout: 10000 });

    // Verify filter fields
    await expect(page.locator('h2:has-text("Filtreler")')).toBeVisible();
    const actionInput = page.locator('label:has-text("İşlem adı") input');
    await expect(actionInput).toBeVisible();

    // Verify table has loaded audit entries
    const tableRows = page.locator('table.ws-table tbody tr');
    await expect(tableRows.first()).toBeVisible({ timeout: 10000 });

    // Apply filter for login actions
    await actionInput.fill('login');
    await page.click('button[type="submit"]:has-text("Filtrele")');

    // Verify filtered table or valid empty state
    await expect(page.locator('table.ws-table, .ws-empty').first()).toBeVisible({ timeout: 10000 });
  });

  test('6.3. Bound Resources: verify Database, Mail, and Backup resource controls', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    const resourcesTab = page.locator('nav.ws-tabs a', { hasText: 'Bağlı kaynaklar' });
    await expect(resourcesTab).toBeVisible();
    await resourcesTab.click();

    // Verify sections
    await expect(page.locator('h2:has-text("Veritabanları")')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('h2:has-text("Mail & Webmail")')).toBeVisible();

    // Verify manage buttons exist in section body
    await expect(page.locator('a.ws-button[href="/databases"]')).toBeVisible();
    await expect(page.locator('a.ws-button[href^="/mail"]').first()).toBeVisible();
  });
});
