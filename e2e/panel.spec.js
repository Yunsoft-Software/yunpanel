import { test, expect } from '@playwright/test';

const OWNER_USERNAME = process.env.PANEL_OWNER_USER || 'yunsoft-owner';
const OWNER_PASSWORD = process.env.PANEL_OWNER_PASSWORD || 'b70646fcd0ceb42481c2f4fff95466493de0';

async function loginAs(page, username, password) {
  await page.goto('/');
  const sessionBar = page.locator('.auth-sessionbar');
  const authForm = page.locator('form.auth-form');

  // Wait for either the sessionbar (already logged in) or the login form
  await expect(sessionBar.or(authForm)).toBeVisible({ timeout: 15000 });

  // If already logged in as a different user, logout first
  if (await sessionBar.isVisible()) {
    const text = await sessionBar.textContent();
    if (!text.includes(username)) {
      await logout(page);
      await expect(authForm).toBeVisible({ timeout: 15000 });
    }
  }

  if (await authForm.isVisible()) {
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', password);
    await page.click('button.auth-primary');
    await expect(sessionBar).toBeVisible({ timeout: 15000 });
  }
}

async function logout(page) {
  const logoutBtn = page.locator('.auth-sessionbar button', { hasText: 'Çıkış yap' });
  if (await logoutBtn.isVisible()) {
    await logoutBtn.click();
    await expect(page.locator('form.auth-form')).toBeVisible({ timeout: 15000 });
  }
}

test.describe('YunPanel E2E Test Suite', () => {
  test('1. Owner can log in, view dashboard and website workspace', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    // Verify auth sessionbar
    await expect(page.locator('.auth-sessionbar')).toContainText(OWNER_USERNAME);
    await expect(page.locator('.auth-sessionbar .auth-role')).toContainText('Owner');

    // Verify main navigation links in sidebar
    await expect(page.locator('aside a[href="/websites"]')).toBeVisible();
    await expect(page.locator('aside a[href="/settings"]')).toBeVisible();
    await expect(page.locator('aside a[href="/servers"]')).toBeVisible();

    // Navigate to websites
    await page.click('aside a[href="/websites"]');
    await expect(page.locator('h1', { hasText: 'Web siteleri' })).toBeVisible({ timeout: 10000 });
  });

  test('2. Website Workspace displays Plesk-style tabs and operational tools', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    // Go to websites list
    await page.goto('/websites');
    await expect(page.locator('h1', { hasText: 'Web siteleri' })).toBeVisible({ timeout: 10000 });

    // Find site link
    const siteLink = page.locator('table.ws-table tbody tr a[href^="/websites/"]').first();
    const siteCount = await siteLink.count();

    if (siteCount > 0) {
      await siteLink.click();
      await page.waitForURL(/\/websites\/[^/]+/, { timeout: 10000 });

      // Verify breadcrumb
      await expect(page.locator('.ws-breadcrumb')).toBeVisible();

      // Verify Workspace Tabs
      const tabsNav = page.locator('nav.ws-tabs');
      await expect(tabsNav).toBeVisible();
      await expect(tabsNav.locator('a', { hasText: 'Genel bakış' })).toBeVisible();
      await expect(tabsNav.locator('a', { hasText: 'Alan adları' })).toBeVisible();
      await expect(tabsNav.locator('a', { hasText: 'SSL' })).toBeVisible();
      await expect(tabsNav.locator('a', { hasText: 'Loglar' })).toBeVisible();
      await expect(tabsNav.locator('a', { hasText: 'Ayarlar' })).toBeVisible();

      // Test SSL Tab
      await tabsNav.locator('a', { hasText: 'SSL' }).click();
      await expect(page.locator('text=SSL sertifikası')).toBeVisible({ timeout: 10000 });

      // Test Resources (Bağlı kaynaklar) Tab
      const resourcesTab = tabsNav.locator('a', { hasText: 'Bağlı kaynaklar' });
      if (await resourcesTab.count() > 0) {
        await resourcesTab.click();
        await expect(page.locator('text=Veritabanları')).toBeVisible({ timeout: 10000 });
        await expect(page.locator('text=Mail')).toBeVisible({ timeout: 10000 });
      }

      // Test Terminal Tab (Native WebSocket terminal)
      const terminalTab = tabsNav.locator('a', { hasText: 'Terminal' });
      if (await terminalTab.count() > 0) {
        await terminalTab.click();
        // Native terminal container with xterm
        await expect(page.locator('.terminal-shell, .terminal-status, .xterm')).toBeVisible({ timeout: 15000 });
      }
    }
  });

  test('3. Scoped site_manager role creation and isolation verification', async ({ page }) => {
    // 1. Log in as Owner
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    // 2. Navigate to User Management
    await page.goto('/settings/users');
    await expect(page.locator('h1', { hasText: 'Kullanıcılar' })).toBeVisible({ timeout: 10000 });

    // 3. Create a new site_manager user
    const testUser = `sm_${Date.now()}`;
    const testPass = 'ManagerPass12345678!';

    await page.click('button:has-text("Kullanıcı ekle")');
    await expect(page.locator('h2:has-text("Kullanıcı ekle")')).toBeVisible();

    await page.fill('input[name="username"]', testUser);
    await page.fill('input[name="new-password"]', testPass);
    await page.selectOption('label:has-text("Rol") select', 'site_manager');

    // Check at least one website if present
    const siteCheckbox = page.locator('input[type="checkbox"]').first();
    if (await siteCheckbox.count() > 0) {
      await siteCheckbox.check();
    }

    await page.click('button[type="submit"]:has-text("Hesap oluştur")');
    await expect(page.locator('.ws-notice')).toContainText(/Hesap oluşturuldu/i, { timeout: 10000 });
    await expect(page.locator('table', { hasText: testUser })).toBeVisible();

    // 4. Log out from Owner
    await logout(page);

    // 5. Log in as the scoped site_manager
    await loginAs(page, testUser, testPass);

    // 6. Verify Scoped Navigation
    // site_manager should NOT see admin links in sidebar: /settings, /servers, /audit
    await expect(page.locator('aside a[href="/settings"]')).toHaveCount(0);
    await expect(page.locator('aside a[href="/servers"]')).toHaveCount(0);
    await expect(page.locator('aside a[href="/audit"]')).toHaveCount(0);

    // Verify role label in header
    await expect(page.locator('.auth-sessionbar .auth-role')).toContainText(/Site Manager/i);

    // 7. Verify global admin paths are forbidden and redirected
    await page.goto('/settings/users');
    await expect(page).toHaveURL(/\/websites/, { timeout: 10000 });
    await expect(page.locator('h1', { hasText: 'Web siteleri' })).toBeVisible();

    // 8. Clean up: log out site_manager, log back in as owner and delete the test user
    await logout(page);
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/settings/users');
    await expect(page.locator('h1', { hasText: 'Kullanıcılar' })).toBeVisible({ timeout: 10000 });

    const userRow = page.locator('table tr', { hasText: testUser });
    if (await userRow.count() > 0) {
      await userRow.locator('button:has-text("Sil")').click();
      await expect(page.locator('h2:has-text("Kullanıcıyı sil")')).toBeVisible();
      const confirmInput = page.locator('label:has-text("Onaylamak için") input');
      await confirmInput.fill(testUser);
      await page.click('button[type="submit"]:has-text("Hesabı sil")');
      await expect(page.locator('.ws-notice')).toContainText(/silindi/i, { timeout: 10000 });
    }
  });

  test('4. Native Sandboxed File Manager and Webmail verification', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    await page.goto('/websites');
    await expect(page.locator('h1', { hasText: 'Web siteleri' })).toBeVisible({ timeout: 10000 });

    const siteLink = page.locator('table.ws-table tbody tr a[href^="/websites/"]').first();
    const siteCount = await siteLink.count();

    if (siteCount > 0) {
      await siteLink.click();
      await page.waitForURL(/\/websites\/[^/]+/, { timeout: 10000 });

      const tabsNav = page.locator('nav.ws-tabs');

      // 1. Verify Webmail in Bağlı kaynaklar
      const resourcesTab = tabsNav.locator('a', { hasText: 'Bağlı kaynaklar' });
      if (await resourcesTab.count() > 0) {
        await resourcesTab.click();
        await expect(page.locator('h2', { hasText: 'Mail & Webmail' })).toBeVisible({ timeout: 10000 });
      }

      // 2. Verify Native File Manager in Dosyalar tab
      const filesTab = tabsNav.locator('a', { hasText: 'Dosyalar' });
      if (await filesTab.count() > 0) {
        await filesTab.click();

        // Native toolbar
        await expect(page.locator('h2', { hasText: 'Site Dosyaları' })).toBeVisible({ timeout: 10000 });
        await expect(page.locator('button', { hasText: 'Yeni Dosya' })).toBeVisible();
        await expect(page.locator('button', { hasText: 'Yeni Klasör' })).toBeVisible();
        await expect(page.locator('button', { hasText: 'Dosya Yükle' })).toBeVisible();
        await expect(page.locator('.ws-breadcrumb')).toBeVisible();

        // Create new file
        await page.click('button:has-text("Yeni Dosya")');
        await expect(page.locator('h2', { hasText: 'Yeni Dosya Oluştur' })).toBeVisible();
        const testFileName = `e2e-${Date.now()}.txt`;
        await page.fill('input[placeholder*="index.html"]', testFileName);
        await page.click('button[type="submit"]:has-text("Oluştur")');

        // Verify file created in listing
        await expect(page.locator(`strong:has-text("${testFileName}")`)).toBeVisible({ timeout: 10000 });

        // Select checkbox for this file
        const row = page.locator(`tr:has(strong:has-text("${testFileName}"))`);
        await row.locator('input[type="checkbox"]').check();

        // Batch delete button should appear
        const batchBtn = page.locator('button:has-text("Seçilenleri Sil")');
        await expect(batchBtn).toBeVisible();

        // Single delete button
        await row.locator('button:has-text("Sil")').click();
        await expect(page.locator('h2', { hasText: 'silinsin mi?' })).toBeVisible();
        await page.fill('label:has-text("Onaylamak için") input', testFileName);
        await page.click('button[type="submit"]:has-text("Sil")');

        // Verify removed
        await expect(page.locator(`strong:has-text("${testFileName}")`)).not.toBeVisible({ timeout: 10000 });
      }
    }
  });
});
