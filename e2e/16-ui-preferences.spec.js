import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from './helpers.js';

test.describe('Module 16: UI & Preferences Management', () => {
  test('16.1. Command Palette global trigger, search filtering and keyboard navigation', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/dashboard');

    // Click command palette trigger in toolbar
    const triggerBtn = page.locator('button.ws-command-trigger');
    await expect(triggerBtn).toBeVisible({ timeout: 10000 });
    await triggerBtn.click();

    // Verify CommandPalette modal opens
    const paletteModal = page.locator('.ws-modal', { hasText: 'Hızlı erişim' });
    await expect(paletteModal).toBeVisible({ timeout: 5000 });

    const searchInput = paletteModal.locator('input[role="combobox"]');
    await expect(searchInput).toBeVisible();

    // Search for "Web siteleri"
    await searchInput.fill('Web siteleri');

    const resultsList = paletteModal.locator('.ws-command-results');
    await expect(resultsList).toBeVisible({ timeout: 5000 });

    const firstResult = resultsList.locator('a.ws-command-result').first();
    await expect(firstResult).toBeVisible();
    await expect(firstResult).toContainText('Web siteleri');

    // Press Enter to navigate
    await searchInput.press('Enter');

    // Verify modal closed and navigated to /websites
    await expect(paletteModal).not.toBeVisible({ timeout: 5000 });
    await expect(page).toHaveURL(/\/websites/, { timeout: 10000 });
  });

  test('16.2. Theme and Density Preferences live toggle', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/dashboard');

    const prefFieldset = page.locator('fieldset.ws-preferences');
    await expect(prefFieldset).toBeVisible({ timeout: 10000 });

    const themeSelect = prefFieldset.locator('#ws-theme-preference');
    const densitySelect = prefFieldset.locator('#ws-density-preference');

    await expect(themeSelect).toBeVisible();
    await expect(densitySelect).toBeVisible();

    // 1. Toggle theme to dark
    await themeSelect.selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-ws-theme', 'dark');

    // 2. Toggle theme to light
    await themeSelect.selectOption('light');
    await expect(page.locator('html')).toHaveAttribute('data-ws-theme', 'light');

    // 3. Reset theme to system
    await themeSelect.selectOption('system');

    // 4. Toggle density to compact
    await densitySelect.selectOption('compact');
    await expect(page.locator('html')).toHaveAttribute('data-ws-density', 'compact');

    // 5. Toggle density back to comfortable
    await densitySelect.selectOption('comfortable');
    await expect(page.locator('html')).toHaveAttribute('data-ws-density', 'comfortable');
  });

  test('16.3. JobDrawer real-time inspection from Jobs page', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/jobs');

    const table = page.locator('table.ws-table');
    await expect(table).toBeVisible({ timeout: 10000 });

    // Click "İncele" on the first job row
    const inspectBtn = table.locator('tbody tr button:has-text("İncele")').first();
    await expect(inspectBtn).toBeVisible({ timeout: 10000 });
    await inspectBtn.click();

    // Verify JobDrawer modal opens
    const jobDrawer = page.locator('.ws-modal', { hasText: 'İşlem durumu' });
    await expect(jobDrawer).toBeVisible({ timeout: 10000 });

    // Verify KeyValues details
    await expect(jobDrawer.locator('dt:has-text("İş kimliği")')).toBeVisible();
    await expect(jobDrawer.locator('dt:text-is("Kaynak")')).toBeVisible();
    await expect(jobDrawer.locator('dt:text-is("Aşama")')).toBeVisible();
    await expect(jobDrawer.locator('dt:has-text("İlerleme")')).toBeVisible();
    await expect(jobDrawer.locator('dt:has-text("Oluşturulma")')).toBeVisible();

    // Close JobDrawer
    const closeBtn = jobDrawer.locator('footer button:has-text("Kapat")');
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();

    await expect(jobDrawer).not.toBeVisible({ timeout: 5000 });
  });
});
