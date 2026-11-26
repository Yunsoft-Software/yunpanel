import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs, removeDockerProject } from '../helpers.js';
import { createTestHostProbe } from './test-host-probe.js';

test.use({ trace: 'off' });

test.describe('DKR-04 Domain reverse-proxy bağlantısı ve container log/terminal', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240000);

  const agentN = process.env.AGENT_N || '1';
  const timestamp = Date.now().toString(36);
  const projectName = `tdkr04_a${agentN}_${timestamp}`;
  const hostPort = 18880 + Math.floor(Math.random() * 100);
  const prefix = `tdkr04-a${agentN}-${timestamp}`;

  let createdProjectId = null;
  let createdDomainId = null;
  let createdWebsiteId = null;
  let projectRemoved = false;
  let fullSubdomain = '';
  let hostProbe;

  function readNginxSiteConfig(hostname) {
    return hostProbe.runPythonJson(`import json,os,re,sys
host=sys.argv[1]
assert re.fullmatch(r'[a-z0-9.-]+',host) and '..' not in host
p='/etc/nginx/sites-enabled/yunpanel-'+host+'.conf'
print(json.dumps({'content':open(p,'r',encoding='utf-8',errors='replace').read() if os.path.isfile(p) else ''}))`, [hostname], { timeoutMs: 20_000 }).content;
  }

  // Onay penceresi başlığı işlemin arayüz adını taşır (DockerLifecyclePanel: `Docker Compose: <etiket>`).
  const LIFECYCLE_TITLES = { build: 'Derle', pull: 'İmajları indir', start: 'Başlat', stop: 'Durdur', restart: 'Yeniden başlat', remove: 'Projeyi kaldır' };

  async function confirmLifecycleAction(page, actionKey) {
    const title = LIFECYCLE_TITLES[actionKey];
    expect(title, `Bilinmeyen Docker işlemi: ${actionKey}`).toBeTruthy();
    const modal = page.locator('dialog.ws-modal').filter({ has: page.getByRole('heading', { name: `Docker Compose: ${title}`, exact: true }) });
    await expect(modal).toBeVisible({ timeout: 15000 });

    const confirmStr = await modal.locator('label strong').textContent();
    expect(confirmStr).toBeTruthy();

    const input = modal.locator('input');
    await input.fill(confirmStr);

    const confirmBtn = modal.locator('button:has-text("İşi sıraya al")');
    await expect(confirmBtn).toBeEnabled({ timeout: 10000 });
    await confirmBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 15000 });
  }

  async function removeWebsiteById(page, domainId, domainName) {
    if (!domainId && !domainName) return;
    let targetDomainId = domainId;
    if (!targetDomainId && domainName) {
      await page.goto(`/websites?q=${encodeURIComponent(domainName)}`);
      const siteLink = page.locator(`a[href^="/websites/"]:has-text("${domainName}")`).first();
      if (await siteLink.isVisible({ timeout: 5000 }).catch(() => false)) {
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
      await expect(removalSection).toBeVisible({ timeout: 15000 });
      const deleteBtn = removalSection.locator('button', { hasText: 'Siteyi sil…' });
      await expect(deleteBtn).toBeVisible({ timeout: 15000 });
      await deleteBtn.click();
      const dialog = page.locator('dialog.ws-modal, [role="dialog"], .ws-modal').filter({ hasText: /Siteyi kalıcı olarak sil|Silme/i });
      await expect(dialog).toBeVisible({ timeout: 15000 });
      const confirmStr = await dialog.locator('label strong').textContent().catch(() => null);
      await dialog.locator('input').fill(confirmStr || domainName);
      const submitBtn = dialog.locator('button[type="submit"]');
      await expect(submitBtn).toBeEnabled({ timeout: 10000 });
      await submitBtn.click();
      await expect(dialog).not.toBeVisible({ timeout: 20000 });
    } else {
      expect(domainBefore.status()).toBe(404);
    }

    // Explicitly verify both Domain and Website return 404 before proceeding to Docker project removal.
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
          throw new Error(`Owned DKR-04 website removal stopped: ${active.error?.code ?? active.status}`);
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
  }

  test.beforeAll(() => {
    hostProbe = createTestHostProbe();
    expect(hostProbe.verifyTarget().verified).toBe(true);
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
        if (await retryBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await retryBtn.click();
        }
      }
    }
  });

  test.afterAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const cleanupErrors = [];
    // 1. Önce bağlı web sitesini temizle ve 404/Nginx yokluğunu doğrula
    if (createdDomainId || fullSubdomain) {
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

    // 2. Projeyi panel arayüzünden kaldır ve container/proje yokluğunu doğrula
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
      } catch (err) {
        cleanupErrors.push(`Docker project cleanup failed: ${err.message}`);
      } finally {
        await context.close().catch(() => {});
      }
    }

    expect(cleanupErrors, 'DKR-04 owned website and Docker project cleanup must complete').toEqual([]);
  });

  test('mutlu yol: docker container oluştur, başlat, subdomain reverse-proxy bağla, nginx proxy_pass ve canlı http yanıtını doğrula, UI loglarını izle', async ({ page, request }) => {
    // 1. Docker sayfasına git ve yeni Compose projesi oluştur
    await page.goto('/docker');
    await expect(page.locator('h1')).toContainText('Docker', { timeout: 15000 });

    const addBtn = page.locator('button:has-text("Compose projesi ekle"), button:has-text("Compose / Stack Ekle")').first();
    await expect(addBtn).toBeVisible({ timeout: 10000 });
    await addBtn.click();

    const modal = page.locator('.ws-modal').filter({ hasText: 'Docker Compose projesi ekle' });
    await expect(modal).toBeVisible({ timeout: 5000 });

    const nameInput = modal.locator('label:has-text("Proje adı") input');
    await expect(nameInput).toBeVisible();
    await nameInput.fill(projectName);

    const composeContent = [
      'services:',
      '  web:',
      '    image: nginx:alpine',
      '    ports:',
      `      - "127.0.0.1:${hostPort}:80"`,
      '',
    ].join('\n');

    const docTextarea = modal.locator('label:has-text("Compose içeriği") textarea');
    await docTextarea.fill(composeContent);

    const validateBtn = modal.locator('button:has-text("Doğrula")');
    await expect(validateBtn).toBeEnabled();
    await validateBtn.click();
    await expect(modal.locator('dt:has-text("Servis")')).toBeVisible({ timeout: 10000 });

    const saveBtn = modal.locator('button:has-text("Projeyi kaydet")');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    await page.waitForURL(/\/docker\/[^/]+/, { timeout: 20000 });
    const currentUrl = page.url();
    const urlMatch = currentUrl.match(/\/docker\/([^/?#]+)/);
    createdProjectId = urlMatch ? decodeURIComponent(urlMatch[1]) : null;
    expect(createdProjectId).toBeTruthy();

    await expect(page.locator('h1')).toContainText(projectName, { timeout: 15000 });

    // 2. Container'ı başlat
    const lifecycleSection = page.locator('section').filter({ has: page.locator('h2:text-is("Proje işlemleri")') });
    await expect(lifecycleSection).toBeVisible({ timeout: 15000 });

    const startBtn = lifecycleSection.locator('button:text-is("Başlat")');
    await expect(startBtn).toBeVisible({ timeout: 10000 });
    await expect(startBtn).toBeEnabled({ timeout: 10000 });
    await startBtn.click();

    await confirmLifecycleAction(page, 'start');

    // Container'ın Up durumuna geçtiğini host üzerinden doğrula
    await expect.poll(() => hostProbe.runArgvStdout(['docker', 'ps', '--filter', `name=${projectName}`, '--format', '{{.Status}}']), {
      timeout: 60000,
      intervals: [1500, 3000],
    }).toContain('Up');

    // Container'a HTTP isteği atarak log üret
    const directHttp = hostProbe.runArgvStdout(['curl', '-sS', '-m', '5', `http://127.0.0.1:${hostPort}`]);
    expect(directHttp).toContain('nginx');
    hostProbe.runArgvStdout(['curl', '-sS', '-m', '5', `http://127.0.0.1:${hostPort}/test-log-access`]);

    // 3. UI üzerinde Container loglarının aktığını doğrula
    await page.reload();
    const logsSection = page.locator('section').filter({ has: page.locator('h2:text-is("Konteyner günlükleri")') });
    await expect(logsSection).toBeVisible({ timeout: 15000 });

    const logBlock = logsSection.locator('.ws-log-block');
    await expect(logBlock.first()).toBeVisible({ timeout: 15000 });
    const logContent = await logBlock.first().locator('pre').textContent();
    expect(logContent).toBeTruthy();
    expect(logContent.length).toBeGreaterThan(5);

    // 4. Subdomain oluşturup bu container'ı reverse-proxy olarak bağla
    await page.goto('/websites/new?mode=subdomain');
    await expect(page.locator('h1', { hasText: 'Alt alan adı ekle' })).toBeVisible({ timeout: 10000 });

    // Adım 1: Üst alan adı ve önek
    const parentSelect = page.locator('label:has-text("Üst alan adı") select');
    await expect(parentSelect).toBeVisible();
    await expect(parentSelect.locator('option:not([value=""])').first()).toBeAttached({ timeout: 15000 });

    const options = await parentSelect.locator('option').allTextContents();
    const parentOption = options.find((opt) => opt.includes('webrich.news')) || options[1];
    expect(parentOption).toBeTruthy();
    await parentSelect.selectOption({ label: parentOption });

    const parentDomain = parentOption.trim();
    fullSubdomain = `${prefix}.${parentDomain}`;

    const prefixInput = page.locator('input[aria-label="Alt alan adı"]');
    await prefixInput.fill(prefix);

    // Adım 2'ye geç
    await page.locator('button[type="submit"]:has-text("Devam et")').click();

    // Adım 2: Barındırma türü -> Mevcut Compose Projesi
    const hostingHeading = page.locator('h3:has-text("Barındırma türü")');
    await expect(hostingHeading).toBeVisible({ timeout: 10000 });

    const sourceSelect = page.locator('label:has-text("Site türü") select');
    await sourceSelect.selectOption('existing_managed_compose');

    const projectInput = page.locator('label:has-text("Docker Compose proje kimliği") input');
    await expect(projectInput).toBeVisible();
    await projectInput.fill(createdProjectId);

    const serviceInput = page.locator('label:has-text("Compose servisi") input');
    await serviceInput.fill('web');

    const targetPortInput = page.locator('label:has-text("Konteyner portu") input');
    await targetPortInput.fill('80');

    // Adım 3'e geç
    await page.locator('button[type="submit"]:has-text("Devam et")').click();

    // Adım 3: Son kontrol ve kurulum özeti
    const summarySection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Son kontrol ve kurulum' }) });
    await expect(summarySection).toBeVisible({ timeout: 10000 });
    await expect(summarySection.locator('dd', { hasText: fullSubdomain })).toBeVisible();

    const submitBtn = page.locator('button[type="submit"]:has-text("Siteyi oluştur")');
    await submitBtn.click();

    // Kurulum sonucunu ve provisioning adımlarının tamamlanmasını bekle
    const resultElement = page.locator('.ws-site-create-result');
    await expect(resultElement).toBeVisible({ timeout: 60000 });
    await expect(resultElement).toContainText(fullSubdomain);

    const overviewLink = resultElement.locator('a:has-text("Site genel bakışı"), a[href*="/overview"], a[href^="/websites/"]').first();
    await expect(overviewLink).toBeVisible({ timeout: 60000 });
    const href = await overviewLink.getAttribute('href');
    const match = href ? href.match(/\/websites\/([^/?#]+)/) : null;
    expect(match).toBeTruthy();
    createdDomainId = match[1];
    const createdDomainRes = await page.request.get(`/api/panel/domains/${encodeURIComponent(createdDomainId)}`);
    expect(createdDomainRes.status()).toBe(200);
    createdWebsiteId = (await createdDomainRes.json()).data?.websiteId ?? null;
    expect(createdWebsiteId).toBeTruthy();

    // Fiziksel Sonuç Kanıtı 1: Nginx yapılandırma dosyasında proxy_pass direktifini doğrula
    await expect.poll(() => readNginxSiteConfig(fullSubdomain), {
      timeout: 35000,
      intervals: [1000, 2000],
    }).toContain(`proxy_pass http://127.0.0.1:${hostPort}`);

    // Fiziksel Sonuç Kanıtı 2: Canlı Nginx üzerinden Host başlığı ile container HTTP proxy yanıtını doğrula
    const proxyHttpResponse = hostProbe.runArgvStdout(['curl', '-sS', '-m', '10', '-H', `Host: ${fullSubdomain}`, 'http://127.0.0.1']);
    expect(proxyHttpResponse).toContain('nginx');

    // Fiziksel Sonuç Kanıtı 3: Sunucu IP'sine doğrudan HTTP isteği ile 200 OK yanıtı al
    const liveHttp = await request.get('http://157.180.11.28', {
      headers: { Host: fullSubdomain },
      timeout: 10000,
    });
    expect(liveHttp.status()).toBe(200);
    const body = await liveHttp.text();
    expect(body).toContain('nginx');
  });

  test('hatalı girdi: geçersiz proxy portu ve çakışan proxy hedefi reddedilir', async ({ page }) => {
    expect(createdProjectId).toBeTruthy();

    await page.goto('/websites/new?mode=subdomain');
    await expect(page.locator('h1', { hasText: 'Alt alan adı ekle' })).toBeVisible({ timeout: 10000 });

    const parentSelect = page.locator('label:has-text("Üst alan adı") select');
    await expect(parentSelect).toBeVisible();
    await expect(parentSelect.locator('option:not([value=""])').first()).toBeAttached({ timeout: 15000 });

    const options = await parentSelect.locator('option').allTextContents();
    const parentOption = options.find((opt) => opt.includes('webrich.news')) || options[1];
    await parentSelect.selectOption({ label: parentOption });

    const invalidPrefix = `inv-a${agentN}-${Date.now().toString(36)}`;
    await page.locator('input[aria-label="Alt alan adı"]').fill(invalidPrefix);

    await page.locator('button[type="submit"]:has-text("Devam et")').click();

    // 1. Geçersiz port denemesi (> 65535)
    const sourceSelect = page.locator('label:has-text("Site türü") select');
    await sourceSelect.selectOption('existing_managed_compose');

    const projectInput = page.locator('label:has-text("Docker Compose proje kimliği") input');
    await projectInput.fill(createdProjectId);
    await page.locator('label:has-text("Compose servisi") input').fill('web');

    const targetPortInput = page.locator('label:has-text("Konteyner portu") input');
    await targetPortInput.fill('70000');

    // HTML5 sınır doğrulaması (max 65535)
    const isValid = await targetPortInput.evaluate((el) => el.checkValidity());
    expect(isValid).toBe(false);

    // 2. Çakışan proxy hedefi (aynı Compose projesi, servisi ve portu halihazırda ilk siteye bağlı)
    await targetPortInput.fill('80');
    expect(await targetPortInput.evaluate((el) => el.checkValidity())).toBe(true);

    await page.locator('button[type="submit"]:has-text("Devam et")').click();

    const summarySection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Son kontrol ve kurulum' }) });
    await expect(summarySection).toBeVisible({ timeout: 10000 });

    const submitBtn = page.locator('button[type="submit"]:has-text("Siteyi oluştur")');
    await submitBtn.click();

    // Backend hedef çakışmasını reddetmeli ve ekranda hata uyarısı görünmelidir
    const errorNotice = page.locator('.ws-notice-error, [role="alert"]').or(page.locator('.ws-error'));
    await expect(errorNotice).toBeVisible({ timeout: 15000 });
    const errorText = await errorNotice.textContent();
    expect(errorText.toLowerCase()).toMatch(/already bound|bağlı|çakışma|conflict|managed_compose_binding|önizleme doğrulanamadı/);
  });

  test('container konsolu: non-root oturum açılır, komut/resize/kapatma/live-auth-revoke/durdurma sonrası süreçler temizlenir', async ({ page, browser }) => {
    expect(createdProjectId).toBeTruthy();

    function inspectContainerIdAndProcesses(name) {
      return hostProbe.runPythonJson(`import json,re,subprocess,sys
proj=sys.argv[1]
assert re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,62}',proj)
cid_res=subprocess.run(
    ['docker','ps','-a','--no-trunc','--filter',f'label=com.docker.compose.project={proj}','--format','{{.ID}} {{.Names}} {{.Status}}'],
    capture_output=True,text=True,timeout=15
)
lines=[l.strip() for l in (cid_res.stdout or '').splitlines() if l.strip()]
cid=lines[0].split()[0] if lines else ''
cname=lines[0].split()[1] if lines and len(lines[0].split())>=2 else ''
status=' '.join(lines[0].split()[2:]) if lines and len(lines[0].split())>=3 else ''
top_out=''
if cid and status.startswith('Up'):
    t=subprocess.run(['docker','top',cid,'-eo','pid,user,args'],capture_output=True,text=True,timeout=15)
    top_out=t.stdout or ''
ps_res=subprocess.run(['ps','-eo','pid,args'],capture_output=True,text=True,timeout=15)
host_exec=[l.strip() for l in (ps_res.stdout or '').splitlines() if 'docker' in l and 'exec' in l and ((cid and cid[:12] in l) or (cname and cname in l))]
print(json.dumps({'containerId':cid,'containerName':cname,'status':status,'top':top_out,'hostExec':host_exec}))`, [name], { timeoutMs: 25_000 });
    }

    const consoleMarker = `dkr04_${timestamp}`;
    const closeSessionTag = `DKR04_CLOSE_${timestamp}`;
    const revokeSessionTag = `DKR04_REVOKE_${timestamp}`;
    const stopSessionTag = `DKR04_STOP_${timestamp}`;
    const outputs = [];
    const sentResizes = [];

    page.on('websocket', (socket) => {
      socket.on('framereceived', (event) => {
        try {
          const message = JSON.parse(String(event.payload));
          if (message.type === 'output' && typeof message.data === 'string') outputs.push(message.data);
        } catch { /* Non-terminal WebSocket frames are ignored. */ }
      });
      socket.on('framesent', (event) => {
        try {
          const message = JSON.parse(String(event.payload));
          if (message.type === 'resize') sentResizes.push(message);
        } catch { /* Non-terminal WebSocket frames are ignored. */ }
      });
    });

    await page.goto(`/docker/${encodeURIComponent(createdProjectId)}`);
    await expect(page.locator('h1')).toContainText(projectName, { timeout: 15_000 });

    const runtimeSection = page.locator('section').filter({ has: page.locator('h2:text-is("Çalışma durumu")') });
    await expect(runtimeSection).toBeVisible({ timeout: 15_000 });

    // 1. Konsolu aç -> Terminali aç -> root olmayan canlı oturum (65534:65534)
    const openConsoleBtn = runtimeSection.getByRole('button', { name: 'Konsolu aç', exact: true }).first();
    await expect(openConsoleBtn).toBeVisible({ timeout: 15_000 });
    await openConsoleBtn.click();

    const consoleSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Konteyner konsolu', exact: true }) });
    await expect(consoleSection).toBeVisible({ timeout: 15_000 });

    await consoleSection.getByRole('button', { name: /Terminali aç|Yeniden bağlan/ }).click();
    await expect(consoleSection.getByRole('status')).toHaveText('Bağlı', { timeout: 20_000 });

    const contextBar = consoleSection.locator('[aria-label="Terminal bağlamı"]');
    await expect(contextBar).toContainText('65534:65534', { timeout: 10_000 });
    await expect(contextBar).not.toContainText('0:0');

    // 2. Non-root UID ve komut çıktısını doğrula (asla uid 0 / root değil)
    await consoleSection.locator('.ws-terminal-surface').click();
    await page.keyboard.type(`printf 'UID=%s %s\\n' "$(id -u)" "CONSOLE_OK_${consoleMarker}"`);
    await page.keyboard.press('Enter');

    await expect.poll(
      () => outputs.join('').includes(`UID=65534 CONSOLE_OK_${consoleMarker}`),
      { timeout: 20_000, intervals: [500, 1000] },
    ).toBe(true);
    expect(outputs.join('')).not.toContain(`UID=0 CONSOLE_OK_${consoleMarker}`);
    await expect(consoleSection.locator('.xterm-accessibility')).toContainText(`UID=65534 CONSOLE_OK_${consoleMarker}`, { timeout: 10_000 });

    // 3. Terminal resize olayı gönderilir ve oturum canlı kalır
    const resizeCountBefore = sentResizes.length;
    await page.setViewportSize({ width: 1360, height: 860 });
    await page.setViewportSize({ width: 1180, height: 740 });
    await expect.poll(() => sentResizes.length, { timeout: 15_000, intervals: [300, 700] }).toBeGreaterThan(resizeCountBefore);

    await consoleSection.locator('.ws-terminal-surface').click();
    await page.keyboard.type(`echo "RESIZE_OK_${consoleMarker}"`);
    await page.keyboard.press('Enter');
    await expect.poll(
      () => outputs.join('').includes(`RESIZE_OK_${consoleMarker}`),
      { timeout: 15_000, intervals: [500, 1000] },
    ).toBe(true);

    // 4. Oturum içi benzersiz süreci başlat ve hem konteynerde hem host'ta varlığını doğrula
    // (İki komutlu "sleep 60; true" BusyBox sh tail-call exec optimizasyonunu engelleyip arg0 etiketini korur.)
    await page.keyboard.type(`sh -c 'sleep 60; true' "${closeSessionTag}"`);
    await page.keyboard.press('Enter');
    await expect.poll(() => {
      const info = inspectContainerIdAndProcesses(projectName);
      return info.top.includes(closeSessionTag) && info.hostExec.length > 0;
    }, { timeout: 15_000, intervals: [500, 1000] }).toBe(true);

    // 5. Konsolu kapat (Bağlantıyı kapat + Konsolu kapat) ve süreç temizliğini host üzerinden doğrula
    await consoleSection.getByRole('button', { name: 'Bağlantıyı kapat', exact: true }).click();
    await expect(consoleSection.getByRole('status')).toHaveText('Bağlantı kapandı', { timeout: 15_000 });

    await consoleSection.getByRole('button', { name: 'Konsolu kapat', exact: true }).click();
    await expect(consoleSection).not.toBeVisible({ timeout: 10_000 });

    await expect.poll(() => {
      const info = inspectContainerIdAndProcesses(projectName);
      return !info.top.includes(closeSessionTag)
        && !info.top.includes('sleep 60')
        && !info.top.includes('/bin/sh')
        && info.hostExec.length === 0;
    }, { timeout: 25_000, intervals: [1000, 2000] }).toBe(true);

    // 6. Canlı oturum iptali (live auth revoke): e2e/.auth cache'ine dokunmadan taze context'te ayrı Owner oturumu aç,
    // açık konsolu logout ile hemen kes, süreç temizliğini ve ana page oturumunun hâlâ 200 kaldığını doğrula
    const primarySessionBefore = await page.request.get('/api/auth/session');
    expect(primarySessionBefore.status()).toBe(200);
    const primarySessionId = (await primarySessionBefore.json())?.data?.id;
    expect(primarySessionId).toBeTruthy();

    const revokeContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const revokePage = await revokeContext.newPage();
    try {
      await revokePage.goto('/');
      const revokeAuthForm = revokePage.locator('form.auth-form');
      await expect(revokeAuthForm).toBeVisible({ timeout: 15_000 });
      await revokePage.fill('input[name="username"]', OWNER_USERNAME);
      await revokePage.fill('input[name="password"]', OWNER_PASSWORD);
      await revokePage.click('button.auth-primary');
      await expect(revokePage.locator('.auth-sessionbar')).toBeVisible({ timeout: 15_000 });

      const revokeSessionRes = await revokePage.request.get('/api/auth/session');
      expect(revokeSessionRes.status()).toBe(200);
      const revokeOrigin = new URL(revokeSessionRes.url()).origin;
      const revokeSession = (await revokeSessionRes.json())?.data;
      expect(revokeSession?.id).toBeTruthy();
      expect(revokeSession.id).not.toBe(primarySessionId);
      expect(revokeSession?.csrfToken).toBeTruthy();

      await revokePage.goto(`/docker/${encodeURIComponent(createdProjectId)}`);
      const revRuntime = revokePage.locator('section').filter({ has: revokePage.locator('h2:text-is("Çalışma durumu")') });
      await expect(revRuntime.getByRole('button', { name: 'Konsolu aç', exact: true }).first()).toBeVisible({ timeout: 15_000 });
      await revRuntime.getByRole('button', { name: 'Konsolu aç', exact: true }).first().click();

      const revConsole = revokePage.locator('section').filter({ has: revokePage.getByRole('heading', { name: 'Konteyner konsolu', exact: true }) });
      await expect(revConsole).toBeVisible({ timeout: 15_000 });
      await revConsole.getByRole('button', { name: /Terminali aç|Yeniden bağlan/ }).click();
      await expect(revConsole.getByRole('status')).toHaveText('Bağlı', { timeout: 20_000 });

      await revConsole.locator('.ws-terminal-surface').click();
      await revokePage.keyboard.type(`sh -c 'sleep 60; true' "${revokeSessionTag}"`);
      await revokePage.keyboard.press('Enter');
      await expect.poll(() => {
        const info = inspectContainerIdAndProcesses(projectName);
        return info.top.includes(revokeSessionTag) && info.hostExec.length > 0;
      }, { timeout: 15_000, intervals: [500, 1000] }).toBe(true);

      const logoutRes = await revokePage.request.post('/api/auth/logout', {
        headers: { Origin: revokeOrigin, 'x-csrf-token': revokeSession.csrfToken },
      });
      expect(logoutRes.status()).toBe(204);

      await expect.poll(async () => {
        if (!(await revConsole.isVisible().catch(() => false))) return 'panel-closed';
        const statusText = (await revConsole.getByRole('status').textContent().catch(() => ''))?.trim() ?? '';
        return statusText !== 'Bağlı' ? statusText : 'still-open';
      }, { timeout: 15_000, intervals: [500, 1000] }).not.toBe('still-open');

      await expect.poll(() => {
        const info = inspectContainerIdAndProcesses(projectName);
        return !info.top.includes(revokeSessionTag)
          && !info.top.includes('sleep 60')
          && !info.top.includes('/bin/sh')
          && info.hostExec.length === 0;
      }, { timeout: 25_000, intervals: [1000, 2000] }).toBe(true);
    } finally {
      await revokeContext.close().catch(() => {});
    }

    const primarySessionAfter = await page.request.get('/api/auth/session');
    expect(primarySessionAfter.status()).toBe(200);
    expect((await primarySessionAfter.json())?.data?.id).toBe(primarySessionId);

    // 7. Konsol açıkken proje durdurulduğunda (stop) bağlantının kapandığını ve süreçlerin temizlendiğini doğrula
    await runtimeSection.getByRole('button', { name: 'Konsolu aç', exact: true }).first().click();
    await expect(consoleSection).toBeVisible({ timeout: 15_000 });
    await consoleSection.getByRole('button', { name: /Terminali aç|Yeniden bağlan/ }).click();
    await expect(consoleSection.getByRole('status')).toHaveText('Bağlı', { timeout: 20_000 });

    await consoleSection.locator('.ws-terminal-surface').click();
    await page.keyboard.type(`sh -c 'sleep 60; true' "${stopSessionTag}"`);
    await page.keyboard.press('Enter');
    await expect.poll(() => {
      const info = inspectContainerIdAndProcesses(projectName);
      return info.top.includes(stopSessionTag) && info.hostExec.length > 0;
    }, { timeout: 15_000, intervals: [500, 1000] }).toBe(true);

    const lifecycleSection = page.locator('section').filter({ has: page.locator('h2:text-is("Proje işlemleri")') });
    const stopBtn = lifecycleSection.locator('button:has-text("Durdur")');
    await expect(stopBtn).toBeEnabled({ timeout: 20_000 });
    await stopBtn.click();
    await confirmLifecycleAction(page, 'stop');

    await expect.poll(() => {
      const info = inspectContainerIdAndProcesses(projectName);
      return !info.status.startsWith('Up') && info.hostExec.length === 0;
    }, { timeout: 60_000, intervals: [1500, 2500] }).toBe(true);

    await expect.poll(async () => {
      if (!(await consoleSection.isVisible().catch(() => false))) return 'panel-closed';
      const statusText = (await consoleSection.getByRole('status').textContent().catch(() => ''))?.trim() ?? '';
      return statusText !== 'Bağlı' ? statusText : 'still-open';
    }, { timeout: 25_000, intervals: [1000, 2000] }).not.toBe('still-open');
  });

  test('temizlik: bağlı subdomain ve Docker Compose projesi panel akışıyla kaldırılır ve fiziksel yokluk doğrulanır', async ({ page }) => {
    expect(createdDomainId).toBeTruthy();
    expect(createdProjectId).toBeTruthy();

    const domainToRemove = createdDomainId;
    const subdomainToRemove = fullSubdomain;
    const projectToRemove = createdProjectId;

    await removeWebsiteById(page, domainToRemove, subdomainToRemove);
    createdDomainId = null;
    createdWebsiteId = null;
    fullSubdomain = '';

    await removeDockerProject(page, projectToRemove, projectName);
    expect((await page.request.get(`/api/panel/docker/projects/${encodeURIComponent(projectToRemove)}`)).status()).toBe(404);
    expect(hostProbe.runArgvStdout(['docker', 'ps', '-a', '--filter', `name=${projectName}`, '--format', '{{.Names}}'])).toBe('');
    createdProjectId = null;
    projectRemoved = true;
  });
});
