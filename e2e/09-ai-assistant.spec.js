import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from './helpers.js';

test.describe('Module 9: AI Assistant & AI Management', () => {
  test('9.1. AI Drawer trigger button in top navigation, dialog open/close lifecycle', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    // AI Asistan button must be in the top nav
    const aiBtn = page.locator('button:has-text("AI Asistan")');
    await expect(aiBtn).toBeVisible({ timeout: 10000 });
    await aiBtn.click();

    // Dialog opens
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await expect(dialog.locator('h2:has-text("YunPanel AI Yönetim Asistanı")')).toBeVisible();

    // Input and send button exist
    const input = dialog.locator('input[placeholder*="sorun"]');
    await expect(input).toBeVisible();
    const sendBtn = dialog.locator('button:has-text("Gönder")');
    await expect(sendBtn).toBeVisible();

    // Close dialog
    await dialog.locator('button[aria-label="Pencereyi kapat"]').click();
    await expect(page.locator('dialog[open]')).toHaveCount(0, { timeout: 10000 });
  });

  test('9.2. AI message sending, active URL preservation (no redirect bug), and DOM presence', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    // Navigate to a specific page first (/websites)
    await page.goto('/websites');
    await expect(page.locator('h1:has-text("Web siteleri")')).toBeVisible({ timeout: 10000 });
    const initialUrl = page.url();

    // Open AI Drawer
    await page.click('button:has-text("AI Asistan")');
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible({ timeout: 10000 });

    // Type message
    const testMessage = `Test Prompt ${Date.now()}`;
    const input = dialog.locator('input[placeholder*="sorun"]');
    await input.fill(testMessage);

    // Click Send
    await dialog.locator('button:has-text("Gönder")').click();

    // CRITICAL REGRESSION TEST: The URL must NOT redirect to /dashboard
    await page.waitForTimeout(1500);
    expect(page.url()).toBe(initialUrl);

    // Dialog must remain open and mounted without React error boundary crash
    await expect(dialog).toBeVisible();

    // Guidance alert or message response appears cleanly inside the dialog
    await expect(dialog.locator('.ws-notice, [role="alert"], div[role="status"]').first()).toBeVisible({ timeout: 10000 });
  });

  test('9.3. AI Settings & Provider Management form in Settings', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    await page.goto('/settings');
    await expect(page.locator('h1:has-text("Ayarlar")')).toBeVisible({ timeout: 10000 });

    // Verify AI Asistanı section
    const aiSection = page.locator('h2:has-text("AI Asistanı ve Model Sağlayıcıları")');
    await expect(aiSection).toBeVisible({ timeout: 10000 });

    // Click "Yeni Sağlayıcı Ekle" button
    const addProvBtn = page.locator('button:has-text("Yeni Sağlayıcı Ekle")');
    await expect(addProvBtn).toBeVisible();
    await addProvBtn.click();

    // Verify provider configuration form elements
    await expect(page.locator('label:has-text("Sağlayıcı Kimliği") input')).toBeVisible();
    await expect(page.locator('label:has-text("Sağlayıcı Türü") select')).toBeVisible();
    await expect(page.locator('label:has-text("API Anahtarı") input')).toBeVisible();

    // Cancel form
    await page.click('button:has-text("Vazgeç")');
    await expect(addProvBtn).toBeVisible();
  });
});
