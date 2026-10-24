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

test('SCN-E2E-03: aaPanel Notification & Task Center drawer tabs and Escape key close', async () => {
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

  assertZeroErrors('SCN-E2E-03');
});

test('SCN-E2E-04: /websites Domain -> Subdomain Hierarchy, Shared File Root badges & Search filtering', async () => {
  await page.goto(`${baseUrl}/websites`, { waitUntil: 'networkidle' });
  await page.locator('.ws-website-task-card').first().waitFor({ state: 'visible', timeout: 15000 });

  const bodyText = await page.locator('main').innerText();
  assert.match(bodyText, /\d+\s+ana alan adı\s*·\s*\d+\s+alt alan adı/, 'WebsitesPage must show explicit root and subdomain counts');

  // Verify subdomain tree connector and shared file root badges (.yp-file-root-pill)
  const fileRootBadgesCount = await page.locator('.yp-file-root-pill').count();
  assert.ok(fileRootBadgesCount > 0, 'Domain and subdomain cards must render file root badges (.yp-file-root-pill)');
  assert.match(bodyText, /├─|\└─/, 'Subdomain cards must display tree branch connectors');
  assert.match(bodyText, /\/var\/www\/vhosts\/.*\/subdomains\//, 'Subdomain cards must display shared file root under parent vhost');

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

  assertZeroErrors('SCN-E2E-04');
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

test('SCN-E2E-07: /docker Easypanel 1-Click Marketplace category filters & Live Secret Generation', async () => {
  await page.goto(`${baseUrl}/docker`, { waitUntil: 'networkidle' });
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

  // Click Tek Tıkla Kur on n8n Workflow Automation
  const n8nCard = page.locator('.yp-docker-catalog-card', { hasText: 'n8n Workflow Automation' });
  await n8nCard.locator('button:has-text("Tek Tıkla Kur")').click();

  const dialog = page.locator('dialog[open], [role="dialog"]', { hasText: 'Docker Compose projesi ekle' });
  await dialog.waitFor({ state: 'visible', timeout: 15000 });

  const dialogText = await dialog.innerText();
  assert.match(dialogText, /Tek Tıkla Kur \(Easypanel\)/, 'Modal must show Tek Tıkla Kur (Easypanel) badge');
  assert.match(dialogText, /Otomatik Secret & Volume/, 'Modal must show Otomatik Secret & Volume badge');

  const yamlTextarea = dialog.locator('label:has-text("Compose document") textarea');
  const firstYaml = await yamlTextarea.inputValue();
  assert.match(firstYaml, /N8N_ENCRYPTION_KEY:/, 'Prepared n8n YAML must contain N8N_ENCRYPTION_KEY');

  // Click Secret'ları Yeniden Üret and verify the generated secret changes
  await dialog.locator('button:has-text("Secret\'ları Yeniden Üret")').click();
  await page.waitForTimeout(500);
  const secondYaml = await yamlTextarea.inputValue();
  assert.notEqual(secondYaml, firstYaml, 'Clicking Secret\'ları Yeniden Üret must regenerate fresh random secrets in Compose YAML');

  // Close the modal
  await dialog.locator('button:has-text("Vazgeç")').click();
  await dialog.waitFor({ state: 'hidden', timeout: 5000 });

  assertZeroErrors('SCN-E2E-07');
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
