import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from './helpers.js';

test.describe('Module 15: AI Assistant & Provider Settings', () => {
  test('15.1. AI Drawer global modal trigger, chat session management and context', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/dashboard');

    // Click global AI Assistant button in toolbar
    const aiBtn = page.locator('.ws-toolbar button:has-text("AI Asistan")');
    await expect(aiBtn).toBeVisible({ timeout: 10000 });
    await aiBtn.click();

    // Verify AiDrawer modal opens
    const drawerModal = page.locator('.ws-modal', { hasText: 'YunPanel AI Yönetim Asistanı' });
    await expect(drawerModal).toBeVisible({ timeout: 10000 });

    // Verify sidebar elements
    await expect(drawerModal.locator('span:text-is("SOHBETLER")')).toBeVisible();
    const newChatBtn = drawerModal.locator('button:has-text("Yeni")');
    await expect(newChatBtn).toBeVisible();

    // Create a new chat session
    await newChatBtn.click();

    // Verify chat input area
    const chatInput = drawerModal.locator('input[placeholder*="sorun"], textarea[placeholder*="sorun"], input[type="text"]').last();
    await expect(chatInput).toBeVisible({ timeout: 10000 });

    // Close drawer modal
    const closeBtn = drawerModal.locator('button[aria-label="Pencereyi kapat"]').first();
    await closeBtn.click();
    await expect(drawerModal).not.toBeVisible({ timeout: 5000 });
  });

  test('15.2. AI Provider Settings: form validation, provider addition and cleanup on /settings', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/settings');

    const aiSection = page.locator('section').filter({ has: page.locator('h2:text-is("AI Asistanı ve Model Sağlayıcıları")') });
    await expect(aiSection).toBeVisible({ timeout: 15000 });

    const addBtn = aiSection.locator('button:has-text("Sağlayıcı ekle")');
    await expect(addBtn).toBeVisible();
    await addBtn.click();

    // Verify form fields
    const form = aiSection.locator('form');
    await expect(form).toBeVisible();

    const idInput = form.locator('label:has-text("Sağlayıcı kimliği") input');
    const typeSelect = form.locator('label:has-text("Sağlayıcı türü") select');
    const modelInput = form.locator('label:has-text("Varsayılan model") input');
    const baseUrlInput = form.locator('label:has-text("Base URL") input');
    const saveBtn = form.locator('button[type="submit"]:has-text("Kaydet")');

    await expect(idInput).toBeVisible();
    await expect(typeSelect).toBeVisible();

    // Test filling Ollama provider (which doesn't require API key)
    const testProvId = `test-ollama-${Date.now().toString().slice(-4)}`;
    await idInput.fill(testProvId);
    await typeSelect.selectOption('ollama');
    await baseUrlInput.fill('http://127.0.0.1:11434');
    await modelInput.fill('llama3.2');

    // Uncheck "Aktif sağlayıcı yap" to not disrupt any existing active provider
    const activeCheckbox = form.locator('input[type="checkbox"]');
    if (await activeCheckbox.isChecked()) {
      await activeCheckbox.uncheck();
    }

    await saveBtn.click();

    // Verify provider card is rendered in list
    const provCard = aiSection.locator('div').filter({ has: page.locator(`strong:text-is("${testProvId}")`) }).first();
    await expect(provCard).toBeVisible({ timeout: 15000 });

    // Clean up: delete test provider deterministically
    page.once('dialog', (dialog) => dialog.accept());
    const deleteBtn = provCard.locator('button:has-text("Sil")');
    await expect(deleteBtn).toBeVisible({ timeout: 5000 });
    await deleteBtn.click();
    await expect(provCard).not.toBeVisible({ timeout: 10000 });
  });
});
