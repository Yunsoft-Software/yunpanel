import fs from 'fs';
import path from 'path';
import { expect } from '@playwright/test';

// Credentials never live in the repository: env vars, else the private .local file (gitignored).
function localOwnerCredentials() {
  const file = path.resolve(process.cwd(), '.local/yunpanel-owner-password-only.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}
const localOwner = localOwnerCredentials();
export const OWNER_USERNAME = process.env.PANEL_OWNER_USER || localOwner.username || 'yunsoft-owner';
export const OWNER_PASSWORD = process.env.PANEL_OWNER_PASSWORD || localOwner.password || '';
if (!OWNER_PASSWORD) {
  throw new Error('Owner password missing: set PANEL_OWNER_PASSWORD or create .local/yunpanel-owner-password-only.json');
}

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

export async function removeDockerProjectViaApi(request, projectId) {
  if (!projectId) return false;
  try {
    const sessionRes = await request.get('/api/auth/session');
    if (!sessionRes.ok()) return false;
    const sessionJson = await sessionRes.json();
    const csrfToken = sessionJson?.data?.csrfToken;
    if (!csrfToken) return false;

    const previewRes = await request.post(`/api/docker/projects/${encodeURIComponent(projectId)}/operations/remove/preview`, {
      headers: { 'x-csrf-token': csrfToken },
      data: {},
    });
    if (!previewRes.ok()) return false;
    const previewJson = await previewRes.json();
    const preview = previewJson?.data;
    if (!preview?.previewDigest || !preview?.confirmation) return false;

    const removeRes = await request.post(`/api/docker/projects/${encodeURIComponent(projectId)}/operations/remove`, {
      headers: { 'x-csrf-token': csrfToken },
      data: {
        expectedPreviewDigest: preview.previewDigest,
        confirmation: preview.confirmation,
      },
    });
    if (removeRes.status() !== 202) return false;

    // Poll until project is removed
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const checkRes = await request.get(`/api/docker/projects/${encodeURIComponent(projectId)}`);
      if (checkRes.status() === 404) return true;
    }
    return true;
  } catch {
    return false;
  }
}

export async function removeDockerProject(page, projectId, projectName = '') {
  if (!projectId && !projectName) return;
  // Try fast API removal first if projectId is available
  if (projectId && page?.request) {
    const ok = await removeDockerProjectViaApi(page.request, projectId);
    if (ok) return;
  }
  try {
    let targetUrl = projectId ? `/docker/${encodeURIComponent(projectId)}` : null;
    if (!targetUrl && projectName) {
      await page.goto('/docker');
      const projectLink = page.locator(`a[href^="/docker/"]:has-text("${projectName}")`).first();
      if (await projectLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        await projectLink.click();
        await page.waitForURL(/\/docker\/[^/]+/, { timeout: 10000 }).catch(() => {});
        targetUrl = page.url();
      }
    } else if (targetUrl) {
      await page.goto(targetUrl);
    }
    if (!targetUrl) return;

    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        await page.waitForTimeout(3000);
        await page.reload().catch(() => {});
      }
      const removeBtn = page.locator('button:has-text("Projeyi kaldır")').first();
      await removeBtn.waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);
      if (!await removeBtn.isVisible().catch(() => false)) continue;

      await expect(removeBtn).toBeEnabled({ timeout: 35000 });
      await removeBtn.click();

      const modal = page.locator('.ws-modal').filter({ hasText: 'Docker Compose remove' });
      const modalShown = await modal.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
      if (!modalShown) {
        continue;
      }

      const confirmStr = await modal.locator('label strong').textContent();
      if (confirmStr) {
        const input = modal.locator('input');
        await input.fill(confirmStr);

        const confirmBtn = modal.locator('button:has-text("İşi sıraya al")');
        await expect(confirmBtn).toBeEnabled({ timeout: 10000 });
        await confirmBtn.click();
        await expect(modal).not.toBeVisible({ timeout: 15000 });

        // Wait until project removal job completes
        for (let i = 0; i < 35; i++) {
          await page.waitForTimeout(1000);
          if (projectId) {
            const check = await page.request.get(`/api/docker/projects/${encodeURIComponent(projectId)}`);
            if (check.status() === 404) break;
          }
        }
        await page.waitForURL('/docker', { timeout: 10000 }).catch(() => {});
        break;
      }
    }
  } catch (err) {
    console.warn(`removeDockerProject notice (${projectId || projectName}):`, err.message);
  }
}



// Website setup finishes on the server after the result screen, and the panel refuses Domain
// setting changes until it does (domain_update_provisioning_in_progress). Wait before editing.
export async function waitForWebsiteSetup(page, domainId, { timeout = 120000 } = {}) {
  let websiteId = null;
  await expect.poll(async () => {
    try {
      const res = await page.request.get(`/api/panel/domains/${encodeURIComponent(domainId)}`);
      if (!res.ok()) return null;
      const domain = await res.json().catch(() => null);
      websiteId = (domain?.data ?? domain)?.websiteId;
      return websiteId;
    } catch {
      return null;
    }
  }, { timeout: 30000, intervals: [1000], message: 'Domain must be bound to a Website' }).toBeTruthy();

  await expect.poll(async () => {
    try {
      const res = await page.request.get(`/api/panel/sites/${encodeURIComponent(websiteId)}/provisioning/latest`);
      if (!res.ok()) return false;
      const latest = await res.json().catch(() => null);
      return (latest?.data?.operation ?? latest?.data ?? null)?.ready === true;
    } catch {
      return false;
    }
  }, { timeout, intervals: [2000], message: 'Website setup did not finish' }).toBe(true);
  return websiteId;
}
