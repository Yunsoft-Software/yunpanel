import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from './helpers.js';

test.describe('Module 14: Logs, Audit & Jobs Management', () => {
  test('14.1. Live site logs inspection, source switching and search on /websites/:id/logs', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/websites');

    const manageBtn = page.locator('table.ws-table tbody tr a:has-text("Yönet")').first();
    await expect(manageBtn).toBeVisible({ timeout: 10000 });
    await manageBtn.click();

    await page.waitForURL(/\/websites\/[^/]+/, { timeout: 10000 });

    // Navigate to Loglar tab
    const logsTab = page.locator('.ws-tabs a:has-text("Loglar")');
    await expect(logsTab).toBeVisible({ timeout: 10000 });
    await logsTab.click();

    // Verify LogsPanel
    const logsSection = page.locator('section').filter({ has: page.locator('h2:text-is("Canlı site logları")') });
    await expect(logsSection).toBeVisible({ timeout: 10000 });

    const sourceSelect = logsSection.locator('label:has-text("Kaynak") select');
    await expect(sourceSelect).toBeVisible();

    // Switch to Nginx error logs
    await sourceSelect.selectOption('nginx-error');
    await expect(logsSection.locator('.ws-table, .ws-empty')).toBeVisible({ timeout: 10000 });

    // Switch back to Nginx access logs
    await sourceSelect.selectOption('nginx-access');
    await expect(logsSection.locator('.ws-table, .ws-empty')).toBeVisible({ timeout: 10000 });

    // Verify search and download button
    const searchInput = logsSection.locator('label.ws-filter-search input');
    await expect(searchInput).toBeVisible();
    await searchInput.fill('GET');

    const applyBtn = logsSection.locator('button:has-text("Uygula")');
    await applyBtn.click();

    const downloadLink = logsSection.locator('a:has-text("İndir")');
    await expect(downloadLink).toBeVisible();
    const href = await downloadLink.getAttribute('href');
    expect(href).toContain('/download');
  });

  test('14.2. Audit logs inspection, multi-criteria filtering and pagination on /audit', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/audit');

    await expect(page.locator('h1')).toContainText('Denetim kayıtları', { timeout: 10000 });

    // Verify filter inputs
    const filterSection = page.locator('section').filter({ has: page.locator('h2:text-is("Filtreler")') });
    await expect(filterSection).toBeVisible({ timeout: 10000 });

    const actorInput = filterSection.locator('label:has-text("Actor kimliği") input');
    const actionInput = filterSection.locator('label:has-text("İşlem adı") input');
    const outcomeSelect = filterSection.locator('label:has-text("Sonuç") select');
    const resourceTypeInput = filterSection.locator('label:has-text("Kaynak türü") input');
    const filterBtn = filterSection.locator('button[type="submit"]:has-text("Filtrele")');
    const resetBtn = filterSection.locator('button:has-text("Temizle")');

    await expect(actorInput).toBeVisible();
    await expect(actionInput).toBeVisible();
    await expect(outcomeSelect).toBeVisible();
    await expect(resourceTypeInput).toBeVisible();

    // Filter by outcome: succeeded (Başarılı)
    await outcomeSelect.selectOption('succeeded');
    await filterBtn.click();

    // Verify records table
    const recordsSection = page.locator('section').filter({ has: page.locator('h2:text-is("Kayıtlar")') });
    await expect(recordsSection).toBeVisible({ timeout: 10000 });

    const table = recordsSection.locator('table.ws-table');
    await expect(table).toBeVisible({ timeout: 10000 });

    await expect(table.locator('th:has-text("Zaman")')).toBeVisible();
    await expect(table.locator('th:has-text("İşlem")')).toBeVisible();
    await expect(table.locator('th:has-text("Actor")')).toBeVisible();
    await expect(table.locator('th:has-text("Kaynak")')).toBeVisible();
    await expect(table.locator('th:has-text("Sonuç")')).toBeVisible();

    // Clear filters
    await resetBtn.click();
    await expect(table).toBeVisible({ timeout: 10000 });

    // Verify pagination
    const pagination = recordsSection.locator('footer.ws-pagination');
    await expect(pagination).toBeVisible();
    await expect(pagination.locator('button:has-text("Önceki")')).toBeVisible();
    await expect(pagination.locator('button:has-text("Sonraki")')).toBeVisible();
  });

  test('14.3. Jobs page inspection, search, status filtering and pagination on /jobs', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/jobs');

    await expect(page.locator('h1')).toContainText('İşler', { timeout: 10000 });

    const jobsSection = page.locator('section').filter({ has: page.locator('h2:text-is("İşlem geçmişi")') });
    await expect(jobsSection).toBeVisible({ timeout: 10000 });

    const searchInput = jobsSection.locator('label.ws-filter-search input[type="search"]');
    const statusSelect = jobsSection.locator('label:has-text("Durum") select');
    await expect(searchInput).toBeVisible();
    await expect(statusSelect).toBeVisible();

    // Filter by succeeded jobs
    await statusSelect.selectOption('succeeded');

    const table = jobsSection.locator('table.ws-table');
    const emptyState = jobsSection.locator('.ws-empty');
    await expect(table.or(emptyState)).toBeVisible({ timeout: 10000 });

    if (await table.isVisible()) {
      await expect(table.locator('th:text-is("İşlem")')).toBeVisible();
      await expect(table.locator('th:has-text("Kaynak")')).toBeVisible();
      await expect(table.locator('th:has-text("Durum")')).toBeVisible();
      await expect(table.locator('th:has-text("Oluşturulma")')).toBeVisible();

      // Test search filter
      await searchInput.fill('ssl');
      await expect(table.or(emptyState)).toBeVisible({ timeout: 5000 });
      await searchInput.clear();
    }

    // Reset status filter to all
    await statusSelect.selectOption('all');

    // Verify pagination controls
    const pagination = jobsSection.locator('footer.ws-pagination');
    await expect(pagination).toBeVisible();
    await expect(pagination.locator('button:has-text("Önceki")')).toBeVisible();
    await expect(pagination.locator('button:has-text("Sonraki")')).toBeVisible();
  });
});
