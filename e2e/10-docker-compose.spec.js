import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from './helpers.js';

test.describe('Module 10: Docker & Docker Compose Management', () => {
  test('10.1. Docker projects list: inspect page, open creation modal, test validation', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    await page.goto('/docker');
    await expect(page.locator('h1:has-text("Docker")')).toBeVisible({ timeout: 10000 });

    // Section "Compose projeleri"
    const projSection = page.locator('section').filter({ has: page.locator('h2:has-text("Compose projeleri")') });
    await expect(projSection).toBeVisible({ timeout: 15000 });

    // Click "Compose projesi ekle"
    const addBtn = page.locator('button:has-text("Compose projesi ekle")').first();
    await expect(addBtn).toBeVisible();
    await addBtn.click();

    // Dialog inspection
    const modal = page.locator('.ws-modal', { hasText: 'Docker Compose projesi ekle' });
    await expect(modal).toBeVisible({ timeout: 5000 });

    const nameInput = modal.locator('label:has-text("Proje adı") input');
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toBeEnabled({ timeout: 10000 });
    await nameInput.fill('temp_validation_test');

    const docInput = modal.locator('label:has-text("Compose document") textarea');
    await expect(docInput).toBeVisible();

    // Test Validate button
    const validateBtn = modal.locator('button:has-text("Validate")');
    await expect(validateBtn).toBeEnabled();
    await validateBtn.click();

    // Verify validation key values appear
    await expect(modal.locator('dt:has-text("Servis")')).toBeVisible({ timeout: 10000 });

    // Cancel modal
    await modal.locator('button:has-text("Vazgeç")').click();
    await expect(modal).not.toBeVisible({ timeout: 5000 });
  });

  test('10.2. Docker project creation lifecycle and detail panels inspection', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/docker');

    const addBtn = page.locator('button:has-text("Compose projesi ekle")').first();
    await addBtn.click();

    const modal = page.locator('.ws-modal', { hasText: 'Docker Compose projesi ekle' });
    await expect(modal).toBeVisible({ timeout: 5000 });

    const projectName = `e2e_proj_${Date.now().toString().slice(-6)}`;
    const nameInput = modal.locator('label:has-text("Proje adı") input');
    await expect(nameInput).toBeEnabled({ timeout: 10000 });
    await nameInput.fill(projectName);

    const composeDoc = 'services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "127.0.0.1:8080:80"\n';
    await modal.locator('label:has-text("Compose document") textarea').fill(composeDoc);

    const saveBtn = modal.locator('button:has-text("Projeyi kaydet")');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    // Should navigate to detail page /docker/:id
    await page.waitForURL(/\/docker\/[^/]+/, { timeout: 15000 });
    await expect(page.locator('h1')).toContainText(projectName, { timeout: 10000 });

    // Verify detail sections
    await expect(page.locator('section').filter({ has: page.locator('h2:text-is("Desired state")') })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('section').filter({ has: page.locator('h2:text-is("Depolama")') })).toBeVisible();
    await expect(page.locator('section').filter({ has: page.locator('h2:text-is("Lifecycle")') })).toBeVisible();
    await expect(page.locator('section').filter({ has: page.locator('h2:text-is("Compose desired state")') })).toBeVisible();
    await expect(page.locator('section').filter({ has: page.locator('h2:text-is("Compose environment")') })).toBeVisible();
    await expect(page.locator('section').filter({ has: page.locator('h2:text-is("Registry credentials")') })).toBeVisible();
  });

  test('10.3. Docker lifecycle actions and preview modal flow', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/docker');

    // Click "Yönet" on the first project in table
    const manageLink = page.locator('table.ws-table tbody tr a:has-text("Yönet")').first();
    await expect(manageLink).toBeVisible({ timeout: 10000 });
    await manageLink.click();

    await page.waitForURL(/\/docker\/[^/]+/, { timeout: 15000 });

    const lifecycleSection = page.locator('section').filter({ has: page.locator('h2:text-is("Lifecycle")') });
    await expect(lifecycleSection).toBeVisible({ timeout: 10000 });

    // Verify lifecycle buttons
    await expect(lifecycleSection.locator('button:has-text("Build")')).toBeVisible();
    await expect(lifecycleSection.locator('button:has-text("Pull")')).toBeVisible();
    await expect(lifecycleSection.locator('button:has-text("Başlat")')).toBeVisible();
    await expect(lifecycleSection.locator('button:has-text("Durdur")')).toBeVisible();
    await expect(lifecycleSection.locator('button:has-text("Restart")')).toBeVisible();

    // Click "Pull" to test action preview modal
    const pullBtn = lifecycleSection.locator('button:has-text("Pull")');
    await pullBtn.click();

    const confirmDialog = page.locator('.ws-modal', { hasText: 'Docker Compose pull' });
    await expect(confirmDialog).toBeVisible({ timeout: 10000 });
    await expect(confirmDialog.locator('button:has-text("İşi sıraya al")')).toBeVisible();

    // Cancel modal
    await confirmDialog.locator('button:has-text("Vazgeç")').click();
    await expect(confirmDialog).not.toBeVisible({ timeout: 5000 });
  });

  test('10.4. Compose config and environment validation', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/docker');

    const manageLink = page.locator('table.ws-table tbody tr a:has-text("Yönet")').first();
    await manageLink.click();
    await page.waitForURL(/\/docker\/[^/]+/, { timeout: 15000 });

    // Section "Compose desired state": test validate saved state
    const desiredSection = page.locator('section').filter({ has: page.locator('h2:has-text("Compose desired state")') });
    await expect(desiredSection).toBeVisible({ timeout: 10000 });

    const validateBtn = desiredSection.locator('button:has-text("Kayıtlı state’i validate et")');
    await expect(validateBtn).toBeVisible();
    await validateBtn.click();

    await expect(desiredSection.locator('dt:has-text("Project revizyonu")')).toBeVisible({ timeout: 10000 });

    // Section "Compose environment": test environment replace modal
    const envSection = page.locator('section').filter({ has: page.locator('h2:has-text("Compose environment")') });
    await expect(envSection).toBeVisible({ timeout: 10000 });

    const envTextarea = envSection.locator('label:has-text("Tam environment listesi") textarea');
    await envTextarea.fill('NODE_ENV=production\nAPP_DEBUG=false');

    const replaceBtn = envSection.locator('button:has-text("Environment’ı değiştir")');
    await expect(replaceBtn).toBeEnabled();
    await replaceBtn.click();

    const confirmDialog = page.locator('.ws-modal', { hasText: 'Compose environment’ın tamamını değiştir' });
    await expect(confirmDialog).toBeVisible({ timeout: 5000 });

    await confirmDialog.locator('button:has-text("Vazgeç")').click();
    await expect(confirmDialog).not.toBeVisible({ timeout: 5000 });
  });
});
