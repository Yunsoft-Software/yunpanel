import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from './helpers.js';

test.describe('Module 7: Mail & Webmail Management', () => {
  test('7.1. Mail Domains navigation, list view, and creation modal verification', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    await page.goto('/mail');
    await expect(page.locator('h1:has-text("Mail")')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Yerel Postfix/Dovecot/Rspamd mail domainleri')).toBeVisible();

    // Verify existing mail domains list has rows
    await expect(page.locator('table.ws-table tbody tr').first()).toBeVisible({ timeout: 10000 });

    // Verify Mail domain ekle button opens modal
    const addBtn = page.locator('button:has-text("Mail domain ekle")').first();
    await expect(addBtn).toBeVisible();
    await addBtn.click();

    // Verify modal elements
    const modal = page.locator('dialog[open]');
    await expect(modal.locator('h2:has-text("Mail domain ekle")')).toBeVisible({ timeout: 10000 });
    await expect(modal.locator('select').first()).toBeVisible();
    await expect(modal.locator('p:has-text("Mail domain adı seçilen web Domain ile birebir aynıdır")')).toBeVisible();

    // Close modal
    await modal.locator('button:has-text("Vazgeç")').click();
    await expect(page.locator('dialog[open]')).toHaveCount(0, { timeout: 10000 });
  });

  test('7.2. Mail Domain details and panels inspection', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/mail');

    // Click "Yönet" on the first local mail domain
    const manageLink = page.locator('table.ws-table tbody tr a:has-text("Yönet")').first();
    await expect(manageLink).toBeVisible({ timeout: 10000 });
    await manageLink.click();

    // Should navigate to detail page /mail/:mailDomainId
    await page.waitForURL(/\/mail\/[^/]+/, { timeout: 15000 });
    await expect(page.locator('h1')).toBeVisible({ timeout: 10000 });

    // Verify all management sections
    await expect(page.locator('h2:has-text("Domain durumu")')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('h2:has-text("Webmail (Roundcube)")')).toBeVisible();
    await expect(page.locator('h2:has-text("Host mail configuration")')).toBeVisible();
    await expect(page.locator('h2:has-text("Mailboxlar")')).toBeVisible();
    await expect(page.locator('h2:has-text("Mail aliasları")')).toBeVisible();
    await expect(page.locator('h2:has-text("DKIM")')).toBeVisible();
    await expect(page.locator('h2:has-text("Mail diagnostics")')).toBeVisible();
  });

  test('7.3. Mailbox and Alias creation modal interactions', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/mail');

    // Click "Yönet"
    const manageBtn = page.locator('table.ws-table tbody tr a:has-text("Yönet")').first();
    await expect(manageBtn).toBeVisible({ timeout: 10000 });
    await manageBtn.click();
    await page.waitForURL(/\/mail\/[^/]+/, { timeout: 10000 });

    // Open Mailbox creation modal
    const mailboxBtn = page.locator('button:has-text("Mailbox oluştur")').first();
    await expect(mailboxBtn).toBeVisible({ timeout: 10000 });
    await mailboxBtn.click();

    const mailboxModal = page.locator('dialog[open]');
    await expect(mailboxModal.locator('h2:has-text("Mailbox oluştur")')).toBeVisible({ timeout: 10000 });
    await expect(mailboxModal.locator('.ws-inline-input input')).toBeVisible();
    await expect(mailboxModal.locator('input[type="password"]')).toBeVisible();
    await mailboxModal.locator('button:has-text("Vazgeç")').click();
    await expect(page.locator('dialog[open]')).toHaveCount(0, { timeout: 10000 });

    // Open Alias creation modal
    const aliasBtn = page.locator('button:has-text("Alias oluştur")').first();
    await expect(aliasBtn).toBeVisible({ timeout: 10000 });
    await aliasBtn.click();

    const aliasModal = page.locator('dialog[open]');
    await expect(aliasModal.locator('h2:has-text("Alias oluştur")')).toBeVisible({ timeout: 10000 });
    await expect(aliasModal.locator('.ws-inline-input input')).toBeVisible();
    await expect(aliasModal.locator('textarea')).toBeVisible();
    await aliasModal.locator('button:has-text("Vazgeç")').click();
    await expect(page.locator('dialog[open]')).toHaveCount(0, { timeout: 10000 });
  });
});
