import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from './helpers.js';

test.describe('Module 13: System & Services Management', () => {
  test('13.1. Managed Services panel inspection and refresh on /servers', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/servers');

    await expect(page.locator('h1')).toContainText('Sunucu', { timeout: 10000 });

    // Dismiss JobDrawer if open
    const existingJobModal = page.locator('.ws-modal', { hasText: 'İşlem durumu' });
    if (await existingJobModal.isVisible()) {
      await existingJobModal.locator('button:has-text("Kapat")').click();
      await expect(existingJobModal).not.toBeVisible({ timeout: 5000 });
    }

    // Verify Managed Services section
    const servicesSection = page.locator('section').filter({ has: page.locator('h2:has-text("Sistem servisleri")') });
    await expect(servicesSection).toBeVisible({ timeout: 15000 });

    // Verify refresh action
    const refreshBtn = servicesSection.locator('button:has-text("Kaydı yenile")');
    await expect(refreshBtn).toBeVisible();
    await refreshBtn.click();

    // Verify services table
    const table = servicesSection.locator('table.ws-table');
    await expect(table).toBeVisible({ timeout: 15000 });

    await expect(table.locator('th:has-text("Servis")')).toBeVisible();
    await expect(table.locator('th:has-text("Tür")')).toBeVisible();
    await expect(table.locator('th:has-text("Paket")')).toBeVisible();
    await expect(table.locator('th:has-text("Durum")')).toBeVisible();
    await expect(table.locator('th:has-text("İşlemler")')).toBeVisible();

    // Verify presence of core infrastructure services
    await expect(table.locator('tr:has-text("Nginx")')).toBeVisible();
    await expect(table.locator('tr').filter({ hasText: 'mariadb.service' })).toBeVisible();
  });

  test('13.2. Managed Services action confirmation modal flow', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/servers');

    // Dismiss JobDrawer if open from previous run
    const existingJobModal = page.locator('.ws-modal', { hasText: 'İşlem durumu' });
    if (await existingJobModal.isVisible()) {
      await existingJobModal.locator('button:has-text("Kapat")').click();
      await expect(existingJobModal).not.toBeVisible({ timeout: 5000 });
    }

    const servicesSection = page.locator('section').filter({ has: page.locator('h2:has-text("Sistem servisleri")') });
    await expect(servicesSection).toBeVisible({ timeout: 15000 });

    const table = servicesSection.locator('table.ws-table');
    await expect(table).toBeVisible({ timeout: 15000 });

    // Find a service row with an action button (e.g. Yeniden başlat, Kur, or Başlat)
    const actionBtn = table.locator('tbody tr td.ws-row-end button').first();
    await expect(actionBtn).toBeVisible({ timeout: 10000 });
    await expect(actionBtn).toBeEnabled({ timeout: 10000 });
    await actionBtn.click();

    // Verify ConfirmDialog
    const confirmModal = page.locator('.ws-modal').filter({ has: page.locator('button:has-text("Vazgeç")') });
    await expect(confirmModal).toBeVisible({ timeout: 5000 });
    await expect(confirmModal.locator('button:has-text("Vazgeç")')).toBeVisible();

    // Safely cancel without mutating service
    await confirmModal.locator('button:has-text("Vazgeç")').click();
    await expect(confirmModal).not.toBeVisible({ timeout: 5000 });
  });

  test('13.3. Server DNS Identity & Network settings inspection on /settings', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/settings?section=dns');

    await expect(page.locator('h1')).toContainText('Ayarlar', { timeout: 10000 });

    // Verify "Network / Authoritative DNS" section
    const dnsSection = page.locator('section').filter({ has: page.locator('h2:text-is("Network / Authoritative DNS")') });
    await expect(dnsSection).toBeVisible({ timeout: 15000 });

    // Verify KeyValues
    await expect(dnsSection.locator('dt:has-text("Sunucu hostname")')).toBeVisible();
    await expect(dnsSection.locator('dt:has-text("Public IPv4")')).toBeVisible();
    await expect(dnsSection.locator('dt:has-text("ns1")')).toBeVisible();
    await expect(dnsSection.locator('dt:has-text("ns2")')).toBeVisible();
    await expect(dnsSection.locator('dt:has-text("SOA responsible name")')).toBeVisible();

    // Test DNS Identity Dialog
    const editIdentityBtn = dnsSection.locator('button:has-text("DNS kimliğini düzenle"), button:has-text("DNS kimliğini yapılandır")');
    await expect(editIdentityBtn).toBeVisible();
    await editIdentityBtn.click();

    const identityModal = page.locator('.ws-modal', { hasText: 'Authoritative DNS kimliği' });
    await expect(identityModal).toBeVisible({ timeout: 5000 });

    // Verify form fields
    await expect(identityModal.locator('label:has-text("Public IPv4") input')).toBeVisible();
    await expect(identityModal.locator('label:has-text("ns1 hostname") input')).toBeVisible();
    await expect(identityModal.locator('label:has-text("ns1 IPv4") input')).toBeVisible();
    await expect(identityModal.locator('label:has-text("ns2 hostname") input')).toBeVisible();
    await expect(identityModal.locator('label:has-text("ns2 IPv4") input')).toBeVisible();
    await expect(identityModal.locator('label:has-text("Responsible name") input')).toBeVisible();
    await expect(identityModal.locator('label:has-text("TTL") input')).toBeVisible();

    // Close modal
    await identityModal.locator('button:has-text("Vazgeç")').click();
    await expect(identityModal).not.toBeVisible({ timeout: 5000 });
  });

  test('13.4. DNS Delegation inspection and PowerDNS health panels on /settings', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/settings?section=dns');

    // Verify PowerDNS local / public health section
    const healthSection = page.locator('section').filter({ has: page.locator('h2:text-is("PowerDNS local / public health")') });
    await expect(healthSection).toBeVisible({ timeout: 15000 });

    await expect(healthSection.locator('dt:has-text("Configured")')).toBeVisible();
    await expect(healthSection.locator('dt:has-text("Local UDP/53")')).toBeVisible();
    await expect(healthSection.locator('dt:has-text("Local TCP/53")')).toBeVisible();

    // Verify Delegation section
    const delegationSection = page.locator('section').filter({ has: page.locator('h2:text-is("Registrar / delegation")') });
    await expect(delegationSection).toBeVisible({ timeout: 15000 });

    const domainInput = delegationSection.locator('label:has-text("Kontrol edilecek root domain") input');
    await expect(domainInput).toBeVisible();

    const checkBtn = delegationSection.locator('button[type="submit"]:has-text("Delegation kontrol et")');
    await expect(checkBtn).toBeVisible();
  });
});
