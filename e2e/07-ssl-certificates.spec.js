import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs, openFirstWebsiteWorkspace } from './helpers.js';

test.describe('Module 7: SSL/TLS Certificate Management', () => {
  test('7.1. SSL tab: inspect certificate status, validity and HTTPS preference', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    const sslTab = page.locator('nav.ws-tabs a', { hasText: 'SSL' });
    await expect(sslTab).toBeVisible({ timeout: 10000 });
    await sslTab.click();

    // Section "SSL sertifikası"
    const sslSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'SSL sertifikası' }) });
    await expect(sslSection).toBeVisible({ timeout: 15000 });

    // Verify key values
    await expect(sslSection.locator('dt', { hasText: 'Sertifika adı' })).toBeVisible({ timeout: 10000 });
    await expect(sslSection.locator('dt', { hasText: 'Kapsam' })).toBeVisible();
    await expect(sslSection.locator('dt', { hasText: 'Başlangıç' })).toBeVisible();
    await expect(sslSection.locator('dt', { hasText: 'Bitiş' })).toBeVisible();
    await expect(sslSection.locator('dt', { hasText: 'HTTPS tercihi' })).toBeVisible();
  });

  test('7.2. SSL actions: dry-run renewal or ACME issue modal flow', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    await page.locator('nav.ws-tabs a', { hasText: 'SSL' }).click();

    const sslSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'SSL sertifikası' }) });
    await expect(sslSection).toBeVisible({ timeout: 15000 });

    // Check if certificate is active or unissued
    const renewTestBtn = sslSection.locator('button:has-text("Yenilemeyi test et")');
    const renewBtn = sslSection.locator('button:has-text("Sertifikayı yenile")');
    const issueBtn = sslSection.locator('button:has-text("Production sertifikası iste")');

    if (await renewBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      // 1. Verify renew confirmation modal first (before dryRun locks resource)
      await expect(renewBtn).toBeEnabled({ timeout: 45000 });
      await renewBtn.click();
      const confirmDialog = page.locator('.ws-modal', { hasText: 'SSL yenilemesini başlat' });
      await expect(confirmDialog).toBeVisible({ timeout: 5000 });
      await expect(confirmDialog.locator('button:has-text("İşlemi başlat")')).toBeVisible();

      // Cancel modal
      await confirmDialog.locator('button:has-text("Vazgeç")').click();
      await expect(confirmDialog).not.toBeVisible({ timeout: 5000 });

      // 2. Click "Yenilemeyi test et" (dry run)
      await expect(renewTestBtn).toBeEnabled({ timeout: 10000 });
      await renewTestBtn.click();
    } else if (await issueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Unissued cert path: fill email and test staging/issue modal
      const emailInput = sslSection.locator('label:has-text("ACME hesap e-postası") input');
      await emailInput.fill('admin@test-yunpanel.com');

      const stagingBtn = sslSection.locator('button:has-text("ACME doğrulamasını test et")');
      await expect(stagingBtn).toBeEnabled();

      await issueBtn.click();
      const confirmDialog = page.locator('.ws-modal', { hasText: 'Production sertifikası iste' });
      await expect(confirmDialog).toBeVisible({ timeout: 5000 });

      await confirmDialog.locator('button:has-text("Vazgeç")').click();
      await expect(confirmDialog).not.toBeVisible({ timeout: 5000 });
    }
  });

  test('7.3. System SSL Settings: inspect global DNS/SSL policy on /settings', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/settings');

    const policySection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'DNS ve SSL politikası' }) });
    await expect(policySection).toBeVisible({ timeout: 15000 });

    // Verify key values
    await expect(policySection.locator('dt', { hasText: 'Yetkili DNS motoru' })).toBeVisible();
    await expect(policySection.locator('dd', { hasText: 'PowerDNS Authoritative' })).toBeVisible();

    await expect(policySection.locator('dt', { hasText: 'ACME sağlayıcısı' })).toBeVisible();
    await expect(policySection.locator('dd', { hasText: "Let's Encrypt" })).toBeVisible();

    await expect(policySection.locator('dt', { hasText: 'ACME iletişim e-postası' })).toBeVisible();
    await expect(policySection.locator('dt', { hasText: 'Otomatik yenileme döngüsü' })).toBeVisible();
    await expect(policySection.locator('dt', { hasText: 'Özel sertifika deposu' })).toBeVisible();
  });
});
