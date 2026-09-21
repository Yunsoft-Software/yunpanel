import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs, openFirstWebsiteWorkspace } from './helpers.js';

test.describe('Module 5: Native Sandboxed Web Terminal', () => {
  test('5.1. Website Terminal: open connection, verify isolated site context', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    const termTab = page.locator('nav.ws-tabs a', { hasText: 'Terminal' });
    await expect(termTab).toBeVisible();
    await termTab.click();

    // Verify initial idle state
    await expect(page.locator('.ws-terminal-surface')).toBeVisible({ timeout: 10000 });
    const connectBtn = page.locator('button:has-text("Terminali aç")');
    await expect(connectBtn).toBeVisible();
    await expect(page.locator('span[role="status"]:has-text("Bağlantı kapalı")')).toBeVisible();

    // Connect
    await connectBtn.click();

    // Wait for connected status
    await expect(page.locator('span[role="status"]:has-text("Bağlı")')).toBeVisible({ timeout: 15000 });

    // Verify terminal context displays isolated user & directory
    const contextEl = page.locator('.ws-terminal-context');
    await expect(contextEl).toBeVisible();
    await expect(contextEl).toContainText('yunapp-');
    await expect(contextEl).toContainText('/var/lib/yunpanel/apps/');
  });

  test('5.2. Website Terminal: execute shell command and observe real-time output in DOM', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    await page.locator('nav.ws-tabs a', { hasText: 'Terminal' }).click();
    await expect(page.locator('.ws-terminal-surface')).toBeVisible({ timeout: 10000 });

    const connectBtn = page.locator('button:has-text("Terminali aç"), button:has-text("Yeniden bağlan")');
    await expect(connectBtn).toBeVisible({ timeout: 10000 });
    await connectBtn.click();
    await expect(page.locator('span[role="status"]:has-text("Bağlı")')).toBeVisible({ timeout: 15000 });

    // Focus xterm terminal
    const terminalSurface = page.locator('.ws-terminal-surface');
    await terminalSurface.click();

    // Send command via keyboard
    const marker = `TEST_TERMINAL_${Date.now()}`;
    await page.keyboard.type(`echo "${marker}"`);
    await page.keyboard.press('Enter');

    // Wait for echo output to appear in terminal DOM rows
    const xtermRows = page.locator('.xterm-rows');
    await expect(xtermRows).toContainText(marker, { timeout: 10000 });

    // Run whoami
    await page.keyboard.type('whoami');
    await page.keyboard.press('Enter');
    await expect(xtermRows).toContainText('yunapp-', { timeout: 10000 });
  });

  test('5.3. Website Terminal: clear buffer and disconnect lifecycle', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    await page.locator('nav.ws-tabs a', { hasText: 'Terminal' }).click();
    await expect(page.locator('.ws-terminal-surface')).toBeVisible({ timeout: 10000 });

    const connectBtn = page.locator('button:has-text("Terminali aç"), button:has-text("Yeniden bağlan")');
    if (await connectBtn.isVisible()) {
      await connectBtn.click();
    }
    await expect(page.locator('span[role="status"]:has-text("Bağlı")')).toBeVisible({ timeout: 15000 });

    // Clear terminal
    const clearBtn = page.locator('button:has-text("Temizle")');
    await expect(clearBtn).toBeVisible();
    await clearBtn.click();

    // Disconnect
    const disconnectBtn = page.locator('button:has-text("Bağlantıyı kapat")');
    await expect(disconnectBtn).toBeVisible();
    await disconnectBtn.click();

    // Verify disconnected state
    await expect(page.locator('span[role="status"]:has-text("Bağlantı kapandı")')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('button:has-text("Yeniden bağlan")')).toBeVisible();
  });
});
