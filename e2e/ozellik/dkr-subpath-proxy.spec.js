import { test, expect } from '@playwright/test';
import {
  OWNER_USERNAME,
  OWNER_PASSWORD,
  loginAs,
  removeDockerProject,
  waitForWebsiteSetup,
} from '../helpers.js';
import { createTestHostProbe } from './test-host-probe.js';

test.use({ trace: 'off' });

test.describe('DKR-SUBPATH Docker /api alt yol reverse-proxy yönlendirmesi', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  const agentN = process.env.AGENT_N || '1';
  const timestamp = Date.now().toString(36);
  const projectName = `tdkrsub_a${agentN}_${timestamp}`;
  const subdomainPrefix = `tdkrsub-a${agentN}-${timestamp}`;

  let hostProbe;
  let hostPort = 0;
  let createdProjectId = null;
  let createdDomainId = null;
  let createdWebsiteId = null;
  let fullSubdomain = '';
  let siteRemoved = false;
  let projectRemoved = false;

  function pickFreeLoopbackPort() {
    const result = hostProbe.runPythonJson(`import json,random,socket
for _ in range(128):
    port = random.randint(20500, 28999)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(('127.0.0.1', port))
            print(json.dumps({'port': port}))
            raise SystemExit(0)
        except OSError:
            continue
raise SystemExit(1)`);
    return Number(result.port);
  }

  function readNginxSiteConfig(hostname) {
    return hostProbe.runPythonJson(`import json,os,re,sys
host=sys.argv[1]
assert re.fullmatch(r'[a-z0-9.-]+',host) and '..' not in host
p='/etc/nginx/sites-enabled/yunpanel-'+host+'.conf'
print(json.dumps({'content':open(p,'r',encoding='utf-8',errors='replace').read() if os.path.isfile(p) else ''}))`, [hostname], { timeoutMs: 20_000 }).content;
  }

  function probeLocalHttp(hostname, requestPath) {
    return hostProbe.runPythonJson(`import json,re,subprocess,sys
host,path=sys.argv[1],sys.argv[2]
assert re.fullmatch(r'[a-z0-9.-]+',host) and '..' not in host
assert path.startswith('/')
r=subprocess.run(
    ['curl','-sS','-i','--max-time','10','--resolve',f'{host}:80:127.0.0.1',f'http://{host}{path}'],
    capture_output=True,text=True,timeout=15
)
raw=r.stdout or ''
sep='\\r\\n\\r\\n' if '\\r\\n\\r\\n' in raw else '\\n\\n'
head,body=raw.split(sep,1) if sep in raw else (raw,'')
first_line=head.splitlines()[0] if head.splitlines() else ''
parts=first_line.split()
status=int(parts[1]) if len(parts)>=2 and parts[1].isdigit() else 0
print(json.dumps({'rc':r.returncode,'status':status,'headers':head,'body':body}))`, [hostname, requestPath], { timeoutMs: 25_000 });
  }

  async function confirmLifecycleAction(page, actionKey) {
    const modal = page.locator('.ws-modal').filter({ hasText: `Docker Compose ${actionKey}` });
    await expect(modal).toBeVisible({ timeout: 15_000 });
    const confirmStr = await modal.locator('label strong').textContent();
    expect(confirmStr).toBeTruthy();
    await modal.locator('input').fill(confirmStr);
    const confirmBtn = modal.locator('button:has-text("İşi sıraya al")');
    await expect(confirmBtn).toBeEnabled({ timeout: 10_000 });
    await confirmBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 15_000 });
  }

  async function removeWebsiteById(page, domainId, domainName) {
    if (!domainId && !domainName) return;
    let targetDomainId = domainId;
    if (!targetDomainId && domainName) {
      await page.goto(`/websites?q=${encodeURIComponent(domainName)}`);
      const siteLink = page.locator(`a[href^="/websites/"]:has-text("${domainName}")`).first();
      if (await siteLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
        const href = await siteLink.getAttribute('href');
        const m = href ? href.match(/\/websites\/([^/?#]+)/) : null;
        if (m) targetDomainId = m[1];
      }
    }
    if (!targetDomainId) return;

    const domainBefore = await page.request.get(`/api/panel/domains/${encodeURIComponent(targetDomainId)}`);
    let targetWebsiteId = createdWebsiteId;
    if (domainBefore.status() === 200) {
      const domainData = (await domainBefore.json().catch(() => null))?.data;
      targetWebsiteId = targetWebsiteId || domainData?.websiteId || null;
      await page.goto(`/websites/${encodeURIComponent(targetDomainId)}/settings`);
      const removalSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Siteyi sil' }) });
      await expect(removalSection).toBeVisible({ timeout: 15_000 });
      const deleteBtn = removalSection.locator('button', { hasText: 'Siteyi sil…' });
      await expect(deleteBtn).toBeVisible({ timeout: 15_000 });
      await deleteBtn.click();
      const dialog = page.locator('dialog.ws-modal, [role="dialog"], .ws-modal').filter({ hasText: /Siteyi kalıcı olarak sil|Silme/i });
      await expect(dialog).toBeVisible({ timeout: 15_000 });
      const confirmStr = await dialog.locator('label strong').textContent().catch(() => null);
      await dialog.locator('input').fill(confirmStr || domainName);
      const submitBtn = dialog.locator('button[type="submit"]');
      await expect(submitBtn).toBeEnabled({ timeout: 10_000 });
      await submitBtn.click();
      await expect(dialog).not.toBeVisible({ timeout: 20_000 });
    } else {
      expect(domainBefore.status()).toBe(404);
    }

    await expect.poll(async () => {
      const domRes = await page.request.get(`/api/panel/domains/${encodeURIComponent(targetDomainId)}`).catch(() => null);
      if (domRes?.status() !== 404) return 'domain-present';
      if (!targetWebsiteId) return 'removed';
      const siteRes = await page.request.get(`/api/panel/websites/${encodeURIComponent(targetWebsiteId)}`).catch(() => null);
      if (siteRes?.status() === 404) return 'removed';
      const remRes = await page.request.get(`/api/panel/websites/${encodeURIComponent(targetWebsiteId)}/removal`).catch(() => null);
      if (remRes?.status() === 200) {
        const ops = (await remRes.json().catch(() => ({})))?.data?.operations ?? [];
        const active = ops.find((op) => op.status !== 'removed');
        if (['failed', 'blocked'].includes(active?.status)) {
          throw new Error(`Owned website removal stopped: ${active.error?.code ?? active.status}`);
        }
      }
      return 'website-removing';
    }, { timeout: 90_000, intervals: [1000, 2000] }).toBe('removed');

    expect((await page.request.get(`/api/panel/domains/${encodeURIComponent(targetDomainId)}`)).status()).toBe(404);
    if (targetWebsiteId) {
      expect((await page.request.get(`/api/panel/websites/${encodeURIComponent(targetWebsiteId)}`)).status()).toBe(404);
    }
    if (domainName) {
      expect(readNginxSiteConfig(domainName)).toBe('');
    }
    siteRemoved = true;
  }

  test.beforeAll(() => {
    hostProbe = createTestHostProbe();
    expect(hostProbe.verifyTarget().verified).toBe(true);
    hostPort = pickFreeLoopbackPort();
    expect(hostPort).toBeGreaterThanOrEqual(20500);
  });

  test.beforeEach(async ({ page }) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        await page.goto('/');
        const retryBtn = page.locator('button:has-text("Tekrar dene")');
        if (await retryBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
          await retryBtn.click();
        }
      }
    }
  });

  test.afterAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const cleanupErrors = [];

    if (!siteRemoved && (createdDomainId || fullSubdomain)) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        await removeWebsiteById(page, createdDomainId, fullSubdomain);
      } catch (err) {
        cleanupErrors.push(`Website cleanup failed: ${err.message}`);
      } finally {
        await context.close().catch(() => {});
      }
    }

    if (!projectRemoved && (createdProjectId || projectName)) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        await removeDockerProject(page, createdProjectId, projectName);
        if (createdProjectId) {
          expect((await page.request.get(`/api/panel/docker/projects/${encodeURIComponent(createdProjectId)}`)).status()).toBe(404);
        }
        expect(hostProbe.runArgvStdout(['docker', 'ps', '-a', '--filter', `name=${projectName}`, '--format', '{{.Names}}'])).toBe('');
        projectRemoved = true;
      } catch (err) {
        cleanupErrors.push(`Docker project cleanup failed: ${err.message}`);
      } finally {
        await context.close().catch(() => {});
      }
    }

    expect(cleanupErrors, 'DKR-SUBPATH owned website and Docker project cleanup must succeed').toEqual([]);
  });

  test('kalıcı /api alt yol Docker proxy kuralı eklenir, sayfa yenilemede korunur, Nginx ve canlı HTTP sınırlarını doğrular ve kaldırılınca site köküne döner', async ({ page }) => {
    // 1. Ayırt edilebilir yanıt dönen loopback Compose servisini panelden oluştur ve başlat
    await page.goto('/docker');
    await expect(page.locator('h1')).toContainText('Docker', { timeout: 15_000 });

    const addBtn = page.locator('button:has-text("Compose projesi ekle"), button:has-text("Compose / Stack Ekle")').first();
    await expect(addBtn).toBeVisible({ timeout: 10_000 });
    await addBtn.click();

    const createModal = page.locator('.ws-modal').filter({ hasText: 'Docker Compose projesi ekle' });
    await expect(createModal).toBeVisible({ timeout: 10_000 });
    await createModal.locator('label:has-text("Proje adı") input').fill(projectName);

    const composeYaml = [
      'services:',
      '  api:',
      '    image: nginx:alpine',
      '    ports:',
      `      - "127.0.0.1:${hostPort}:80/tcp"`,
      '    command:',
      '      - /bin/sh',
      '      - -c',
      '      - |-',
      "        printf '%s\\n' \\",
      "          'server {' \\",
      "          '  listen 80;' \\",
      "          '  default_type text/plain;' \\",
      "          '  add_header X-Test-Origin docker-backend always;' \\",
      "          '  location = /api { return 200 \"DOCKER_BACKEND:/api\\n\"; }' \\",
      "          '  location = /api/child { return 200 \"DOCKER_BACKEND:/api/child\\n\"; }' \\",
      "          '  location / { return 200 \"DOCKER_BACKEND:OTHER\\n\"; }' \\",
      "          '}' \\",
      "          > /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'",
      '',
    ].join('\n');

    await createModal.locator('label:has-text("Compose document") textarea').fill(composeYaml);
    await createModal.locator('button:has-text("Validate")').click();
    await expect(createModal.locator('dt:has-text("Servis")')).toBeVisible({ timeout: 15_000 });

    const saveProjectBtn = createModal.locator('button:has-text("Projeyi kaydet")');
    await expect(saveProjectBtn).toBeEnabled({ timeout: 10_000 });
    await saveProjectBtn.click();

    await page.waitForURL(/\/docker\/[^/]+/, { timeout: 20_000 });
    const urlMatch = page.url().match(/\/docker\/([^/?#]+)/);
    createdProjectId = urlMatch ? decodeURIComponent(urlMatch[1]) : null;
    expect(createdProjectId).toBeTruthy();

    const lifecycleSection = page.locator('section').filter({ has: page.locator('h2:text-is("Lifecycle")') });
    await expect(lifecycleSection).toBeVisible({ timeout: 15_000 });
    const startBtn = lifecycleSection.locator('button:has-text("Başlat")');
    await expect(startBtn).toBeEnabled({ timeout: 15_000 });
    await startBtn.click();
    await confirmLifecycleAction(page, 'start');

    await expect.poll(
      () => hostProbe.runArgvStdout(['docker', 'ps', '--filter', `name=${projectName}`, '--format', '{{.Status}}']),
      { timeout: 60_000, intervals: [1500, 3000] },
    ).toContain('Up');

    await expect.poll(
      () => hostProbe.runArgvStdout(['curl', '-sS', '-m', '5', `http://127.0.0.1:${hostPort}/api`]),
      { timeout: 20_000, intervals: [1000, 2000] },
    ).toContain('DOCKER_BACKEND:/api');

    // 2. Panelden yeni statik subdomain oluştur (yalnız tam webrich.news altında, HTTP modunda)
    await page.goto('/websites/new?mode=subdomain');
    await expect(page.locator('h1', { hasText: 'Alt alan adı ekle' })).toBeVisible({ timeout: 15_000 });

    const parentSelect = page.locator('label:has-text("Üst alan adı") select');
    await expect(parentSelect.locator('option:not([value=""])').first()).toBeAttached({ timeout: 15_000 });
    const parentOptions = (await parentSelect.locator('option').allTextContents()).map((opt) => opt.trim());
    const exactParent = parentOptions.find((opt) => opt === 'webrich.news');
    expect(exactParent, `Required exact parent domain "webrich.news" not found in options: ${parentOptions.join(', ')}`).toBe('webrich.news');
    await parentSelect.selectOption({ label: exactParent });
    fullSubdomain = `${subdomainPrefix}.webrich.news`;

    await page.locator('input[aria-label="Alt alan adı"]').fill(subdomainPrefix);
    await page.locator('button[type="submit"]:has-text("Devam et")').click();

    await expect(page.locator('h3:has-text("Barındırma türü")')).toBeVisible({ timeout: 10_000 });
    await page.locator('label:has-text("Site türü") select').selectOption('new_static_upload');
    await page.locator('button[type="submit"]:has-text("Devam et")').click();

    const summarySection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Son kontrol ve kurulum' }) });
    await expect(summarySection).toBeVisible({ timeout: 10_000 });
    await expect(summarySection.locator('dd', { hasText: fullSubdomain })).toBeVisible();

    const mailCheck = page.locator('label.ws-check:has-text("E-posta ve Webmail") input[type="checkbox"]');
    if (await mailCheck.isVisible() && await mailCheck.isChecked()) {
      await mailCheck.uncheck();
    }
    const httpsSelect = page.locator('select[aria-label="Sertifika yönetimi"]');
    if (await httpsSelect.isVisible()) {
      await httpsSelect.selectOption('off');
    }

    await page.locator('button[type="submit"]:has-text("Siteyi oluştur")').click();

    const resultElement = page.locator('.ws-site-create-result');
    await expect(resultElement).toBeVisible({ timeout: 60_000 });
    await expect(resultElement).toContainText(fullSubdomain);

    const overviewLink = resultElement.locator('a[href^="/websites/"]').first();
    await expect(overviewLink).toBeVisible({ timeout: 60_000 });
    const siteHref = await overviewLink.getAttribute('href');
    const domainMatch = siteHref ? siteHref.match(/\/websites\/([^/?#]+)/) : null;
    expect(domainMatch).toBeTruthy();
    createdDomainId = decodeURIComponent(domainMatch[1]);

    createdWebsiteId = await waitForWebsiteSetup(page, createdDomainId);

    // Proxy eklemeden önce sitenin kendi varsayılan statik başlangıç içeriğini (HTTP 200) yakala
    let baselineRootBody = '';
    await expect.poll(() => {
      const res = probeLocalHttp(fullSubdomain, '/');
      if (res.status === 200 && res.body.trim().length > 0 && !res.body.includes('DOCKER_BACKEND')) {
        baselineRootBody = res.body;
        return true;
      }
      return false;
    }, { timeout: 30_000, intervals: [1000, 2000] }).toBe(true);
    expect(baselineRootBody.trim().length).toBeGreaterThan(0);

    // 3. Domain Hosting ekranından /api kalıcı Docker proxy kuralı ekle ve Kaydet ve uygula
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/hosting`);
    await expect(page.locator('h2, h3', { hasText: 'Barındırma ayarları' })).toBeVisible({ timeout: 15_000 });

    const builder = page.locator('fieldset[aria-label="Alt yol proxy kuralları"]');
    await expect(builder).toBeVisible({ timeout: 15_000 });

    const projectSelect = builder.locator('label:has-text("Docker projesi") select');
    await expect(projectSelect.locator(`option[value="${createdProjectId}"]`)).toBeAttached({ timeout: 20_000 });
    await projectSelect.selectOption(createdProjectId);

    const slotSelect = builder.locator('label:has-text("Servis ve port") select');
    await expect(slotSelect.locator('option[value="api:80"]')).toBeAttached({ timeout: 15_000 });
    await slotSelect.selectOption('api:80');

    await builder.locator('label:has-text("URL yolu") input').fill('/api');

    const addRouteBtn = builder.locator('button:has-text("Alt yol kuralı ekle")');
    await expect(addRouteBtn).toBeEnabled({ timeout: 10_000 });
    await addRouteBtn.click();

    const apiRouteRow = builder.locator('tbody tr').filter({ hasText: '/api' });
    await expect(apiRouteRow).toBeVisible({ timeout: 15_000 });
    await expect(apiRouteRow).toContainText(`127.0.0.1:${hostPort}`);

    const saveApplyBtn = page.locator('button[type="submit"]:has-text("Kaydet ve uygula")');
    await expect(saveApplyBtn).toBeEnabled({ timeout: 10_000 });
    await saveApplyBtn.click();

    await expect(
      page.locator('.ws-notice[role="status"]').filter({ hasText: 'Barındırma ayarları uygulandı.' }),
    ).toBeVisible({ timeout: 90_000 });

    // 4. Sayfa yenileme sonrası /api kuralının kalıcı olarak yüklendiğini doğrula
    await page.reload();
    const reloadedBuilder = page.locator('fieldset[aria-label="Alt yol proxy kuralları"]');
    await expect(reloadedBuilder).toBeVisible({ timeout: 15_000 });
    const persistedRow = reloadedBuilder.locator('tbody tr').filter({ hasText: '/api' });
    await expect(persistedRow).toBeVisible({ timeout: 15_000 });
    await expect(persistedRow).toContainText(`127.0.0.1:${hostPort}`);

    // 5. Gerçek Nginx konfigürasyonunu ve canlı HTTP yönlendirme sınırlarını doğrula
    await expect.poll(() => readNginxSiteConfig(fullSubdomain), {
      timeout: 30_000,
      intervals: [1000, 2000],
    }).toContain(`proxy_pass http://127.0.0.1:${hostPort};`);

    const nginxAfterAdd = readNginxSiteConfig(fullSubdomain);
    expect(nginxAfterAdd).toContain('location = /api {');
    expect(nginxAfterAdd).toContain('location ^~ /api/ {');
    expect(nginxAfterAdd).toContain(`proxy_pass http://127.0.0.1:${hostPort};`);

    // GET / -> sitenin kendi statik başlangıç içeriği, Docker DEĞİL
    const rootRes = probeLocalHttp(fullSubdomain, '/');
    expect(rootRes.status).toBe(200);
    expect(rootRes.body).toBe(baselineRootBody);
    expect(rootRes.body).not.toContain('DOCKER_BACKEND');
    expect(rootRes.headers.toLowerCase()).not.toContain('x-test-origin: docker-backend');

    // GET /api -> Docker backend
    const apiRes = probeLocalHttp(fullSubdomain, '/api');
    expect(apiRes.status).toBe(200);
    expect(apiRes.body).toContain('DOCKER_BACKEND:/api');
    expect(apiRes.headers.toLowerCase()).toContain('x-test-origin: docker-backend');

    // GET /api/child -> Docker backend
    const apiChildRes = probeLocalHttp(fullSubdomain, '/api/child');
    expect(apiChildRes.status).toBe(200);
    expect(apiChildRes.body).toContain('DOCKER_BACKEND:/api/child');
    expect(apiChildRes.headers.toLowerCase()).toContain('x-test-origin: docker-backend');

    // GET /apimy -> sınır kontrolü: /api prefix'ine takılmaz, Docker backend DEĞİL
    const boundaryRes = probeLocalHttp(fullSubdomain, '/apimy');
    expect(boundaryRes.body).not.toContain('DOCKER_BACKEND');
    expect(boundaryRes.headers.toLowerCase()).not.toContain('x-test-origin: docker-backend');
    if (boundaryRes.status === 200) {
      expect(boundaryRes.body).toBe(baselineRootBody);
    } else {
      expect(boundaryRes.status).toBe(404);
    }

    // 6. Panel UI'dan /api kuralını kaldır ve Kaydet ve uygula
    const removeRouteBtn = persistedRow.locator('button:has-text("Kaldır")');
    await expect(removeRouteBtn).toBeEnabled({ timeout: 10_000 });
    await removeRouteBtn.click();

    await expect(reloadedBuilder).toContainText('Tanımlı alt yol proxy kuralı yok', { timeout: 10_000 });

    const saveRemoveBtn = page.locator('button[type="submit"]:has-text("Kaydet ve uygula")');
    await expect(saveRemoveBtn).toBeEnabled({ timeout: 10_000 });
    await saveRemoveBtn.click();

    await expect(
      page.locator('.ws-notice[role="status"]').filter({ hasText: 'Barındırma ayarları uygulandı.' }),
    ).toBeVisible({ timeout: 90_000 });

    // 7. Kaldırma sonrası Nginx bloğunun silindiğini ve GET / ile GET /api'nin site köküne döndüğünü doğrula
    await expect.poll(() => readNginxSiteConfig(fullSubdomain), {
      timeout: 30_000,
      intervals: [1000, 2000],
    }).not.toContain(`127.0.0.1:${hostPort}`);

    const nginxAfterRemove = readNginxSiteConfig(fullSubdomain);
    expect(nginxAfterRemove).not.toContain('location = /api {');
    expect(nginxAfterRemove).not.toContain('location ^~ /api/ {');

    const rootAfterRemove = probeLocalHttp(fullSubdomain, '/');
    expect(rootAfterRemove.status).toBe(200);
    expect(rootAfterRemove.body).toBe(baselineRootBody);
    expect(rootAfterRemove.body).not.toContain('DOCKER_BACKEND');

    const apiAfterRemove = probeLocalHttp(fullSubdomain, '/api');
    expect(apiAfterRemove.body).not.toContain('DOCKER_BACKEND');
    expect(apiAfterRemove.headers.toLowerCase()).not.toContain('x-test-origin: docker-backend');
    if (apiAfterRemove.status === 200) {
      expect(apiAfterRemove.body).toBe(baselineRootBody);
    } else {
      expect(apiAfterRemove.status).toBe(404);
    }
  });
});
