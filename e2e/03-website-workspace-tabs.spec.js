import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs, openFirstWebsiteWorkspace } from './helpers.js';

test.describe('Module 3: Website Workspace & Plesk Tabs', () => {
  test('3.1. Overview tab displays breadcrumb, metadata, and quick action cards', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    // Verify breadcrumb
    await expect(page.locator('nav.ws-breadcrumb')).toBeVisible();

    // Verify workspace tabs
    const tabsNav = page.locator('nav.ws-tabs');
    await expect(tabsNav).toBeVisible();
    await expect(tabsNav.locator('a', { hasText: 'Genel bakış' })).toBeVisible();
    await expect(tabsNav.locator('a', { hasText: 'Alan adları' })).toBeVisible();
    await expect(tabsNav.locator('a', { hasText: 'SSL' })).toBeVisible();
    await expect(tabsNav.locator('a', { hasText: 'Bağlı kaynaklar' })).toBeVisible();

    // Verify Overview section and quick action buttons
    await expect(page.locator('h2:has-text("Yayın bilgileri")')).toBeVisible();
    await expect(page.locator('h2:has-text("Hızlı erişim")')).toBeVisible();
  });

  test('3.2. Domains tab displays domain operations and details', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    const domainsTab = page.locator('nav.ws-tabs a', { hasText: 'Alan adları' });
    await domainsTab.click();

    // Verify domains panel loaded
    await expect(page.locator('.ws-section', { hasText: /Alan adı|Alt alan adı|Alias/i }).first()).toBeVisible({ timeout: 10000 });
  });

  test('3.3. DNS tab renders DNS records or zone notice', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    const dnsTab = page.locator('nav.ws-tabs a', { hasText: 'DNS' });
    if (await dnsTab.count() > 0) {
      await dnsTab.click();
      // Expect either the DNS records table or the zone create button/notice
      const dnsContent = page.locator('.ws-section').filter({ hasText: /DNS|PowerDNS|Authoritative/i });
      await expect(dnsContent.first()).toBeVisible({ timeout: 10000 });
    }
  });

  test('3.4. SSL tab displays certificate status and controls', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    const sslTab = page.locator('nav.ws-tabs a', { hasText: 'SSL' });
    await sslTab.click();

    await expect(page.locator('.ws-section', { hasText: /SSL|Sertifika|HTTPS/i }).first()).toBeVisible({ timeout: 10000 });
  });

  test('3.5. Bound Resources tab displays Databases and Webmail with direct link', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    const resourcesTab = page.locator('nav.ws-tabs a', { hasText: 'Bağlı kaynaklar' });
    await resourcesTab.click();

    // Verify Databases section
    await expect(page.locator('.ws-section', { hasText: 'Veritabanları' })).toBeVisible({ timeout: 10000 });

    // Verify Mail & Webmail section
    const mailSection = page.locator('.ws-section', { hasText: /Mail|Webmail/i }).first();
    await expect(mailSection).toBeVisible({ timeout: 10000 });

    // Check for webmail link
    const webmailLink = page.locator('a[href^="https://webmail."]');
    if (await webmailLink.count() > 0) {
      const href = await webmailLink.first().getAttribute('href');
      expect(href).toMatch(/^https:\/\/webmail\./);
    }
  });

  test('3.6. Provisioning and Website Isolation panels in Overview tab', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    // Verify Provisioning panel or Isolation panel is rendered
    const provisioningOrIsolation = page.locator('.ws-section').filter({ hasText: /Site provisioning|Website izolasyon/i });
    await expect(provisioningOrIsolation.first()).toBeVisible({ timeout: 10000 });
  });

  test('3.7. Settings tab displays site metadata, server name, and runtime', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    const settingsTab = page.locator('nav.ws-tabs a', { hasText: 'Ayarlar' });
    await settingsTab.click();

    // Verify Site Ayarları section
    const settingsSection = page.locator('.ws-section:has-text("Site ayarları")');
    await expect(settingsSection).toBeVisible({ timeout: 10000 });
    await expect(settingsSection.locator('dt:has-text("Kayıt kimliği")')).toBeVisible();
    await expect(settingsSection.locator('dt:has-text("Sunucu")')).toBeVisible();
    await expect(settingsSection.locator('dt:has-text("Hedef türü")')).toBeVisible();
  });

  test('3.8. Recent jobs section in Overview tab', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    const overviewTab = page.locator('nav.ws-tabs a', { hasText: 'Genel bakış' });
    await overviewTab.click();

    const jobsSection = page.locator('.ws-section:has-text("Bu siteye ait son işlemler")');
    await expect(jobsSection).toBeVisible({ timeout: 10000 });
  });
});

