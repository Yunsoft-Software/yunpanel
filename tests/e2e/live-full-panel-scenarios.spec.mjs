import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test, { after, before } from 'node:test';
import { chromium } from 'playwright';

const credsRaw = await fs.readFile('.local/yunpanel-owner-password-only.json', 'utf8');
const creds = JSON.parse(credsRaw);
const baseUrl = (creds.panelUrl || 'https://server.cryptoraichu.website').replace(/\/$/, '');

let browser;
let context;
let page;
const pageErrors = [];
const server500s = [];

function assertZeroErrors(stageLabel) {
  assert.deepEqual(pageErrors, [], `[${stageLabel}] Expected zero uncaught pageerror events`);
  assert.deepEqual(server500s, [], `[${stageLabel}] Expected zero HTTP >= 500 responses`);
}

before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    ignoreHTTPSErrors: true,
  });
  page = await context.newPage();
  page.on('pageerror', (err) => {
    pageErrors.push(err?.message || String(err));
  });
  page.on('response', (res) => {
    if (res.status() >= 500) {
      server500s.push(`${res.status()} ${res.url()}`);
    }
  });
});

after(async () => {
  await context?.close();
  await browser?.close();
});

test('SCN-E2E-01: Authenticated session initialization & shell verification (topbar, sidebar without confusing badge, search, theme toggle)', async () => {
  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
  const userField = page.locator('input[autocomplete="username"], input[name="username"], input[type="text"]').first();
  if ((await userField.count()) > 0) {
    await userField.fill(creds.username);
    await page.locator('input[type="password"]').first().fill(creds.password);
    await page.locator('button[type="submit"]').first().click();
    await page.locator('.ws-sidebar').waitFor({ state: 'visible', timeout: 15000 });
  }

  // Verify shell layout: topbar, sidebar, global search trigger, theme toggle
  assert.equal(await page.locator('.ws-toolbar').isVisible(), true, 'Top toolbar must be visible');
  assert.equal(await page.locator('.ws-sidebar').isVisible(), true, 'Left sidebar must be visible');

  // Verify Web Siteleri link in sidebar has NO confusing raw count badge
  const websitesNavBadgeCount = await page.locator('.ws-sidebar a[href="/websites"] .ws-nav-count').count();
  assert.equal(websitesNavBadgeCount, 0, 'Sidebar Web Siteleri link must not display raw count badge');

  // Verify direct link to Uygulama Marketi (1-Click) (/docker) in left sidebar
  const sidebarMarketplaceLink = page.locator('.ws-sidebar a[href="/docker"]', { hasText: 'Uygulama Marketi (1-Click)' });
  assert.equal(await sidebarMarketplaceLink.isVisible(), true, 'Sidebar must contain direct link Uygulama Marketi (1-Click) (/docker)');

  // Verify global command palette search bar in topbar
  const searchBtn = page.locator('button.ws-command-trigger[aria-label="Site veya panel bölümü ara"]');
  assert.equal(await searchBtn.isVisible(), true, 'Global search bar trigger must be visible in topbar');

  // Verify theme toggle button works
  const themeBtn = page.locator('button[aria-label="Gece ve Açık tema arasında geçiş yap"]');
  assert.equal(await themeBtn.isVisible(), true, 'Theme toggle button must be visible');
  const initialTheme = await page.evaluate(() => document.documentElement.dataset.wsTheme || 'dark');
  await themeBtn.click();
  const toggledTheme = await page.evaluate(() => document.documentElement.dataset.wsTheme);
  assert.notEqual(toggledTheme, initialTheme, 'Clicking theme toggle must switch dataset.wsTheme');
  await themeBtn.click();

  assertZeroErrors('SCN-E2E-01');
});

test('SCN-E2E-02: Dashboard (/dashboard) live telemetry interval selector & gauges interaction', async () => {
  await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
  const intervalSelect = page.locator('select[aria-label="Yenileme aralığı"]');
  await intervalSelect.waitFor({ state: 'visible', timeout: 15000 });

  // Verify default Canlı · 5 sn badge
  assert.equal(await page.locator('text=Canlı · 5 sn').isVisible(), true, 'Default badge must be Canlı · 5 sn');

  // Change to 3000 (3 sn) -> verify Canlı · 3 sn
  await intervalSelect.selectOption('3000');
  assert.equal(await page.locator('text=Canlı · 3 sn').isVisible(), true, 'Badge must update to Canlı · 3 sn');

  // Change to 0 (Duraklat) -> verify Duraklatıldı
  await intervalSelect.selectOption('0');
  assert.equal(await page.locator('text=Duraklatıldı').isVisible(), true, 'Badge must update to Duraklatıldı');

  // Change back to 5000 (5 sn) -> verify Canlı · 5 sn
  await intervalSelect.selectOption('5000');
  assert.equal(await page.locator('text=Canlı · 5 sn').isVisible(), true, 'Badge must return to Canlı · 5 sn');

  // Click Şimdi ölç button and verify CPU/RAM/Disk gauges & Bu oturum chart remain healthy
  const measureNowBtn = page.locator('button:has-text("Şimdi ölç")');
  await measureNowBtn.click();
  await page.waitForTimeout(400);

  assert.equal(await page.locator('[role="progressbar"][aria-label="CPU kullanımı"]').isVisible(), true, 'CPU gauge must be visible');
  assert.equal(await page.locator('[role="progressbar"][aria-label="Bellek kullanımı"]').isVisible(), true, 'RAM gauge must be visible');
  assert.equal(await page.locator('[role="progressbar"][aria-label="Disk kullanımı"]').isVisible(), true, 'Disk gauge must be visible');
  const mainText = await page.locator('main').innerText();
  assert.match(mainText, /Bu oturum/, 'Live telemetry session chart (Bu oturum) must be rendered');

  assertZeroErrors('SCN-E2E-02');
});

test('SCN-E2E-03 & SCN-V3-01: aaPanel Notification & Task Center drawer tabs, Escape key close & Zero Notification Badge Jumping across routes', async () => {
  const bellBtn = page.locator('button[aria-label="Bildirim ve Görev Merkezi"]');
  assert.equal(await bellBtn.isVisible(), true, 'Notification & Task Center button must be visible in top bar');
  await bellBtn.click();

  const drawer = page.locator('[role="dialog"][aria-label="Bildirim ve Görev Merkezi"]');
  await drawer.waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await drawer.isVisible(), true, 'NotificationCenterDrawer dialog must be visible');

  // Click Görev Kuyruğu tab
  const tasksTab = drawer.locator('button[role="tab"]:has-text("Görev Kuyruğu")');
  await tasksTab.click();
  assert.equal(await drawer.locator('section[aria-label="Görev Kuyruğu"]').isVisible(), true, 'Görev Kuyruğu tab panel must render');

  // Click Sistem Uyarıları tab
  const alertsTab = drawer.locator('button[role="tab"]:has-text("Sistem Uyarıları")');
  await alertsTab.click();
  assert.equal(await drawer.locator('section[aria-label="Sistem Uyarıları"]').isVisible(), true, 'Sistem Uyarıları tab panel must render');

  // Click Bildirimler tab
  const noticesTab = drawer.locator('button[role="tab"]:has-text("Bildirimler")');
  await noticesTab.click();
  assert.equal(await drawer.locator('section[aria-label="Bildirimler"]').isVisible(), true, 'Bildirimler tab panel must render');

  // Press Escape key and verify the drawer closes
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden', timeout: 5000 });
  assert.equal(await drawer.isVisible(), false, 'NotificationCenterDrawer must close on Escape');

  // SCN-V3-01: Zero Notification Badge Jumping across /files, /mail, and /websites
  async function readNotificationBadgeCount() {
    const badge = bellBtn.locator('.ws-nav-count');
    if ((await badge.count()) === 0) return 0;
    const raw = (await badge.innerText()).trim();
    return Number.parseInt(raw, 10) || 0;
  }

  await page.goto(`${baseUrl}/files`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const badgeOnFiles = await readNotificationBadgeCount();

  await page.goto(`${baseUrl}/mail`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const badgeOnMail = await readNotificationBadgeCount();

  await page.goto(`${baseUrl}/websites`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const badgeOnWebsites = await readNotificationBadgeCount();

  assert.equal(
    badgeOnMail,
    badgeOnFiles,
    `Top-bar notification badge count must stay identical between /files (${badgeOnFiles}) and /mail (${badgeOnMail})`,
  );
  assert.equal(
    badgeOnWebsites,
    badgeOnFiles,
    `Top-bar notification badge count must stay identical between /files (${badgeOnFiles}) and /websites (${badgeOnWebsites})`,
  );

  assertZeroErrors('SCN-E2E-03/SCN-V3-01');
});

test('SCN-E2E-04, SCN-V3-02 & SCN-V3-03: /websites Flat 1-Level Subdomain List, No FileRootBadge / ├─, No Unbound mail.* & Search filtering', async () => {
  await page.goto(`${baseUrl}/websites`, { waitUntil: 'networkidle' });
  await page.locator('.ws-website-task-card').first().waitFor({ state: 'visible', timeout: 15000 });

  const bodyText = await page.locator('main').innerText();
  assert.match(bodyText, /\d+\s+ana alan adı\s*·\s*\d+\s+alt alan adı/, 'WebsitesPage must show explicit root and subdomain counts');

  // SCN-V3-02: Assert Yayın klasörü:, Ortak Kök:, and ├─ do NOT appear on any domain/subdomain card
  const fileRootBadgesCount = await page.locator('.yp-file-root-pill').count();
  assert.equal(fileRootBadgesCount, 0, 'Domain and subdomain cards must not render noisy .yp-file-root-pill badges');
  assert.doesNotMatch(bodyText, /Yayın klasörü:|Ortak Kök:|├─/, 'Domain and subdomain cards must not display Yayın klasörü:, Ortak Kök:, or ├─');

  // SCN-V3-03: Assert unbound mail.webrich.news does NOT appear as a website card on /websites
  const cardHeadings = await page.locator('.ws-website-task-card h3').allInnerTexts();
  const normalizedHeadings = cardHeadings.map((text) => text.trim());
  assert.equal(
    normalizedHeadings.includes('mail.webrich.news'),
    false,
    'Unbound system mail domain mail.webrich.news must not appear as a website card on /websites',
  );

  // SCN-V3-02: Assert only the root domain (webrich.news) has an expand/collapse subdomain button,
  // and none of its subdomains (yp-node.webrich.news, git-route.yp-node.webrich.news) have a nested accordion button
  const rootCard = page.locator('.ws-website-task-card', { has: page.locator('h3', { hasText: /^webrich\.news$/ }) });
  assert.equal(await rootCard.count(), 1, 'Root domain card webrich.news must be rendered');
  const rootToggleBtn = rootCard.locator('button', { hasText: /alt alan adı\s*·\s*(Daralt|Göster)/ });
  assert.equal(await rootToggleBtn.count(), 1, 'Root domain card webrich.news must have the expand/collapse subdomain button');

  const subdomainToggleCount = await page.locator('.yp-subdomain-task-card button', { hasText: /alt alan adı\s*·\s*(Daralt|Göster)/ }).count();
  assert.equal(subdomainToggleCount, 0, 'No subdomain card (.yp-subdomain-task-card) may have a nested expand/collapse subdomain button');

  for (const subHost of ['yp-node.webrich.news', 'git-route.yp-node.webrich.news']) {
    const subCard = page.locator('.ws-website-task-card', { has: page.locator('h3', { hasText: new RegExp(`^${subHost.replace(/\./g, '\\.')}$`) }) });
    if ((await subCard.count()) > 0) {
      const nestedBtnCount = await subCard.locator('button', { hasText: /alt alan adı\s*·\s*(Daralt|Göster)/ }).count();
      assert.equal(nestedBtnCount, 0, `Subdomain card ${subHost} must not have a nested expand/collapse subdomain button`);
    }
  }

  // Type a filter query in the search input, verify filtering works, then clear
  const searchInput = page.locator('input[type="search"][placeholder="Alan adı veya alias"]');
  const initialCardCount = await page.locator('.ws-website-task-card').count();
  assert.ok(initialCardCount >= 1, 'Expected at least 1 website card before filtering');

  await searchInput.fill('nonexistent-filter-domain-xyz-987');
  await page.waitForTimeout(300);
  const filteredEmptyText = await page.locator('main').innerText();
  assert.match(filteredEmptyText, /Eşleşen alan adı bulunamadı/, 'Unmatched query must show empty filter state');

  await searchInput.fill('');
  await page.waitForTimeout(300);
  const restoredCardCount = await page.locator('.ws-website-task-card').count();
  assert.equal(restoredCardCount, initialCardCount, 'Clearing search input must restore website cards');

  assertZeroErrors('SCN-E2E-04/SCN-V3-02/SCN-V3-03');
});

test('SCN-V3-04: Unbound / Suspended domain mail.webrich.news 1-Click Unsuspend on /websites/a7408833-d4d8-48ba-9545-0d58377ddb6a/settings', async () => {
  const mailDomainId = 'a7408833-d4d8-48ba-9545-0d58377ddb6a';
  await page.goto(`${baseUrl}/websites/${mailDomainId}/settings`, { waitUntil: 'networkidle' });
  const settingsSection = page.locator('main section').first();
  await settingsSection.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(400);

  const mainText = await page.locator('main').innerText();
  assert.doesNotMatch(
    mainText,
    /Alan adı henüz bir Website kaydına bağlı değil/,
    'Unbound domain settings must not render the old dead-end unbound error',
  );
  assert.match(mainText, /mail\.webrich\.news/, 'Settings page must display mail.webrich.news');

  const unsuspendBtn = page.locator('button:has-text("Yayını Etkinleştir (Askıdan Çıkar)")');
  if (await unsuspendBtn.isVisible()) {
    await unsuspendBtn.click();
    await page.waitForTimeout(1000);
    await page.waitForLoadState('networkidle');
  } else {
    // Also verify/trigger 1-click domain suspension resume API if mail.webrich.news has an active suspension operation
    const resumeStatus = await page.evaluate(async (domainId) => {
      const opsRes = await fetch(`/api/panel/domains/${encodeURIComponent(domainId)}/suspension-operations`, {
        credentials: 'same-origin',
      });
      if (!opsRes.ok) return { opsStatus: opsRes.status };
      const body = await opsRes.json();
      const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.data?.operations) ? body.data.operations : [];
      const latest = list[0] ?? null;
      if (!latest || !['suspended', 'partial', 'failed', 'resume_partial', 'resume_failed'].includes(latest.status)) {
        return { opsStatus: opsRes.status, latestStatus: latest?.status ?? 'none' };
      }
      const sessionRes = await fetch('/api/auth/session', { credentials: 'same-origin' });
      const sessionBody = await sessionRes.json();
      const csrfToken = sessionBody?.data?.csrfToken ?? sessionBody?.csrfToken ?? '';
      const isFirstResume = latest.status === 'suspended';
      const endpoint = isFirstResume ? 'resume' : 'resume-retry';
      const confirmation = isFirstResume ? latest.actions?.resumeConfirmation : latest.actions?.resumeRetryConfirmation;
      const resumeRes = await fetch(
        `/api/panel/domains/${encodeURIComponent(domainId)}/suspension-operations/${encodeURIComponent(latest.id)}/${endpoint}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrfToken,
          },
          body: JSON.stringify({
            expectedUpdatedAt: latest.updatedAt,
            checksum: latest.checksum,
            confirmation,
          }),
        },
      );
      return { opsStatus: opsRes.status, resumedHttpStatus: resumeRes.status };
    }, mailDomainId);
    assert.equal(resumeStatus.opsStatus, 200, 'GET /api/panel/domains/:id/suspension-operations must succeed with 200');
  }

  // Verify Barındırma bilgileri & Teknik kayıt kimlikleri on mail.webrich.news settings
  assert.match(mainText, /Barındırma bilgileri/, 'Settings page must render Barındırma bilgileri section');
  assert.match(mainText, /Teknik kayıt kimlikleri/, 'Settings page must render Teknik kayıt kimlikleri disclosure');

  assertZeroErrors('SCN-V3-04');
});

test('SCN-E2E-05: /websites/new Wizard (Domain mode, Subdomain mode & all JAMstack Framework Presets)', async () => {
  await page.goto(`${baseUrl}/websites/new`, { waitUntil: 'networkidle' });
  const modeSelect = page.locator('label:has-text("Kayıt türü") select');
  await modeSelect.waitFor({ state: 'visible', timeout: 15000 });

  // Switch Kayıt türü to Alt alan adı and verify Ortak Domain İçi Dosya Kökü badge
  await modeSelect.selectOption('subdomain');
  const step1SubText = await page.locator('main').innerText();
  assert.match(step1SubText, /Ortak Domain İçi Dosya Kökü:/, 'Subdomain mode must show Ortak Domain İçi Dosya Kökü');
  assert.match(step1SubText, /\/var\/www\/vhosts\/.*\/subdomains\//, 'Subdomain mode must preview /var/www/vhosts/.../subdomains/...');

  // Switch back to Bağımsız alan adı
  await modeSelect.selectOption('domain');
  await page.locator('input[placeholder="example.com"]').fill('jamstack-e2e.webrich.news');
  await page.locator('button[type="submit"]:has-text("Devam et")').click();

  // Reach Step 2 (Barındırma türü)
  const siteTypeSelect = page.locator('select[aria-label="Site türü"]');
  await siteTypeSelect.waitFor({ state: 'visible', timeout: 10000 });

  // 1. Click Next.js (App Router / SSR)
  await page.locator('button:has-text("Next.js (App Router / SSR)")').click();
  assert.equal(await siteTypeSelect.inputValue(), 'new_node', 'Next.js preset must set Site türü to new_node');
  assert.equal(await page.locator('label:has-text("Başlangıç dosyası") input').inputValue(), 'server.js', 'Next.js preset must populate server.js entry file');
  assert.equal(await page.locator('label:has-text("Sağlık kontrolü yolu") input').inputValue(), '/api/health', 'Next.js preset must populate /api/health healthPath');

  // 2. Click Astro (Static / Hybrid)
  await page.locator('button:has-text("Astro (Static / Hybrid)")').click();
  assert.equal(await siteTypeSelect.inputValue(), 'new_static', 'Astro preset must set Site türü to new_static');
  assert.equal(await page.locator('label:has-text("Build çıktı klasörü") input').inputValue(), 'dist', 'Astro preset must populate dist outputDir');

  // 3. Click Python (FastAPI / Django / Flask)
  await page.locator('button:has-text("Python (FastAPI / Django / Flask)")').click();
  assert.equal(await siteTypeSelect.inputValue(), 'new_python', 'Python preset must set Site türü to new_python');
  assert.equal(await page.locator('label:has-text("Başlangıç dosyası") input').inputValue(), 'app.py', 'Python preset must populate app.py entry file');

  // 4. Click Docker / Easypanel Stack Proxy
  await page.locator('button:has-text("Docker / Easypanel Stack Proxy")').click();
  assert.equal(await siteTypeSelect.inputValue(), 'docker_compose', 'Docker preset must set Site türü to docker_compose');
  assert.equal(await page.locator('label:has-text("Inner Port (Container targetPort)") input').inputValue(), '8080', 'Docker preset must populate Inner Port 8080');

  // 5. Click PHP-FPM / WordPress / Laravel
  await page.locator('button:has-text("PHP-FPM / WordPress / Laravel")').click();
  assert.equal(await siteTypeSelect.inputValue(), 'new_php', 'PHP preset must set Site türü to new_php');

  assertZeroErrors('SCN-E2E-05');
});

test('SCN-E2E-06: /websites/:id Overview & /websites/:id/hosting Interactive Nginx & Sub-Path Proxy Builder', async () => {
  await page.goto(`${baseUrl}/websites`, { waitUntil: 'networkidle' });
  const manageLink = page.locator('.ws-website-task-card a:has-text("Yönet")').first();
  await manageLink.waitFor({ state: 'visible', timeout: 15000 });
  await manageLink.click();

  const nginxCardLink = page.locator('a:has-text("Web Sunucusu & Nginx")').first();
  await nginxCardLink.waitFor({ state: 'visible', timeout: 15000 });

  const overviewText = await page.locator('main').innerText();
  assert.match(overviewText, /Web Sunucusu & Nginx/, 'SiteDetailPage must display Web Sunucusu & Nginx card');
  assert.match(overviewText, /Alan Adları & Yönlendirme/, 'SiteDetailPage must display Alan Adları & Yönlendirme card');

  // Open /websites/:id/hosting (Barındırma ayarları)
  await nginxCardLink.click();
  await page.locator('button:has-text("CORS Başlıkları Ekle")').waitFor({ state: 'visible', timeout: 15000 });

  // Click CORS Başlıkları Ekle and Güvenlik Başlıkları (HSTS/XSS) Ekle
  await page.locator('button:has-text("CORS Başlıkları Ekle")').click();
  await page.locator('button:has-text("Güvenlik Başlıkları (HSTS/XSS) Ekle")').click();

  const headerInputs = await page.locator('fieldset legend:has-text("Özel yanıt başlıkları") ~ div input').evaluateAll((els) =>
    els.map((el) => el.value),
  );
  assert.ok(headerInputs.includes('Access-Control-Allow-Origin'), 'CORS header Access-Control-Allow-Origin must be added to DOM');
  assert.ok(headerInputs.includes('X-Frame-Options'), 'Security header X-Frame-Options must be added to DOM');

  // Interactive Nginx Reverse Proxy & Alt Yol (Location) Kuralları
  const presetGroup = page.locator('[role="group"][aria-label="JAMstack ve Framework Ön-Ayarları"]');
  const previewPre = page.locator('pre[aria-label="Nginx location bloğu önizlemesi"]');

  // Click Next.js preset
  await presetGroup.locator('button:has-text("Next.js")').click();
  assert.match(await previewPre.innerText(), /location \/api \{[\s\S]*proxy_pass http:\/\/127\.0\.0\.1:13000;/, 'Next.js preset must update location preview to 127.0.0.1:13000');

  // Click Astro preset
  await presetGroup.locator('button:has-text("Astro")').click();
  assert.match(await previewPre.innerText(), /Konteyner :4321[\s\S]*proxy_pass http:\/\/127\.0\.0\.1:14321;/, 'Astro preset must update location preview to :4321 / 127.0.0.1:14321');

  // Click Remix preset
  await presetGroup.locator('button:has-text("Remix")').click();
  assert.match(await previewPre.innerText(), /location \/ws \{[\s\S]*proxy_pass http:\/\/127\.0\.0\.1:13002;/, 'Remix preset must update location preview to /ws and 127.0.0.1:13002');

  // Click Python preset
  await presetGroup.locator('button:has-text("Python")').click();
  assert.match(await previewPre.innerText(), /Konteyner :8000[\s\S]*proxy_pass http:\/\/127\.0\.0\.1:18000;/, 'Python preset must update location preview to :8000 / 127.0.0.1:18000');

  // Test invalid port (99999) in Inner / Konteyner Portu
  const innerPortInput = page.locator('label:has-text("Inner / Konteyner Portu") input');
  await innerPortInput.fill('99999');
  const mainAfterInvalidPort = await page.locator('main').innerText();
  assert.match(mainAfterInvalidPort, /Inner \(Konteyner\) portu 1–65535 aralığında olmalıdır\./, 'Invalid inner port 99999 must render validation error notice');

  // Restore 3000 and verify valid location /api block returns
  await innerPortInput.fill('3000');
  assert.match(await previewPre.innerText(), /location \/api \{/, 'Restoring inner port 3000 must restore valid location /api block');

  // Discard unsaved hosting changes so navigation does not prompt
  const cancelBtn = page.locator('button:has-text("Değişiklikleri iptal et")');
  if (await cancelBtn.isEnabled()) {
    await cancelBtn.click();
  }

  assertZeroErrors('SCN-E2E-06');
});

test('SCN-E2E-07 & SCN-V3-05: Sidebar Uygulama Marketi (1-Click) navigation, category filters & Clean Easypanel 1-Click Wizard Modal', async () => {
  // SCN-V3-05: Verify and click direct sidebar link Uygulama Marketi (1-Click) (/docker)
  const sidebarMarketLink = page.locator('.ws-sidebar a[href="/docker"]', { hasText: 'Uygulama Marketi (1-Click)' });
  assert.equal(await sidebarMarketLink.isVisible(), true, 'Sidebar must contain direct link Uygulama Marketi (1-Click) (/docker)');
  await sidebarMarketLink.click();

  const categoryTabs = page.locator('[role="tablist"][aria-label="1-Click Uygulama Kategorileri"]');
  await categoryTabs.waitFor({ state: 'visible', timeout: 15000 });

  const categoriesToVerify = [
    ['JAMstack & BaaS', /PocketBase|Meilisearch/],
    ['Headless CMS', /Directus|Strapi|Ghost|WordPress/],
    ['Otomasyon & AI', /n8n|Open WebUI/],
    ['İzleme & Analitik', /Umami|Uptime Kuma|Grafana/],
    ['Veritabanı & Cache', /Redis|PostgreSQL/],
    ['Tümü', /PocketBase[\s\S]*n8n/],
  ];

  for (const [label, expectedPattern] of categoriesToVerify) {
    await categoryTabs.locator(`button:has-text("${label}")`).click();
    await page.waitForTimeout(250);
    const gridText = await page.locator('.yp-docker-catalog-grid').innerText();
    assert.match(gridText, expectedPattern, `Category tab "${label}" must filter and display matching marketplace cards`);
  }

  // Click + Tek Tıkla Kur on PocketBase
  const pocketbaseCard = page.locator('.yp-docker-catalog-card', { hasText: 'PocketBase' });
  await pocketbaseCard.locator('button:has-text("Tek Tıkla Kur")').click();

  const dialog = page.locator('dialog[open], [role="dialog"]', { hasText: 'Tek Tıkla Kurulum' });
  await dialog.waitFor({ state: 'visible', timeout: 15000 });

  const dialogText = await dialog.innerText();
  assert.match(dialogText, /Tek Tıkla Kurulum/, 'Modal heading must contain Tek Tıkla Kurulum');
  assert.match(dialogText, /Tek Tıkla Kur \(Easypanel\)/, 'Modal must show Tek Tıkla Kur (Easypanel) badge');
  assert.match(dialogText, /Otomatik Secret & Volume/, 'Modal must show Otomatik Secret & Volume badge');

  // Verify Proje / Servis Adı and Yayınlanacak Alan Adı / Alt Alan Adı inputs are immediately visible
  const projectNameInput = dialog.locator('label:has-text("Proje / Servis Adı") input');
  const targetDomainInput = dialog.locator('label:has-text("Yayınlanacak Alan Adı / Alt Alan Adı") input');
  assert.equal(await projectNameInput.isVisible(), true, 'Proje / Servis Adı input must be immediately visible');
  assert.equal(await targetDomainInput.isVisible(), true, 'Yayınlanacak Alan Adı / Alt Alan Adı input must be immediately visible');

  // Verify Otomatik Let's Encrypt SSL & Nginx Reverse Proxy checkbox is visible
  const autoSslCheckbox = dialog.locator('label:has-text("Otomatik Let\'s Encrypt SSL & Nginx Reverse Proxy") input[type="checkbox"]');
  assert.equal(await autoSslCheckbox.isVisible(), true, 'Otomatik Let\'s Encrypt SSL & Nginx Reverse Proxy checkbox must be visible');
  assert.equal(await autoSslCheckbox.isChecked(), true, 'Otomatik Let\'s Encrypt SSL & Nginx Reverse Proxy checkbox must default to checked');

  // Verify Gelişmiş Port, İmaj ve Compose YAML Ayarları <details> is collapsed initially
  const advancedDetails = dialog.locator('details', { hasText: 'Gelişmiş Port, İmaj ve Compose YAML Ayarları' });
  assert.equal(await advancedDetails.isVisible(), true, 'Gelişmiş Port, İmaj ve Compose YAML Ayarları disclosure must be visible');
  const initiallyOpen = await advancedDetails.evaluate((el) => Boolean(el.open));
  assert.equal(initiallyOpen, false, 'Gelişmiş Port, İmaj ve Compose YAML Ayarları must be collapsed by default');

  // Click summary to open advanced disclosure and reveal Compose YAML textarea
  await advancedDetails.locator('summary').click();
  const openedState = await advancedDetails.evaluate((el) => Boolean(el.open));
  assert.equal(openedState, true, 'Clicking summary must expand Gelişmiş Port, İmaj ve Compose YAML Ayarları');

  const yamlTextarea = dialog.locator('label:has-text("Compose document") textarea');
  assert.equal(await yamlTextarea.isVisible(), true, 'Compose document textarea must be visible after expanding disclosure');
  const firstYaml = await yamlTextarea.inputValue();
  assert.match(firstYaml, /PB_ENCRYPTION_KEY:/, 'Prepared PocketBase YAML must contain PB_ENCRYPTION_KEY');

  // Click Secret'ları Yeniden Üret and verify the generated secret changes
  await dialog.locator('button:has-text("Secret\'ları Yeniden Üret")').click();
  await page.waitForTimeout(500);
  const secondYaml = await yamlTextarea.inputValue();
  assert.notEqual(secondYaml, firstYaml, 'Clicking Secret\'ları Yeniden Üret must regenerate fresh random secrets in Compose YAML');

  // Verify submit button ⚡ Uygulamayı Kur ve Yayınla
  const publishBtn = dialog.locator('button[type="submit"]:has-text("⚡ Uygulamayı Kur ve Yayınla")');
  assert.equal(await publishBtn.isVisible(), true, 'Submit button ⚡ Uygulamayı Kur ve Yayınla must be visible');

  // Close the modal
  await dialog.locator('button:has-text("Vazgeç")').click();
  await dialog.waitFor({ state: 'hidden', timeout: 5000 });

  assertZeroErrors('SCN-E2E-07/SCN-V3-05');
});

test('SCN-V3-06: /databases MariaDB unix_socket Auto-Configuration Action & Ready Security Baseline', async () => {
  await page.goto(`${baseUrl}/databases`, { waitUntil: 'networkidle' });
  const diagnosticsDetails = page.locator('details.ws-database-diagnostics');
  await diagnosticsDetails.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(500);

  // If ⚡ Yerel Yönetici Bağlantısını Otomatik Yapılandır is visible, click it to harden root@localhost unix_socket
  const hardenBtn = page.locator('button:has-text("Yerel Yönetici Bağlantısını Otomatik Yapılandır")').first();
  if (await hardenBtn.isVisible()) {
    await hardenBtn.click();
    await page.waitForTimeout(1000);
    await page.waitForLoadState('networkidle');
  }

  // Ensure Sunucu ve güvenlik ayrıntıları disclosure is open
  const isDiagnosticsOpen = await diagnosticsDetails.evaluate((el) => Boolean(el.open));
  if (!isDiagnosticsOpen) {
    await diagnosticsDetails.locator('summary').click();
  }

  // Wait for badge inside summary to show Hazır
  await page.waitForFunction(
    () => {
      const el = document.querySelector('details.ws-database-diagnostics');
      return Boolean(el && el.innerText.includes('Hazır') && el.innerText.includes('root@localhost · unix_socket'));
    },
    { timeout: 15000 },
  );

  const diagnosticsText = await diagnosticsDetails.innerText();
  assert.match(diagnosticsText, /Hazır/, 'DatabasesPage security baseline must display Hazır');
  assert.match(diagnosticsText, /root@localhost\s*·\s*unix_socket/, 'DatabasesPage must display root@localhost · unix_socket');

  assertZeroErrors('SCN-V3-06');
});

test('SCN-E2E-08: Full-Panel Route Sweep (Zero Crash / Zero 500 Guarantee)', async () => {
  const routes = [
    '/mail',
    '/files',
    '/databases',
    '/statistics',
    '/customers',
    '/resellers',
    '/tools-settings',
    '/servers',
    '/firewall',
    '/jobs',
    '/audit',
    '/settings',
    '/users',
  ];

  for (const route of routes) {
    await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(250);
    const bodyText = await page.locator('body').innerText();
    assert.doesNotMatch(bodyText, /Sayfa yüklenemedi/, `Route ${route} must not render RouteFailure (Sayfa yüklenemedi)`);
    assertZeroErrors(`SCN-E2E-08:${route}`);
  }
});

test('SCN-MOB-01 .. SCN-MOB-06: Mobile Viewport (375x812) Responsiveness Across All Routes', async () => {
  await page.setViewportSize({ width: 375, height: 812 });
  try {
    // 1. Dashboard & Top Session Bar / Toolbar / Notification Drawer / Sidebar Drawer
    await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    const shellAudit = await page.evaluate(() => {
      const sessionBar = document.querySelector('.auth-sessionbar');
      const sessionRect = sessionBar?.getBoundingClientRect();
      const sessionPadLeft = sessionBar ? parseFloat(getComputedStyle(sessionBar).paddingLeft) : 999;
      const toolbar = document.querySelector('.ws-toolbar');
      const toolbarRect = toolbar?.getBoundingClientRect();
      const themeBtn = document.querySelector('button[aria-label="Gece ve Açık tema arasında geçiş yap"]');
      const hasThemeSvg = Boolean(themeBtn?.querySelector('svg'));
      return {
        sessionPadLeft,
        sessionHeight: sessionRect ? Math.round(sessionRect.height) : 0,
        sessionBottom: sessionRect ? Math.round(sessionRect.bottom) : 0,
        toolbarTop: toolbarRect ? Math.round(toolbarRect.top) : 0,
        toolbarHeight: toolbarRect ? Math.round(toolbarRect.height) : 0,
        hasThemeSvg,
      };
    });

    assert.ok(shellAudit.sessionPadLeft <= 20, `Mobile .auth-sessionbar paddingLeft must be <= 20px, got ${shellAudit.sessionPadLeft}px`);
    assert.ok(shellAudit.sessionHeight <= 48, `Mobile .auth-sessionbar height must not wrap into multi-row block, got ${shellAudit.sessionHeight}px`);
    assert.ok(shellAudit.hasThemeSvg, 'Mobile theme toggle button must render a visible SVG icon');

    // Notification Center Bell must be directly clickable on mobile (not covered by .auth-sessionbar)
    const bellBtn = page.locator('button[aria-label="Bildirim ve Görev Merkezi"]');
    await bellBtn.click();
    const drawer = page.locator('.yp-notification-drawer, .ws-notification-drawer');
    await drawer.waitFor({ state: 'visible', timeout: 5000 });
    const drawerWidth = await drawer.evaluate((el) => Math.round(el.getBoundingClientRect().width));
    assert.equal(drawerWidth, 375, 'Notification drawer must span full 375px width on mobile');
    await page.locator('button[aria-label="Bildirim merkezini kapat"]').click();

    // Mobile Hamburger Menu opens slide-over sidebar drawer
    await page.locator('button.ws-mobile-menu').click();
    await page.locator('.ws-sidebar.is-open').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('button.ws-nav-close').click();

    // 2. Site Detail Navigation & Hosting Code Block on Mobile
    await page.goto(`${baseUrl}/websites/webrich.news/hosting`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    const hostingAudit = await page.evaluate(() => {
      const nav = document.querySelector('.ws-plesk-site-navigation');
      const navRect = nav?.getBoundingClientRect();
      const codeBlock = document.querySelector('pre.ws-code-block');
      const codeRect = codeBlock?.getBoundingClientRect();
      return {
        navHeight: navRect ? Math.round(navRect.height) : 999,
        codeRight: codeRect ? Math.round(codeRect.right) : 0,
      };
    });

    assert.ok(hostingAudit.navHeight <= 68, `Mobile .ws-plesk-site-navigation must be a single horizontal scrollable row (<= 68px), got ${hostingAudit.navHeight}px`);
    assert.ok(hostingAudit.codeRight <= 377, `Mobile pre.ws-code-block must not overflow 375px viewport, got right=${hostingAudit.codeRight}px`);

    // 3. File Manager (.yf-browser) on Mobile: 2x2 buttons fit inside viewport & size/perm cells do not overlap
    await page.goto(`${baseUrl}/websites/webrich.news/files`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    const filesAudit = await page.evaluate(() => {
      const actionBtns = [...document.querySelectorAll('.yf-main-actions .ws-button')];
      const maxActionRight = actionBtns.reduce((max, btn) => Math.max(max, Math.round(btn.getBoundingClientRect().right)), 0);
      const firstRow = document.querySelector('.yf-table tbody tr');
      const sizeCell = firstRow?.querySelector('td:nth-child(3).yf-size');
      const permCell = firstRow?.querySelector('td.yf-perm-cell');
      const sizePadLeft = sizeCell ? parseFloat(getComputedStyle(sizeCell).paddingLeft) : 0;
      const permPadLeft = permCell ? parseFloat(getComputedStyle(permCell).paddingLeft) : 0;
      return {
        maxActionRight,
        sizePadLeft,
        permPadLeft,
      };
    });

    assert.ok(filesAudit.maxActionRight <= 375, `Mobile .yf-main-actions buttons must fit inside 375px viewport, got right=${filesAudit.maxActionRight}px`);
    if (filesAudit.sizePadLeft > 0 && filesAudit.permPadLeft > 0) {
      assert.ok(filesAudit.permPadLeft >= filesAudit.sizePadLeft + 50, `Mobile .yf-size (${filesAudit.sizePadLeft}px) and .yf-perm-cell (${filesAudit.permPadLeft}px) must not overlap`);
    }

    // 4. Sweep Mobile Routes for Zero Horizontal Overflow
    const mobileRoutes = [
      '/websites',
      '/docker?mode=catalog',
      '/databases',
      '/mail',
      '/firewall',
      '/settings',
      '/jobs',
      '/audit',
    ];

    for (const route of mobileRoutes) {
      await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(250);
      const overflowCheck = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const offenders = [];
        for (const el of document.querySelectorAll('*')) {
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          if (rect.right > vw + 2 || rect.left < -2) {
            if (el.closest('.ws-sidebar:not(.is-open)')) continue;
            if (el.closest('.ws-table-scroll, .ws-table-wrap, .dns-table-wrap, .yf-results, .yf-location nav, .ws-plesk-site-navigation, .yp-category-pills, .ws-tabs')) continue;
            offenders.push({
              tag: el.tagName.toLowerCase(),
              cls: typeof el.className === 'string' ? el.className.slice(0, 40) : '',
              right: Math.round(rect.right),
            });
          }
        }
        return { vw, offenders };
      });
      assert.equal(
        overflowCheck.offenders.length,
        0,
        `Mobile route ${route} at ${overflowCheck.vw}px must have 0 horizontal overflow offenders, found: ${JSON.stringify(overflowCheck.offenders.slice(0, 5))}`,
      );
      assertZeroErrors(`SCN-MOB:${route}`);
    }
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});
