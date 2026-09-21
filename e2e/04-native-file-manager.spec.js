import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs, openFirstWebsiteWorkspace } from './helpers.js';

test.describe('Module 4: Native Sandboxed File Manager', () => {
  test('4.1. File Manager navigation, toolbar, and directory listing', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    const filesTab = page.locator('nav.ws-tabs a', { hasText: 'Dosyalar' });
    await expect(filesTab).toBeVisible();
    await filesTab.click();

    // Verify header and toolbar actions
    await expect(page.locator('h2:has-text("Site Dosyaları")')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('button:has-text("Yeni Dosya")')).toBeVisible();
    await expect(page.locator('button:has-text("Yeni Klasör")')).toBeVisible();
    await expect(page.locator('button:has-text("Dosya Yükle")')).toBeVisible();
    await expect(page.locator('div.ws-breadcrumb')).toBeVisible();

    // Verify listing table loaded
    await expect(page.locator('table.ws-table')).toBeVisible();
  });

  test('4.2. Folder creation and verification', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    await page.locator('nav.ws-tabs a', { hasText: 'Dosyalar' }).click();
    await expect(page.locator('h2:has-text("Site Dosyaları")')).toBeVisible({ timeout: 10000 });

    const folderName = `fld_${Date.now()}`;
    await page.click('button:has-text("Yeni Klasör")');
    await expect(page.locator('h2:has-text("Yeni Klasör Oluştur")')).toBeVisible();

    await page.fill('input[placeholder*="assets"]', folderName);
    await page.click('button[type="submit"]:has-text("Oluştur")');

    // Verify folder appears in listing
    await expect(page.locator(`tr:has(strong:has-text("${folderName}"))`)).toBeVisible({ timeout: 10000 });
  });

  test('4.3. File creation, inline code editor save, and content verification', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    await page.locator('nav.ws-tabs a', { hasText: 'Dosyalar' }).click();
    await expect(page.locator('h2:has-text("Site Dosyaları")')).toBeVisible({ timeout: 10000 });

    const fileName = `note_${Date.now()}.txt`;
    await page.click('button:has-text("Yeni Dosya")');
    await expect(page.locator('h2:has-text("Yeni Dosya Oluştur")')).toBeVisible();

    await page.fill('input[placeholder*="index.html"]', fileName);
    await page.click('button[type="submit"]:has-text("Oluştur")');

    // Find row
    const fileRow = page.locator(`tr:has(strong:has-text("${fileName}"))`);
    await expect(fileRow).toBeVisible({ timeout: 10000 });

    // Open editor
    await fileRow.locator('button:has-text("Düzenle")').click();
    await expect(page.locator('h2:has-text("Dosya Düzenle:")')).toBeVisible({ timeout: 10000 });

    const editorTextarea = page.locator('dialog textarea');
    await expect(editorTextarea).toBeVisible();
    await editorTextarea.fill('YunPanel Playwright Native File Manager Verified Content');

    // Save
    await page.click('dialog button:has-text("Değişiklikleri Kaydet")');
    await page.click('dialog button:has-text("Kapat")');
    await expect(page.locator('dialog[open]')).toHaveCount(0, { timeout: 10000 });
  });

  test('4.4. Multi-select and batch deletion', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    await page.locator('nav.ws-tabs a', { hasText: 'Dosyalar' }).click();
    await expect(page.locator('h2:has-text("Site Dosyaları")')).toBeVisible({ timeout: 10000 });

    // Create item 1
    const item1 = `del1_${Date.now()}.txt`;
    await page.click('button:has-text("Yeni Dosya")');
    await page.fill('input[placeholder*="index.html"]', item1);
    await page.click('button[type="submit"]:has-text("Oluştur")');
    await expect(page.locator(`strong:has-text("${item1}")`)).toBeVisible({ timeout: 10000 });

    // Create item 2
    const item2 = `del2_${Date.now()}.txt`;
    await page.click('button:has-text("Yeni Dosya")');
    await page.fill('input[placeholder*="index.html"]', item2);
    await page.click('button[type="submit"]:has-text("Oluştur")');
    await expect(page.locator(`strong:has-text("${item2}")`)).toBeVisible({ timeout: 10000 });

    // Check checkboxes for both items
    await page.locator(`tr:has(strong:has-text("${item1}")) input[type="checkbox"]`).check();
    await page.locator(`tr:has(strong:has-text("${item2}")) input[type="checkbox"]`).check();

    // Batch delete button must appear
    const batchBtn = page.locator('button:has-text("Seçilenleri Sil")');
    await expect(batchBtn).toBeVisible();
    await batchBtn.click();

    // Confirm batch modal
    await expect(page.locator('h2:has-text("öge silinsin mi?")')).toBeVisible({ timeout: 10000 });
    const code = await page.locator('dialog label strong').textContent();
    await page.fill('dialog label input', code.trim());
    await page.click('dialog button[type="submit"]');

    // Verify both items deleted from DOM
    await expect(page.locator(`strong:has-text("${item1}")`)).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator(`strong:has-text("${item2}")`)).toHaveCount(0, { timeout: 10000 });
  });
});
