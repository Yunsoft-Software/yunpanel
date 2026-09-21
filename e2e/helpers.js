import fs from 'fs';
import path from 'path';
import { expect } from '@playwright/test';

export const OWNER_USERNAME = process.env.PANEL_OWNER_USER || 'yunsoft-owner';
export const OWNER_PASSWORD = process.env.PANEL_OWNER_PASSWORD || 'b70646fcd0ceb42481c2f4fff95466493de0';

const AUTH_DIR = path.resolve(process.cwd(), 'e2e/.auth');
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

export async function loginAs(page, username, password) {
  const authFile = path.join(AUTH_DIR, `${username}.json`);
  if (fs.existsSync(authFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(authFile, 'utf8'));
      if (state.cookies && state.cookies.length) {
        await page.context().addCookies(state.cookies);
      }
    } catch {
      // ignore corrupt cache
    }
  }

  await page.goto('/');
  const sessionBar = page.locator('.auth-sessionbar');
  const authForm = page.locator('form.auth-form');

  await expect(sessionBar.or(authForm)).toBeVisible({ timeout: 15000 });

  if (await sessionBar.isVisible()) {
    const text = await sessionBar.textContent();
    if (text.includes(username)) {
      // Successfully authenticated
      try {
        await page.context().storageState({ path: authFile });
      } catch {}
      return;
    }
    await logout(page);
    await expect(authForm).toBeVisible({ timeout: 15000 });
  }

  if (await authForm.isVisible()) {
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', password);
    await page.click('button.auth-primary');
    await expect(sessionBar).toBeVisible({ timeout: 15000 });
    try {
      await page.context().storageState({ path: authFile });
    } catch {}
  }
}

export async function logout(page) {
  const logoutBtn = page.locator('.auth-sessionbar button', { hasText: 'Çıkış yap' });
  if (await logoutBtn.isVisible()) {
    await logoutBtn.click();
    await expect(page.locator('form.auth-form')).toBeVisible({ timeout: 15000 });
  }
}

export async function openFirstWebsiteWorkspace(page, targetDomain = 'webrich.news') {
  await page.goto(`/websites?q=${encodeURIComponent(targetDomain)}`);
  await expect(page.locator('h1', { hasText: 'Web siteleri' })).toBeVisible({ timeout: 10000 });
  const siteLink = page.locator(`table.ws-table tbody tr a[href^="/websites/"]:has-text("${targetDomain}")`).first();
  await expect(siteLink).toBeVisible({ timeout: 10000 });
  await siteLink.click();
  await page.waitForURL(/\/websites\/[^/]+/, { timeout: 10000 });
}

