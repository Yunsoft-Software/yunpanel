import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from './helpers.js';

test.describe('Module 11: App Tools & Environment Management', () => {
  test('11.1. Applications inventory inspection & search filtering', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/applications');

    await expect(page.locator('h1')).toContainText('Uygulamalar', { timeout: 10000 });
    await expect(page.locator('a:has-text("Uygulama ekle")')).toBeVisible();

    const searchInput = page.locator('label.ws-filter-search input[type="search"]');
    await expect(searchInput).toBeVisible();

    // Verify table headers or empty state
    const table = page.locator('table.ws-table');
    const emptyState = page.locator('.ws-empty');

    await expect(table.or(emptyState)).toBeVisible({ timeout: 10000 });

    if (await table.isVisible()) {
      await expect(table.locator('th:has-text("Uygulama")')).toBeVisible();
      await expect(table.locator('th:has-text("Runtime")')).toBeVisible();
      await expect(table.locator('th:has-text("Durum")')).toBeVisible();
      await expect(table.locator('th:has-text("Son deploy")')).toBeVisible();
      await expect(table.locator('th:has-text("İşlemler")')).toBeVisible();

      // Test search filter
      await searchInput.fill('nonexistent-app-xyz-filter');
      await expect(page.locator('.ws-empty')).toBeVisible({ timeout: 5000 });
      await searchInput.clear();
    }
  });

  test('11.2. Application creation form validation and type toggle', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/applications/new');

    await expect(page.locator('h1')).toContainText('Uygulama ekle', { timeout: 10000 });

    const typeSelect = page.locator('label:has-text("Tür") select');
    await expect(typeSelect).toBeVisible();

    // Default is node
    await expect(page.locator('label:has-text("Uygulama portu")')).toBeVisible();
    await expect(page.locator('label:has-text("Başlangıç dosyası")')).toBeVisible();
    await expect(page.locator('label:has-text("Sağlık kontrolü yolu")')).toBeVisible();

    // Switch to static
    await typeSelect.selectOption('static');
    await expect(page.locator('label:has-text("Build çıktı klasörü")')).toBeVisible();
    await expect(page.locator('label:has-text("Uygulama portu")')).not.toBeVisible();

    // Switch back to node
    await typeSelect.selectOption('node');
    await expect(page.locator('label:has-text("Uygulama portu")')).toBeVisible();
  });

  test('11.3. Environment Variables CRUD in EnvironmentPanel', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/applications');

    // Wait for applications table or empty state to load
    const appsTable = page.locator('table.ws-table');
    const emptyState = page.locator('.ws-empty');
    await expect(appsTable.or(emptyState)).toBeVisible({ timeout: 10000 });

    let envBtn = page.locator('table.ws-table tbody tr button:has-text("Env")').first();

    if ((await envBtn.count()) === 0) {
      // Create a test app with unique port
      const randomPort = String(Math.floor(25000 + Math.random() * 20000));
      await page.goto('/applications/new');
      await page.locator('label:has-text("Uygulama adı") input').fill(`test-env-${Date.now().toString().slice(-4)}`);
      await page.locator('label:has-text("GitHub repository") input').fill('https://github.com/yunsoft/test-repo');
      await page.locator('label:has-text("Branch") input').fill('main');
      await page.locator('label:has-text("Uygulama portu") input').fill(randomPort);
      await page.locator('button[type="submit"]:has-text("Uygulamayı oluştur")').click();
      await expect(page.locator('a:has-text("Uygulamalara git")')).toBeVisible({ timeout: 10000 });
      await page.locator('a:has-text("Uygulamalara git")').click();
      await page.waitForURL(/\/applications$/, { timeout: 10000 });
      envBtn = page.locator('table.ws-table tbody tr button:has-text("Env")').first();
    }

    await expect(envBtn).toBeVisible({ timeout: 10000 });
    await envBtn.click();

    // Verify EnvironmentPanel opened
    const envSection = page.locator('section').filter({ has: page.locator('h2:text-is("Ortam değişkenleri")') });
    await expect(envSection).toBeVisible({ timeout: 10000 });

    const varForm = envSection.locator('form').first();
    const varNameInput = varForm.locator('label:has-text("Değişken adı") input');
    const varValueInput = varForm.locator('label:has-text("Değer") input');
    const varVisSelect = varForm.locator('label:has-text("Görünürlük") select');
    const varSaveBtn = varForm.locator('button[type="submit"]:has-text("Değişkeni kaydet")');

    // 1. Add plain text variable
    const plainKey = `TEST_VAR_PLAIN_${Date.now().toString().slice(-4)}`;
    await varNameInput.fill(plainKey);
    await varVisSelect.selectOption('plain');
    await varValueInput.fill('plain_value_test_123');
    await varSaveBtn.click();

    // Verify in table
    const table = envSection.locator('table.ws-table');
    await expect(table.locator(`tr:has-text("${plainKey}")`)).toBeVisible({ timeout: 10000 });
    await expect(table.locator(`tr:has-text("${plainKey}")`)).toContainText('plain_value_test_123');
    await expect(table.locator(`tr:has-text("${plainKey}")`)).toContainText('Düz metin');

    // 2. Add secret variable
    const secretKey = `TEST_VAR_SECRET_${Date.now().toString().slice(-4)}`;
    await varNameInput.fill(secretKey);
    await varVisSelect.selectOption('secret');
    await varValueInput.fill('secret_value_pass_456');
    await varSaveBtn.click();

    // Verify in table (masked)
    await expect(table.locator(`tr:has-text("${secretKey}")`)).toBeVisible({ timeout: 10000 });
    await expect(table.locator(`tr:has-text("${secretKey}")`)).toContainText('••••••••');
    await expect(table.locator(`tr:has-text("${secretKey}")`)).toContainText('Gizli');

    // 3. Delete plain variable with confirmation
    const row = table.locator(`tr:has-text("${plainKey}")`);
    await row.locator('button:has-text("Sil")').click();

    const deleteModal = page.locator('.ws-modal', { hasText: 'Ortam değişkenini sil' });
    await expect(deleteModal).toBeVisible({ timeout: 5000 });

    const confirmInput = deleteModal.locator('input');
    await confirmInput.fill(plainKey);
    await deleteModal.locator('button:has-text("Değişkeni sil")').click();

    await expect(deleteModal).not.toBeVisible({ timeout: 10000 });
    await expect(table.locator(`tr:has-text("${plainKey}")`)).not.toBeVisible({ timeout: 5000 });

    // Clean up secret variable
    const secretRow = table.locator(`tr:has-text("${secretKey}")`);
    if (await secretRow.isVisible().catch(() => false)) {
      await secretRow.locator('button:has-text("Sil")').click();
      const modal = page.locator('.ws-modal', { hasText: 'Ortam değişkenini sil' });
      await modal.locator('input').fill(secretKey);
      await modal.locator('button:has-text("Değişkeni sil")').click();
      await expect(modal).not.toBeVisible({ timeout: 10000 });
    }
  });

  test('11.4. Bulk .env import with merge and replace modes', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/applications');

    const envBtn = page.locator('table.ws-table tbody tr button:has-text("Env")').first();
    await expect(envBtn).toBeVisible({ timeout: 10000 });
    await envBtn.click();

    const envSection = page.locator('section').filter({ has: page.locator('h2:text-is("Ortam değişkenleri")') });
    await expect(envSection).toBeVisible({ timeout: 10000 });

    const importForm = envSection.locator('form').nth(1);
    const textarea = importForm.locator('textarea');
    const modeSelect = importForm.locator('label:has-text("İçe aktarma modu") select');
    const visSelect = importForm.locator('label:has-text("Görünürlük") select');
    const submitBtn = importForm.locator('button[type="submit"]:has-text(".env içeriğini içe aktar")');

    // 1. Test merge import
    const tag = Date.now().toString().slice(-4);
    const key1 = `MERGE_A_${tag}`;
    const key2 = `MERGE_B_${tag}`;
    await textarea.fill(`${key1}=val_a\n${key2}=val_b`);
    await modeSelect.selectOption('merge');
    await visSelect.selectOption('plain');
    await submitBtn.click();

    const table = envSection.locator('table.ws-table');
    await expect(table.locator(`tr:has-text("${key1}")`)).toBeVisible({ timeout: 10000 });
    await expect(table.locator(`tr:has-text("${key2}")`)).toBeVisible({ timeout: 10000 });

    // 2. Test replace import
    const replaceKey = `REPLACE_ONLY_${tag}`;
    await textarea.fill(`${replaceKey}=only_this_value`);
    await modeSelect.selectOption('replace');
    await visSelect.selectOption('plain');
    await submitBtn.click();

    // ConfirmDialog should appear with confirmation code requirement
    const replaceModal = page.locator('.ws-modal', { hasText: 'Ortam değişkenlerinin tamamını değiştir' });
    await expect(replaceModal).toBeVisible({ timeout: 5000 });

    // Read expected confirmation code from the modal instruction
    const codeText = await replaceModal.locator('.ws-confirm-code, code, strong').last().textContent();
    const cleanCode = codeText?.trim() || '';

    const confirmInput = replaceModal.locator('input');
    await confirmInput.fill(cleanCode);
    await replaceModal.locator('button:has-text("Tümünü değiştir")').click();

    await expect(replaceModal).not.toBeVisible({ timeout: 10000 });

    // Verify that now only replaceKey is in table and merged keys are gone!
    await expect(table.locator(`tr:has-text("${replaceKey}")`)).toBeVisible({ timeout: 10000 });
    await expect(table.locator(`tr:has-text("${key1}")`)).not.toBeVisible({ timeout: 5000 });
    await expect(table.locator(`tr:has-text("${key2}")`)).not.toBeVisible({ timeout: 5000 });

    // Cleanup: delete the replaceKey
    const replaceRow = table.locator(`tr:has-text("${replaceKey}")`);
    await replaceRow.locator('button:has-text("Sil")').click();
    const deleteModal = page.locator('.ws-modal', { hasText: 'Ortam değişkenini sil' });
    await deleteModal.locator('input').fill(replaceKey);
    await deleteModal.locator('button:has-text("Değişkeni sil")').click();
    await expect(deleteModal).not.toBeVisible({ timeout: 10000 });
  });
});
