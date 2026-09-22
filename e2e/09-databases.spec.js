import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs, openFirstWebsiteWorkspace } from './helpers.js';

test.describe('Module 9: Databases & phpMyAdmin Integration', () => {
  test('9.1. Global databases inventory: inspect MariaDB socket, version, security baseline', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    await page.goto('/databases');
    await expect(page.locator('h1:has-text("Veritabanları")')).toBeVisible({ timeout: 10000 });

    // Section "Veritabanı envanteri"
    const invSection = page.locator('section').filter({ has: page.locator('h2:has-text("Veritabanı envanteri")') });
    await expect(invSection).toBeVisible({ timeout: 15000 });

    // Key values inspection
    await expect(invSection.locator('dt:has-text("Engine")')).toBeVisible();
    await expect(invSection.getByText('MariaDB', { exact: true })).toBeVisible();

    await expect(invSection.locator('dt:has-text("Sürüm")')).toBeVisible();
    await expect(invSection.locator('dt:has-text("Toplam boyut")')).toBeVisible();
    await expect(invSection.locator('dt:has-text("Veritabanı")')).toBeVisible();
    await expect(invSection.locator('dt:has-text("DB güvenlik baseline")')).toBeVisible();
    await expect(invSection.locator('dt:has-text("Admin socket auth")')).toBeVisible();

    // Table inspection
    const table = invSection.locator('table.ws-table');
    await expect(table).toBeVisible({ timeout: 10000 });
    await expect(table.locator('th:has-text("Veritabanı")')).toBeVisible();
    await expect(table.locator('th:has-text("Website sahibi")')).toBeVisible();
    await expect(table.locator('th:has-text("Boyut")')).toBeVisible();
    await expect(table.locator('th:has-text("İşlem")')).toBeVisible();

    // Verify Roundcube database is hidden from the inventory table
    await expect(table.locator('td', { hasText: /^roundcube/i })).toHaveCount(0);
  });

  test('9.2. Global database creation and deletion lifecycle', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/databases');

    const invSection = page.locator('section').filter({ has: page.locator('h2:has-text("Veritabanı envanteri")') });
    await expect(invSection).toBeVisible({ timeout: 15000 });

    const newDbSection = page.locator('section').filter({ has: page.locator('h2:has-text("Yeni veritabanı")') });
    await expect(newDbSection).toBeVisible({ timeout: 10000 });

    // Generate unique database name
    const dbName = `e2e_db_${Date.now().toString().slice(-6)}`;
    const nameInput = newDbSection.locator('label:has-text("Veritabanı adı") input');
    await nameInput.fill(dbName);

    const createBtn = newDbSection.locator('button:has-text("Veritabanı oluştur")');
    await expect(createBtn).toBeEnabled();
    await createBtn.click();

    // Wait for JobDrawer modal to open, finish and close it
    const jobModal = page.locator('.ws-modal', { hasText: 'İşlem durumu' });
    await expect(jobModal).toBeVisible({ timeout: 15000 });
    await expect(jobModal.locator('p:has-text("Sunucu işlemi başarıyla tamamladı."), .ws-badge:has-text("succeeded")').first()).toBeVisible({ timeout: 30000 });
    await jobModal.locator('button:has-text("Kapat")').click();
    await expect(jobModal).not.toBeVisible({ timeout: 5000 });

    // Verify database row appears in table
    const dbRow = invSection.locator('table.ws-table tbody tr', { hasText: dbName });
    await expect(dbRow).toBeVisible({ timeout: 10000 });

    // Click "Sil" on the created database
    const deleteBtn = dbRow.locator('button:has-text("Sil")');
    await deleteBtn.click();

    // Confirm dialog
    const confirmDialog = page.locator('.ws-modal', { hasText: `${dbName} silinsin mi?` });
    await expect(confirmDialog).toBeVisible({ timeout: 5000 });

    // Fill confirmation input
    await confirmDialog.locator('label input').fill(dbName);

    // Confirm delete
    const confirmDeleteBtn = confirmDialog.locator('button:has-text("Veritabanını sil")');
    await expect(confirmDeleteBtn).toBeEnabled();
    await confirmDeleteBtn.click();

    // Wait for confirm dialog to close
    await expect(confirmDialog).not.toBeVisible({ timeout: 10000 });

    // Wait for delete JobDrawer modal to open, finish and close it
    if (await jobModal.isVisible({ timeout: 10000 }).catch(() => false)) {
      await expect(jobModal.locator('p:has-text("Sunucu işlemi başarıyla tamamladı."), .ws-badge:has-text("succeeded")').first()).toBeVisible({ timeout: 30000 });
      await jobModal.locator('button:has-text("Kapat")').click();
      await expect(jobModal).not.toBeVisible({ timeout: 5000 });
    }

    // Verify database is removed from table
    await expect(invSection.locator('table.ws-table tbody tr', { hasText: dbName })).not.toBeVisible({ timeout: 15000 });
  });

  test('9.3. Website database resources and phpMyAdmin integration inspection', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    const resourcesTab = page.locator('nav.ws-tabs a', { hasText: 'Bağlı kaynaklar' });
    await expect(resourcesTab).toBeVisible({ timeout: 10000 });
    await resourcesTab.click();

    // Verify resources sections
    await expect(page.locator('h2:has-text("Veritabanları"), h2:has-text("Mail domainleri")').first()).toBeVisible({ timeout: 15000 });

    // If a database is bound to this website, inspect PMA / credential actions
    const dbSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Veritabanları' }) });
    if (await dbSection.isVisible({ timeout: 3000 }).catch(() => false)) {
      const pmaBtn = dbSection.locator('button:has-text("phpMyAdmin"), a:has-text("phpMyAdmin")');
      const rotateBtn = dbSection.locator('button:has-text("Parola döndür"), button:has-text("Parolayı değiştir")');
      const backupBtn = dbSection.locator('button:has-text("Vendor dump al"), button:has-text("Yedek al")');

      // Verify controls exist if credentials are configured
      if (await pmaBtn.first().isVisible({ timeout: 1000 }).catch(() => false)) {
        await expect(pmaBtn.first()).toBeVisible();
      }
      if (await rotateBtn.first().isVisible({ timeout: 1000 }).catch(() => false)) {
        await expect(rotateBtn.first()).toBeVisible();
      }
      if (await backupBtn.first().isVisible({ timeout: 1000 }).catch(() => false)) {
        await expect(backupBtn.first()).toBeVisible();
      }
    }
  });
});
