import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

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
  let fullSubdomain = '';

  function runSsh(command) {
    try {
      return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
        encoding: 'utf8',
        timeout: 25000,
      }).trim();
    } catch (err) {
      return ((err.stdout || '') + (err.stderr || '')).trim();
    }
  }

  async function confirmLifecycleAction(page, actionKey) {
    const modal = page.locator('.ws-modal').filter({ hasText: `Docker Compose ${actionKey}` });
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
    if (!domainId) return;
    try {
      await page.goto(`/websites/${encodeURIComponent(domainId)}/settings`);
      const removalSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Siteyi sil' }) });
      if (await removalSection.isVisible({ timeout: 10000 }).catch(() => false)) {
        const deleteBtn = removalSection.locator('button', { hasText: 'Siteyi sil…' });
        if (await deleteBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
          await deleteBtn.click();
          const dialog = page.locator('dialog.ws-modal, [role="dialog"], .ws-modal').filter({ hasText: 'Siteyi kalıcı olarak sil' });
          if (await dialog.isVisible({ timeout: 8000 }).catch(() => false)) {
            const input = dialog.locator('input');
            await input.fill(domainName);
            const submitBtn = dialog.locator('button', { hasText: 'Silme işlemini başlat' });
            if (await submitBtn.isEnabled({ timeout: 5000 }).catch(() => false)) {
              await submitBtn.click();
              const doneBtn = page.locator('button', { hasText: 'Web sitelerine dön' });
              await expect(doneBtn.or(page.locator('text=Site silindi'))).toBeVisible({ timeout: 30000 }).catch(() => {});
              if (await doneBtn.isVisible().catch(() => false)) {
                await doneBtn.click();
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('Subdomain cleanup notice:', err.message);
    }
  }

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
    // 1. Önce bağlı web sitesini temizle
    if (createdDomainId) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        await removeWebsiteById(page, createdDomainId, fullSubdomain);
      } catch (err) {
        console.warn('Site clean-up notice:', err.message);
      } finally {
        await context.close().catch(() => {});
      }
    }

    // 2. Docker container ve Compose projesini host üzerinden temizle
    if (projectName) {
      runSsh(`docker stop ${projectName}-web-1 ${projectName}_web_1 2>/dev/null || true`);
      runSsh(`docker rm -f ${projectName}-web-1 ${projectName}_web_1 2>/dev/null || true`);
      runSsh(`docker compose -p ${projectName} down --remove-orphans 2>/dev/null || true`);
    }

    if (fullSubdomain) {
      runSsh(`rm -f /etc/nginx/sites-enabled/yunpanel-${fullSubdomain}.conf /var/lib/yunpanel/staging/nginx/yunpanel-${fullSubdomain}.conf 2>/dev/null || true`);
      runSsh('nginx -t && systemctl reload nginx 2>/dev/null || true');
    }

    // 3. Projeyi panel arayüzünden kaldır
    if (createdProjectId) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        await page.goto(`/docker/${encodeURIComponent(createdProjectId)}`);
        const lifecycleSection = page.locator('section').filter({ has: page.locator('h2:text-is("Lifecycle")') });
        if (await lifecycleSection.isVisible({ timeout: 10000 }).catch(() => false)) {
          const removeBtn = lifecycleSection.locator('button:has-text("Projeyi kaldır")');
          if (await removeBtn.isEnabled({ timeout: 10000 }).catch(() => false)) {
            await removeBtn.click();
            await confirmLifecycleAction(page, 'remove');
          }
        }
      } catch (err) {
        console.warn('Docker project clean-up notice:', err.message);
      } finally {
        await context.close().catch(() => {});
      }
    }
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

    const docTextarea = modal.locator('label:has-text("Compose document") textarea');
    await docTextarea.fill(composeContent);

    const validateBtn = modal.locator('button:has-text("Validate")');
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
    const lifecycleSection = page.locator('section').filter({ has: page.locator('h2:text-is("Lifecycle")') });
    await expect(lifecycleSection).toBeVisible({ timeout: 15000 });

    const startBtn = lifecycleSection.locator('button:has-text("Başlat")');
    await expect(startBtn).toBeVisible({ timeout: 10000 });
    await expect(startBtn).toBeEnabled({ timeout: 10000 });
    await startBtn.click();

    await confirmLifecycleAction(page, 'start');

    // Container'ın Up durumuna geçtiğini host üzerinden doğrula
    await expect.poll(() => runSsh(`docker ps --filter "name=${projectName}" --format "{{.Status}}"`), {
      timeout: 60000,
      intervals: [1500, 3000],
    }).toContain('Up');

    // Container'a HTTP isteği atarak log üret
    const directHttp = runSsh(`curl -s -m 5 http://127.0.0.1:${hostPort}`);
    expect(directHttp).toContain('nginx');
    runSsh(`curl -s -m 5 http://127.0.0.1:${hostPort}/test-log-access`);

    // 3. UI üzerinde Container loglarının aktığını doğrula
    await page.reload();
    const logsSection = page.locator('section').filter({ has: page.locator('h2:text-is("Container logları")') });
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

    const targetPortInput = page.locator('label:has-text("Inner Port (Container targetPort)") input');
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

    // Fiziksel Sonuç Kanıtı 1: Nginx yapılandırma dosyasında proxy_pass direktifini doğrula
    await expect.poll(() => runSsh(`cat /etc/nginx/sites-enabled/yunpanel-${fullSubdomain}.conf 2>/dev/null`), {
      timeout: 35000,
      intervals: [1000, 2000],
    }).toContain(`proxy_pass http://127.0.0.1:${hostPort}`);

    // Fiziksel Sonuç Kanıtı 2: Canlı Nginx üzerinden Host başlığı ile container HTTP proxy yanıtını doğrula
    const proxyHttpResponse = runSsh(`curl -s -m 10 -H "Host: ${fullSubdomain}" http://127.0.0.1`);
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

    const targetPortInput = page.locator('label:has-text("Inner Port (Container targetPort)") input');
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

  test('eksik özellik: container terminal / konsol bağlantısı (Plesk parity)', async ({ page }) => {
    test.fail(true, 'BULGU DKR-04: Plesk eşdeğeri container terminal / console bağlantısı YunPanel Docker arayüzünde ve terminal resolver katmanında henüz mevcut değil');

    expect(createdProjectId).toBeTruthy();
    await page.goto(`/docker/${encodeURIComponent(createdProjectId)}`);
    await expect(page.locator('h1')).toContainText(projectName, { timeout: 15000 });

    // Docker detay sayfasında container terminal yüzeyi, terminal butonu veya terminal sekmesi aranır
    const terminalElement = page.locator('.ws-terminal-surface, section:has-text("Container terminali"), button:has-text("Terminal"), a:has-text("Terminal")');
    await expect(terminalElement).toBeVisible({ timeout: 4000 });
  });
});
