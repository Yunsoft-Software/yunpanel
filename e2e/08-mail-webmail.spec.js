import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from './helpers.js';

test.describe('Module 8: Mail & Webmail Management', () => {
  test('8.1. Mail Domains navigation, list view, and creation modal verification', async ({ page }) => {
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
    const modal = page.locator('.ws-modal', { hasText: 'Mail domain ekle' });
    await expect(modal).toBeVisible({ timeout: 5000 });
    await expect(modal.locator('select').first()).toBeVisible();
    await expect(modal.locator('p:has-text("Mail domain adı seçilen web Domain ile birebir aynıdır")')).toBeVisible();

    // Close modal
    await modal.locator('button:has-text("Vazgeç")').click();
    await expect(modal).not.toBeVisible({ timeout: 5000 });
  });

  test('8.2. Mailbox creation: create real mailbox and verify row in table', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/mail');

    // Click "Yönet" on the first local mail domain
    const manageLink = page.locator('table.ws-table tbody tr a:has-text("Yönet")').first();
    await expect(manageLink).toBeVisible({ timeout: 10000 });
    await manageLink.click();

    await page.waitForURL(/\/mail\/[^/]+/, { timeout: 15000 });

    // Open Mailbox creation modal
    const mailboxSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Mailboxlar' }) });
    await expect(mailboxSection).toBeVisible({ timeout: 10000 });

    const createBtn = mailboxSection.locator('button:has-text("Mailbox oluştur")').first();
    await expect(createBtn).toBeVisible();
    await createBtn.click();

    const createModal = page.locator('.ws-modal', { hasText: 'Mailbox oluştur' });
    await expect(createModal).toBeVisible({ timeout: 5000 });

    // Generate unique local part to avoid collisions
    const localPart = `e2ebox${Date.now().toString().slice(-6)}`;
    await createModal.locator('.ws-inline-input input').fill(localPart);
    await createModal.locator('input[type="password"]').fill('P@ssw0rdE2ETest2026!');

    // Submit
    const submitBtn = createModal.locator('button:has-text("Mailbox oluştur")');
    await submitBtn.click();

    await expect(createModal).not.toBeVisible({ timeout: 15000 });

    // Verify mailbox appears in table
    const mailboxRow = mailboxSection.locator('table tbody tr', { hasText: localPart });
    await expect(mailboxRow).toBeVisible({ timeout: 10000 });
    await expect(mailboxRow.locator('span.ws-badge:has-text("enabled")')).toBeVisible();
    await expect(mailboxRow).toContainText('Parola configured');
  });

  test('8.3. Mailbox policy, password rotation, and enable/disable toggle', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/mail');

    const manageLink = page.locator('table.ws-table tbody tr a:has-text("Yönet")').first();
    await manageLink.click();
    await page.waitForURL(/\/mail\/[^/]+/, { timeout: 15000 });

    const mailboxSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Mailboxlar' }) });
    await expect(mailboxSection).toBeVisible({ timeout: 10000 });

    // Pick the first mailbox in the table
    const mailboxRow = mailboxSection.locator('table tbody tr').first();
    await expect(mailboxRow).toBeVisible({ timeout: 10000 });

    // 1. Toggle Disable / Enable
    const toggleBtn = mailboxRow.locator('button:has-text("Disable"), button:has-text("Enable")');
    const initialText = (await toggleBtn.textContent())?.trim();
    await toggleBtn.click();

    const expectedNextText = initialText === 'Disable' ? 'Enable' : 'Disable';
    await expect(mailboxRow.locator(`button:has-text("${expectedNextText}")`)).toBeVisible({ timeout: 10000 });

    // Revert toggle
    await mailboxRow.locator(`button:has-text("${expectedNextText}")`).click();
    await expect(mailboxRow.locator(`button:has-text("${initialText}")`)).toBeVisible({ timeout: 10000 });

    // 2. Test Password Rotation modal
    const passwordBtn = mailboxRow.locator('button:has-text("Parola")');
    await passwordBtn.click();

    const passwordModal = page.locator('.ws-modal', { hasText: 'Mailbox parolasını değiştir' });
    await expect(passwordModal).toBeVisible({ timeout: 5000 });

    await passwordModal.locator('input[type="password"]').fill('NewP@ssw0rd9988!!');
    await passwordModal.locator('button:has-text("Parolayı değiştir")').click();
    await expect(passwordModal).not.toBeVisible({ timeout: 15000 });

    // 3. Test Policy panel (Quota & Forwarding)
    const policyBtn = mailboxRow.locator('button:has-text("Policy")');
    await policyBtn.click();

    const policySection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Mailbox policy' }) });
    await expect(policySection).toBeVisible({ timeout: 10000 });

    // Wait for policy to load and quota input to be enabled
    const quotaInput = policySection.locator('label:has-text("Quota (MiB)") input');
    await expect(quotaInput).toBeEnabled({ timeout: 10000 });

    // Save quota
    await quotaInput.fill('512');
    const saveQuotaBtn = policySection.locator('button:has-text("Quota kaydet")');
    await expect(saveQuotaBtn).toBeEnabled({ timeout: 5000 });
    await saveQuotaBtn.click();
    await expect(policySection.locator('p:has-text("512 MiB")')).toBeVisible({ timeout: 10000 });

    // Save forwarding
    const destTextarea = policySection.locator('label:has-text("Hedefler") textarea');
    await expect(destTextarea).toBeEnabled({ timeout: 10000 });
    await destTextarea.fill('e2e-forward-target@example.com');
    const saveFwdBtn = policySection.locator('button:has-text("Forwarding kaydet")');
    await expect(saveFwdBtn).toBeEnabled({ timeout: 5000 });
    await saveFwdBtn.click();
    await expect(policySection.locator('p:has-text("e2e-forward-target@example.com")')).toBeVisible({ timeout: 10000 });

    // Clean up quota
    const clearQuotaBtn = policySection.locator('button:has-text("Quota kaldır")');
    if (await clearQuotaBtn.isVisible()) {
      await clearQuotaBtn.click();
      const confirmDialog = page.locator('.ws-modal', { hasText: 'Mailbox quota policy kaldır' });
      await expect(confirmDialog).toBeVisible({ timeout: 5000 });
      const confirmCode = (await confirmDialog.locator('label strong').textContent())?.trim();
      await confirmDialog.locator('label input').fill(confirmCode);
      await confirmDialog.locator('button:has-text("Quota policy kaldır")').click();
      await expect(confirmDialog).not.toBeVisible({ timeout: 10000 });
    }

    // Clean up forwarding
    const clearFwdBtn = policySection.locator('button:has-text("Forwarding kaldır")');
    if (await clearFwdBtn.isVisible()) {
      await clearFwdBtn.click();
      const confirmDialog = page.locator('.ws-modal', { hasText: 'Mailbox forwarding policy kaldır' });
      await expect(confirmDialog).toBeVisible({ timeout: 5000 });
      const confirmCode = (await confirmDialog.locator('label strong').textContent())?.trim();
      await confirmDialog.locator('label input').fill(confirmCode);
      await confirmDialog.locator('button:has-text("Forwarding policy kaldır")').click();
      await expect(confirmDialog).not.toBeVisible({ timeout: 10000 });
    }
  });

  test('8.4. Mail Alias: create, edit, and delete lifecycle', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/mail');

    const manageLink = page.locator('table.ws-table tbody tr a:has-text("Yönet")').first();
    await manageLink.click();
    await page.waitForURL(/\/mail\/[^/]+/, { timeout: 15000 });

    const aliasSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Mail aliasları' }) });
    await expect(aliasSection).toBeVisible({ timeout: 10000 });

    // Click "Alias oluştur"
    const createBtn = aliasSection.locator('button:has-text("Alias oluştur")').first();
    await createBtn.click();

    const createModal = page.locator('.ws-modal', { hasText: 'Alias oluştur' });
    await expect(createModal).toBeVisible({ timeout: 5000 });

    const aliasSource = `alias${Date.now().toString().slice(-6)}`;
    await createModal.locator('.ws-inline-input input').fill(aliasSource);
    await createModal.locator('textarea').fill('dest1@example.com\ndest2@example.com');

    await createModal.locator('button:has-text("Alias oluştur")').click();
    await expect(createModal).not.toBeVisible({ timeout: 15000 });

    // Verify alias in table
    const aliasRow = aliasSection.locator('table tbody tr', { hasText: aliasSource });
    await expect(aliasRow).toBeVisible({ timeout: 10000 });
    await expect(aliasRow).toContainText('dest1@example.com, dest2@example.com');

    // Edit alias
    await aliasRow.locator('button:has-text("Düzenle")').click();
    const editModal = page.locator('.ws-modal', { hasText: 'Alias düzenle' });
    await expect(editModal).toBeVisible({ timeout: 5000 });

    await editModal.locator('textarea').fill('dest3-updated@example.com');
    await editModal.locator('button:has-text("Aliası kaydet")').click();
    await expect(editModal).not.toBeVisible({ timeout: 15000 });

    await expect(aliasRow).toContainText('dest3-updated@example.com', { timeout: 10000 });

    // Delete alias
    await aliasRow.locator('button:has-text("Sil")').click();
    const confirmDialog = page.locator('.ws-modal', { hasText: 'Mail aliasını sil' });
    await expect(confirmDialog).toBeVisible({ timeout: 5000 });

    const confirmCode = (await confirmDialog.locator('label strong').textContent())?.trim();
    await confirmDialog.locator('label input').fill(confirmCode);
    await confirmDialog.locator('button:has-text("Aliası sil")').click();

    await expect(confirmDialog).not.toBeVisible({ timeout: 15000 });
    await expect(aliasSection.locator('table tbody tr', { hasText: aliasSource })).not.toBeVisible({ timeout: 10000 });
  });

  test('8.5. Webmail, DKIM, and Diagnostics inspection', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/mail');

    const manageLink = page.locator('table.ws-table tbody tr a:has-text("Yönet")').first();
    await manageLink.click();
    await page.waitForURL(/\/mail\/[^/]+/, { timeout: 15000 });

    // Webmail section
    const webmailSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Webmail (Roundcube)' }) });
    await expect(webmailSection).toBeVisible({ timeout: 10000 });

    // DKIM section
    const dkimSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'DKIM' }) });
    await expect(dkimSection).toBeVisible({ timeout: 10000 });

    // Mail diagnostics section
    const diagSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Mail diagnostics' }) });
    await expect(diagSection).toBeVisible({ timeout: 10000 });
  });
});
