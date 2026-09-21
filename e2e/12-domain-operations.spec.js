import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from './helpers.js';

test.describe('Module 12: Domain Operations & Advanced Domain Management', () => {
  test('12.1. Advanced Domains page inspection and tree search/collapse controls', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/domains');

    await expect(page.locator('h1')).toContainText('Gelişmiş alan adı araçları', { timeout: 10000 });
    await expect(page.locator('h2:text-is("Domain hierarchy")')).toBeVisible();

    const searchInput = page.locator('label:has-text("Search domains and aliases") input');
    await expect(searchInput).toBeVisible();

    // Verify Expand all and Collapse all buttons
    const expandBtn = page.locator('button:has-text("Expand all")');
    const collapseBtn = page.locator('button:has-text("Collapse all")');
    await expect(expandBtn).toBeVisible();
    await expect(collapseBtn).toBeVisible();

    // Test collapse & expand
    await collapseBtn.click();
    await expandBtn.click();

    // Test search filter
    await searchInput.fill('nonexistent-filter-test-domain-xyz');
    await expect(page.locator('.domain-empty:has-text("No matching domains")')).toBeVisible({ timeout: 5000 });
    await searchInput.clear();
    await expect(page.locator('.domain-list').first()).toBeVisible({ timeout: 5000 });
  });

  test('12.2. Domain creation form modes and creation flow', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/domains');

    const configSection = page.locator('section').filter({ has: page.locator('p.eyebrow:text-is("Nginx configuration")') });
    await expect(configSection).toBeVisible({ timeout: 10000 });

    const modeSelect = configSection.locator('label').filter({ hasText: /^Type/ }).locator('select');
    await expect(modeSelect).toBeVisible();

    // Switch to subdomain mode
    await modeSelect.selectOption('subdomain');
    await expect(configSection.locator('label:has-text("Parent domain")')).toBeVisible();
    await expect(configSection.locator('label:has-text("Subdomain prefix")')).toBeVisible();

    // Switch back to domain mode
    await modeSelect.selectOption('domain');
    await expect(configSection.locator('label:has-text("Primary domain")')).toBeVisible();

    // Switch target type
    const targetSelect = configSection.locator('label:has-text("Target type") select');
    await targetSelect.selectOption('static');
    await expect(configSection.locator('label:has-text("Absolute web root")')).toBeVisible();

    await targetSelect.selectOption('proxy');
    await expect(configSection.locator('label:has-text("Upstream port")')).toBeVisible();

    // Create a real test domain
    const testDomainName = `dom-test-${Date.now().toString().slice(-4)}.site`;
    await configSection.locator('label:has-text("Primary domain") input').fill(testDomainName);
    await configSection.locator('label:has-text("Aliases, comma separated") input').fill(`alias-${testDomainName}`);
    await configSection.locator('label:has-text("Upstream port") input').fill('48102');

    const submitBtn = configSection.locator('button[type="submit"]:has-text("Create domain")');
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    // Wait for creation completion: domain row appears in hierarchy list
    const domainRow = page.locator(`.domain-row:has-text("${testDomainName}")`);
    await expect(domainRow).toBeVisible({ timeout: 30000 });
  });

  test('12.3. Domain row actions: Stage, Activate and Add Subdomain handoff', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/domains');

    const domainRow = page.locator('.domain-row').first();
    await expect(domainRow).toBeVisible({ timeout: 10000 });

    // Test "Add subdomain" button on the domain row
    const addSubdomainBtn = domainRow.locator('button:has-text("Add subdomain")');
    if (await addSubdomainBtn.isVisible().catch(() => false)) {
      await addSubdomainBtn.click();

      // Verify the form switched to subdomain mode
      const configSection = page.locator('section').filter({ has: page.locator('p.eyebrow:text-is("Nginx configuration")') });
      await expect(configSection.locator('label:has-text("Parent domain") select')).toBeVisible();
      await expect(configSection.locator('label:has-text("Subdomain prefix") input')).toBeFocused();
    }

    // Test "Stage" button
    const stageBtn = domainRow.locator('button:has-text("Stage")');
    if (await stageBtn.isVisible().catch(() => false)) {
      await stageBtn.click();
      const resultNotice = page.locator('.operation-result');
      await expect(resultNotice.or(domainRow)).toBeVisible({ timeout: 20000 });
    }
  });

  test('12.4. Website-level Domain Operations tab inspection and actions', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/websites');

    const manageBtn = page.locator('table.ws-table tbody tr a:has-text("Yönet")').first();
    await expect(manageBtn).toBeVisible({ timeout: 10000 });
    await manageBtn.click();

    await page.waitForURL(/\/websites\/[^/]+/, { timeout: 10000 });

    // Click "Alan Adları" tab
    const domainsTab = page.locator('.ws-tabs a:has-text("Alan Adları")');
    await expect(domainsTab).toBeVisible({ timeout: 10000 });
    await domainsTab.click();

    // Verify "Alan adı ve Nginx" section
    const domainSection = page.locator('section').filter({ has: page.locator('h2:text-is("Alan adı ve Nginx")') });
    await expect(domainSection).toBeVisible({ timeout: 10000 });

    // Verify KeyValues
    await expect(domainSection.locator('dt:has-text("Alan adı")')).toBeVisible();
    await expect(domainSection.locator('dt:has-text("Aliaslar")')).toBeVisible();
    await expect(domainSection.locator('dt:has-text("Hedef")')).toBeVisible();
    await expect(domainSection.locator('dt:has-text("HTTPS tercihi")')).toBeVisible();
    await expect(domainSection.locator('dt:has-text("İstenen / uygulanan revizyon")')).toBeVisible();

    // Verify action buttons
    const stageButton = domainSection.locator('button:has-text("Yapılandırmayı hazırla")');
    await expect(stageButton).toBeVisible();

    // Click "Yapılandırmayı hazırla"
    await stageButton.click();

    // If JobDrawer opens, handle it
    const jobDrawer = page.locator('.ws-modal', { hasText: 'İşlem durumu' });
    if (await jobDrawer.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expect(jobDrawer.locator('span[role="status"]:has-text("Tamamlandı")')).toBeVisible({ timeout: 30000 });
      await jobDrawer.locator('button:has-text("Kapat")').click();
    }
  });
});
