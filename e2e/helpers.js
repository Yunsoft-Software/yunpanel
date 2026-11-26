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
    const origin = new URL(sessionRes.url()).origin;
    const sessionJson = await sessionRes.json();
    const csrfToken = sessionJson?.data?.csrfToken;
    if (!csrfToken) return false;

    const existing = await request.get(`/api/panel/docker/projects/${encodeURIComponent(projectId)}`);
    if (existing.status() === 404) return true;

    const headers = { Origin: origin, 'x-csrf-token': csrfToken };
    let preview = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const previewRes = await request.post(`/api/panel/docker/projects/${encodeURIComponent(projectId)}/operations/remove/preview`, {
        headers,
        data: {},
      });
      if (previewRes.status() === 404) return true;
      if (previewRes.status() === 409 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (!previewRes.ok()) return false;
      preview = (await previewRes.json())?.data;
      break;
    }
    if (!preview?.previewDigest || !preview?.confirmation) return false;

    const removeRes = await request.post(`/api/panel/docker/projects/${encodeURIComponent(projectId)}/operations/remove`, {
      headers,
      data: {
        expectedPreviewDigest: preview.previewDigest,
        confirmation: preview.confirmation,
      },
    });
    if (removeRes.status() !== 202) return false;

    // Poll until project is confirmed absent (404)
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const checkRes = await request.get(`/api/panel/docker/projects/${encodeURIComponent(projectId)}`);
      if (checkRes.status() === 404) return true;
    }
    return false;
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

      const modal = page.locator('.ws-modal').filter({ hasText: 'Docker Compose: Projeyi kaldır' });
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
        for (let i = 0; i < 60; i++) {
          await page.waitForTimeout(1000);
          if (projectId) {
            const check = await page.request.get(`/api/panel/docker/projects/${encodeURIComponent(projectId)}`);
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

// --- YunPanel Premium license gate (T965) ---
// Premium-only flows (customer/reseller accounts, extra panel users, per-site users) run in full
// only when the panel's own license says the capability is active. Without it the tests assert the
// gate and skip only the Premium continuation. These helpers only read the license; they never
// activate, refresh or change it.

// GET /api/panel/license as the signed-in Owner (page.request or a browser context request).
export async function readLicenseStatus(request) {
  const response = await request.get('/api/panel/license');
  expect(response.status(), 'GET /api/panel/license').toBe(200);
  const status = (await response.json())?.data;
  expect(typeof status?.capabilities, 'license status lists capabilities').toBe('object');
  return status;
}

// Returns the subset of `capabilities` that this panel's license does not grant.
export async function missingPremiumCapabilities(request, capabilities) {
  const status = await readLicenseStatus(request);
  return capabilities.filter((capability) => {
    expect(Object.hasOwn(status.capabilities, capability), `known license capability ${capability}`).toBe(true);
    return !(status.valid === true && status.capabilities[capability] === true);
  });
}

export function premiumSkipReason(missing) {
  return `YunPanel Premium etkin değil (${missing.join(', ')}): kapı doğrulandı, Premium gerektiren devam adımı atlandı`;
}

// The panel refused the request with the Premium gate for exactly this capability.
export async function expectPremiumLicenseRequired(response, capability) {
  expect(response.status(), 'Premium gate status').toBe(403);
  const error = (await response.json())?.error;
  expect(error?.code).toBe('premium_license_required');
  expect(error?.capability).toBe(capability);
}

// Session CSRF token and Origin for Owner mutations through page.request.
export async function ownerMutationHeaders(request) {
  const response = await request.get('/api/auth/session');
  expect(response.status(), 'GET /api/auth/session').toBe(200);
  const csrf = (await response.json())?.data?.csrfToken;
  expect(typeof csrf === 'string' && csrf.length > 0, 'session CSRF token').toBe(true);
  return { origin: new URL(response.url()).origin, 'x-csrf-token': csrf };
}

// True when a panel user with this username exists (walks every /api/panel/users page).
export async function panelUserExists(request, username) {
  let total = 1;
  for (let offset = 0; offset < total; offset += 100) {
    const response = await request.get(`/api/panel/users?limit=100&offset=${offset}`);
    expect(response.status(), 'GET /api/panel/users').toBe(200);
    const page = (await response.json())?.data;
    total = page?.total ?? 0;
    if ((page?.users ?? []).some((user) => user.username === username)) return true;
  }
  return false;
}

// Without the capability, Owner's "Bayi ekle" / "Müşteri ekle" opens the Premium dialog instead of the
// form, the create-login API answers premium_license_required, and no login or profile is created.
export async function expectHostingAccountCreateGated(page, { kind, username, password }) {
  const reseller = kind === 'reseller';
  const capability = reseller ? 'resellerAccounts' : 'perSiteIsolatedUsers';
  const label = reseller ? 'Bayi' : 'Müşteri';
  await page.goto(reseller ? '/resellers' : '/customers');
  await expect(page.locator('h1')).toContainText(reseller ? 'Bayiler' : 'Müşteriler', { timeout: 15000 });
  const open = page.locator('header.ws-page-heading').getByRole('button', { name: new RegExp(`^${label} ekle`) });
  await expect(open).toBeEnabled({ timeout: 15000 });
  await expect(open).toContainText('Premium');
  await open.click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog.locator(`[data-premium-gate-dialog="${kind}"]`)).toBeVisible({ timeout: 10000 });
  await expect(dialog.locator('h2')).toContainText(`${label} eklemek için YunPanel Premium gerekiyor`);
  await expect(dialog.locator('input')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Vazgeç', exact: true }).click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);

  const response = await page.request.post('/api/panel/users/hosting/accounts/create-login', {
    headers: await ownerMutationHeaders(page.request),
    data: reseller
      ? { kind, username, password, limits: { maxCustomers: 1, maxWebsites: 1 } }
      : { kind, username, password, resellerId: null },
  });
  await expectPremiumLicenseRequired(response, capability);
  const accounts = await page.request.get(`/api/panel/users/hosting/accounts?kind=${kind}&limit=100`);
  expect(accounts.status()).toBe(200);
  expect(((await accounts.json())?.data?.accounts ?? []).some((account) => account.username === username)).toBe(false);
  expect(await panelUserExists(page.request, username)).toBe(false);
}

// Without perSiteIsolatedUsers, /settings/users "Kullanıcı ekle" opens the Premium dialog instead of the
// form, POST /api/panel/users answers premium_license_required, and no user is created.
export async function expectPanelUserCreateGated(page, { username, password }) {
  await page.goto('/settings/users');
  await expect(page.locator('h1')).toContainText('Kullanıcılar', { timeout: 15000 });
  const open = page.locator('header.ws-page-heading').getByRole('button', { name: /^Kullanıcı ekle/ });
  await expect(open).toBeEnabled({ timeout: 15000 });
  await expect(open).toContainText('Premium');
  await open.click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog.locator('[data-premium-gate-dialog="users"]')).toBeVisible({ timeout: 10000 });
  await expect(dialog.locator('h2')).toContainText('Kullanıcı eklemek için YunPanel Premium gerekiyor');
  await expect(dialog.locator('input')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Vazgeç', exact: true }).click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);

  const response = await page.request.post('/api/panel/users', {
    headers: await ownerMutationHeaders(page.request),
    data: { username, password, role: 'site_manager', websiteIds: [] },
  });
  await expectPremiumLicenseRequired(response, 'perSiteIsolatedUsers');
  expect(await panelUserExists(page.request, username)).toBe(false);
}
