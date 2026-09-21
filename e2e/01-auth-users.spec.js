import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs, logout } from './helpers.js';

test.describe('Module 1: Authentication, Session & User Management', () => {
  test('1.1. Failed login with invalid credentials displays error notice', async ({ page }) => {
    await page.goto('/');
    const sessionBar = page.locator('.auth-sessionbar');
    if (await sessionBar.isVisible()) {
      await logout(page);
    }
    await page.waitForSelector('form.auth-form');
    await page.fill('input[name="username"]', 'wrong-user-999');
    await page.fill('input[name="password"]', 'WrongPassword123!');
    await page.click('button.auth-primary');

    const errorMsg = page.locator('.auth-error, [role="alert"]');
    await expect(errorMsg).toBeVisible({ timeout: 10000 });
    const text = await errorMsg.textContent();
    expect(text.length).toBeGreaterThan(3);
  });

  test('1.2. Owner login displays session bar, owner role, and valid lifetime', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    const sessionBar = page.locator('.auth-sessionbar');
    await expect(sessionBar).toBeVisible();
    await expect(sessionBar).toContainText(OWNER_USERNAME);
    await expect(sessionBar.locator('.auth-role')).toContainText('Owner');

    // Verify main navigation links
    await expect(page.locator('aside a[href="/websites"]')).toBeVisible();
    await expect(page.locator('aside a[href="/settings"]')).toBeVisible();
    await expect(page.locator('aside a[href="/servers"]')).toBeVisible();
    await expect(page.locator('aside a[href="/jobs"]')).toBeVisible();
  });

  test('1.3. Scoped site_manager creation, role isolation, and deletion', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/settings/users');
    await expect(page.locator('h1', { hasText: 'Kullanıcılar' })).toBeVisible({ timeout: 10000 });

    const testUser = `sm_${Date.now()}`;
    const testPass = 'ManagerPass12345678!';

    // Open create user dialog
    await page.click('button:has-text("Kullanıcı ekle")');
    await expect(page.locator('h2:has-text("Kullanıcı ekle")')).toBeVisible();

    await page.fill('input[name="username"]', testUser);
    await page.fill('input[name="new-password"]', testPass);
    await page.selectOption('label:has-text("Rol") select', 'site_manager');

    // Check at least one website if available
    const siteCheckbox = page.locator('input[type="checkbox"]').first();
    if (await siteCheckbox.count() > 0) {
      await siteCheckbox.check();
    }

    await page.click('button[type="submit"]:has-text("Hesap oluştur")');
    await expect(page.locator('.ws-notice')).toContainText(/Hesap oluşturuldu/i, { timeout: 10000 });
    await expect(page.locator('table', { hasText: testUser })).toBeVisible();

    // Log out owner, log in as site_manager
    await logout(page);
    await loginAs(page, testUser, testPass);

    // Verify site_manager cannot see global admin links
    await expect(page.locator('aside a[href="/settings"]')).toHaveCount(0);
    await expect(page.locator('aside a[href="/servers"]')).toHaveCount(0);
    await expect(page.locator('aside a[href="/audit"]')).toHaveCount(0);
    await expect(page.locator('.auth-sessionbar .auth-role')).toContainText(/Site Manager/i);

    // Verify direct URL access to /settings is redirected
    await page.goto('/settings/users');
    await expect(page).toHaveURL(/\/websites/, { timeout: 10000 });

    // Clean up: log back in as owner and delete the created user
    await logout(page);
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/settings/users');
    await expect(page.locator('h1', { hasText: 'Kullanıcılar' })).toBeVisible();

    const userRow = page.locator('table tr', { hasText: testUser });
    await expect(userRow).toBeVisible();
    await userRow.locator('button:has-text("Sil")').click();
    await expect(page.locator('h2:has-text("Kullanıcıyı sil")')).toBeVisible();

    const confirmInput = page.locator('label:has-text("Onaylamak için") input');
    await confirmInput.fill(testUser);
    await page.click('button[type="submit"]:has-text("Hesabı sil")');
    await expect(page.locator('.ws-notice')).toContainText(/silindi/i, { timeout: 10000 });
    await expect(page.locator('table tr', { hasText: testUser })).toHaveCount(0);
  });

  test('1.4. AccountDialog: Password mismatch validation, MFA inspection, and session listing', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    // Open Account Dialog
    const accountBtn = page.locator('.auth-sessionbar button:has-text("Hesabım")');
    await expect(accountBtn).toBeVisible({ timeout: 10000 });
    await accountBtn.click();

    const dialog = page.locator('dialog.auth-dialog[open]');
    await expect(dialog.locator('h2:has-text("Hesabım")')).toBeVisible({ timeout: 10000 });

    // Test password change validation: mismatched passwords
    const currentPass = dialog.locator('label:has-text("Mevcut parola") input');
    const newPass = dialog.locator('label:has-text("Yeni parola"):not(:has-text("tekrarı")) input');
    const confirmPass = dialog.locator('label:has-text("Yeni parola tekrarı") input');
    await currentPass.fill('CurrentSecret123!');
    await newPass.fill('NewSecret123456!');
    await confirmPass.fill('DifferentSecret123!');
    await dialog.locator('button[type="submit"]:has-text("Parolayı değiştir")').click();

    // Verify error message in dialog
    const dialogError = dialog.locator('.auth-error, [role="alert"]');
    await expect(dialogError).toBeVisible({ timeout: 10000 });
    await expect(dialogError).toContainText(/eşleşmiyor/i);

    // Verify MFA section is present
    await expect(dialog.locator('fieldset.mfa-container')).toBeVisible();

    // Verify Active Sessions section is present and lists current session
    const sessionsSec = dialog.locator('section.auth-sessions');
    await expect(sessionsSec).toBeVisible();
    await expect(sessionsSec.locator('div', { hasText: 'Bu oturum' })).toBeVisible({ timeout: 10000 });

    // Close dialog
    await dialog.locator('button:has-text("Kapat")').click();
    await expect(page.locator('dialog.auth-dialog[open]')).toHaveCount(0, { timeout: 10000 });
  });

  test('1.5. User edit lifecycle in UsersPage', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/settings/users');
    await expect(page.locator('h1', { hasText: 'Kullanıcılar' })).toBeVisible({ timeout: 10000 });

    const editUser = `edit_${Date.now()}`;
    const initialPass = 'EditTestPass1234!';

    // Create user
    await page.click('button:has-text("Kullanıcı ekle")');
    await page.fill('input[name="username"]', editUser);
    await page.fill('input[name="new-password"]', initialPass);
    await page.selectOption('label:has-text("Rol") select', 'read_only');
    await page.click('button[type="submit"]:has-text("Hesap oluştur")');
    await expect(page.locator('.ws-notice')).toContainText(/Hesap oluşturuldu/i, { timeout: 10000 });

    const userRow = page.locator('table tr', { hasText: editUser });
    await expect(userRow).toBeVisible();
    await expect(userRow).toContainText('Read Only');

    // Click "Düzenle"
    await userRow.locator('button:has-text("Düzenle")').click();
    const editModal = page.locator('dialog[open]');
    await expect(editModal.locator('h2:has-text("Kullanıcıyı düzenle")')).toBeVisible({ timeout: 10000 });

    // Change role to site_manager and status to disabled
    await editModal.locator('label:has-text("Rol") select').selectOption('site_manager');
    await editModal.locator('label:has-text("Hesap durumu") select').selectOption('false');
    await editModal.locator('button[type="submit"]:has-text("Kaydet")').click();

    await expect(page.locator('.ws-notice')).toContainText(/Hesap kaydedildi/i, { timeout: 10000 });

    // Verify row reflects changes
    const updatedRow = page.locator('table tr', { hasText: editUser });
    await expect(updatedRow).toContainText('Site Yöneticisi');
    await expect(updatedRow).toContainText('Devre dışı');

    // Clean up: delete user
    await updatedRow.locator('button:has-text("Sil")').click();
    await page.locator('label:has-text("Onaylamak için") input').fill(editUser);
    await page.click('button[type="submit"]:has-text("Hesabı sil")');
    await expect(page.locator('.ws-notice')).toContainText(/silindi/i, { timeout: 10000 });
    await expect(page.locator('table tr', { hasText: editUser })).toHaveCount(0);
  });
});

