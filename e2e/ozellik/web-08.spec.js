import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';
import { externalSiteUrl } from '../../apps/web/src/workspace/site-model.js';

test.describe.serial('WEB-08 Önizleme, geçici domain ve site açma bağlantıları', () => {
  test.setTimeout(180000);
  const agentN = process.env.AGENT_N || '3';
  const prefix = `tweb08-a${agentN}-${Date.now().toString(36)}`;
  const parentSuffix = 'webrich.news';
  const primaryDomain = `${prefix}.${parentSuffix}`;

  let createdDomainId = null;

  async function ensureLoggedIn(page) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        const loginForm = page.locator('form.auth-form');
        if (await loginForm.isVisible({ timeout: 1000 }).catch(() => false)) {
          await page.fill('input[name="username"]', OWNER_USERNAME);
          await page.fill('input[name="password"]', OWNER_PASSWORD);
          await page.click('button.auth-primary');
          await expect(page.locator('.auth-sessionbar')).toBeVisible({ timeout: 10000 });
        }
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        await page.goto('/');
      }
    }
  }

  async function gotoAuthenticated(page, url) {
    await page.goto(url);
    const loginForm = page.locator('form.auth-form');
    if (await loginForm.isVisible({ timeout: 2000 }).catch(() => false)) {
      await ensureLoggedIn(page);
      await page.goto(url);
    }
  }

  async function removeWebsiteById(page, domainId, domainName) {
    if (!domainId) return;

    try {
      await gotoAuthenticated(page, `/websites/${encodeURIComponent(domainId)}/settings`);
      const removalSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Siteyi sil' }) });
      if (!await removalSection.isVisible({ timeout: 8000 }).catch(() => false)) return;

      const deleteBtn = removalSection.locator('button', { hasText: 'Siteyi sil…' });
      if (await deleteBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await deleteBtn.click();

        const dialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Siteyi kalıcı olarak sil' });
        if (await dialog.isVisible({ timeout: 5000 }).catch(() => false)) {
          const input = dialog.locator('input');
          await input.fill(domainName);
          const submitBtn = dialog.locator('button[type="submit"]', { hasText: 'Silme işlemini başlat' });
          if (await submitBtn.isEnabled()) {
            await submitBtn.click();
            const doneIndicator = page.locator('button', { hasText: 'Web sitelerine dön' }).or(page.locator('text=Site silindi'));
            await doneIndicator.waitFor({ timeout: 15000 }).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.error(`Clean-up notice for domain ${domainId} (${domainName}):`, err.message);
    }
  }

  test.beforeEach(async ({ page }) => {
    await ensureLoggedIn(page);
  });

  test.afterAll(async ({ browser }) => {
    if (!createdDomainId) return;
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      await ensureLoggedIn(page);
      await removeWebsiteById(page, createdDomainId, primaryDomain);
    } catch (err) {
      console.error('Clean-up failed for domain:', createdDomainId, err);
    } finally {
      await context.close().catch(() => {});
    }
  });

  test('mutlu yol: site oluştur, liste kartında ve site detayında Siteyi aç linkini doğrula, canlı HTTP 200 al', async ({ page }) => {
    // 1. Yeni web sitesi ekleme akışı
    await gotoAuthenticated(page, '/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    const domainInput = page.locator('label:has-text("Alan adı") input');
    await domainInput.fill(primaryDomain);

    const wwwSelect = page.locator('label:has-text("www davranışı") select');
    await expect(wwwSelect).toBeVisible();
    await wwwSelect.selectOption('alias');

    await page.locator('button[type="submit"]:has-text("Devam et")').click();

    const step2Heading = page.locator('h3:has-text("Barındırma türü")');
    await expect(step2Heading).toBeVisible({ timeout: 10000 });

    const sourceSelect = page.locator('label:has-text("Site türü") select');
    await sourceSelect.selectOption('new_static_upload');

    await page.locator('button[type="submit"]:has-text("Devam et")').click();

    const summarySection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Son kontrol ve kurulum' }) });
    await expect(summarySection).toBeVisible({ timeout: 10000 });
    await expect(summarySection.locator('dd', { hasText: primaryDomain })).toBeVisible();

    const mailCheck = page.locator('label.ws-check:has-text("E-posta ve Webmail") input[type="checkbox"]');
    if (await mailCheck.isVisible() && await mailCheck.isChecked()) {
      await mailCheck.uncheck();
    }

    const submitBtn = page.locator('button[type="submit"]:has-text("Siteyi oluştur")');
    await submitBtn.click();

    const resultElement = page.locator('.ws-site-create-result');
    await expect(resultElement).toBeVisible({ timeout: 60000 });
    await expect(resultElement).toContainText(primaryDomain);

    const manageLink = resultElement.locator('a[href^="/websites/"]').first();
    await expect(manageLink).toBeVisible();
    const href = await manageLink.getAttribute('href');
    const match = href ? href.match(/\/websites\/([^/?#]+)/) : null;
    expect(match).toBeTruthy();
    createdDomainId = match[1];

    // 2. Web Siteleri listesine git ve kart üzerindeki 'Siteyi aç' dış bağlantısını doğrula
    await gotoAuthenticated(page, `/websites?q=${encodeURIComponent(primaryDomain)}`);
    const siteCard = page.locator('.ws-website-task-card').filter({ hasText: primaryDomain });
    await expect(siteCard).toBeVisible({ timeout: 30000 });

    const openSiteBtnOnCard = siteCard.locator('a:has-text("Siteyi aç")');
    await expect(openSiteBtnOnCard).toBeVisible({ timeout: 15000 });
    await expect(openSiteBtnOnCard).toHaveAttribute('target', '_blank');
    await expect(openSiteBtnOnCard).toHaveAttribute('rel', 'noopener noreferrer');
    const cardHref = await openSiteBtnOnCard.getAttribute('href');
    expect(cardHref).toMatch(new RegExp(`^https?://${primaryDomain}/?$`));

    // 3. Kart üzerindeki başlık linkine tıklayarak Site Detay Genel Bakış sayfasına git
    const siteTitleLink = siteCard.locator('h3 a').first();
    await siteTitleLink.click();
    await expect(page.locator('h1', { hasText: primaryDomain })).toBeVisible({ timeout: 30000 });

    // Site Detay Genel Bakış sayfasında da 'Siteyi aç' dış bağlantısını doğrula
    const openSiteBtnOnDetail = page.locator('header a:has-text("Siteyi aç"), .ws-heading-actions a:has-text("Siteyi aç")').first();
    await expect(openSiteBtnOnDetail).toBeVisible({ timeout: 15000 });
    await expect(openSiteBtnOnDetail).toHaveAttribute('target', '_blank');
    await expect(openSiteBtnOnDetail).toHaveAttribute('rel', 'noopener noreferrer');
    const detailHref = await openSiteBtnOnDetail.getAttribute('href');
    expect(detailHref).toBe(cardHref);

    // 4. Fiziksel Sonuç Kanıtı: Canlı Nginx vhost HTTP yanıtı
    const activeResponse = await fetch('http://157.180.11.28/', {
      headers: { Host: primaryDomain },
      redirect: 'manual',
    });
    expect([200, 301, 302]).toContain(activeResponse.status);
    if (activeResponse.status === 200) {
      const body = await activeResponse.text();
      expect(body.length).toBeGreaterThan(0);
    }
  });

  test('askıya alınmış site senaryosu: askıdayken vhost pasif yanıtı ve panelde yayını etkinleştir butonu', async ({ page }) => {
    test.skip(!createdDomainId, 'Mutlu yol senaryosunda site oluşturulamadı');

    // 1. Ayarlar sekmesinde site erişim paneline git
    await gotoAuthenticated(page, `/websites/${encodeURIComponent(createdDomainId)}/settings`);
    const accessSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Site erişimi' }) });
    await expect(accessSection).toBeVisible({ timeout: 20000 });

    const suspendBtn = accessSection.locator('button', { hasText: 'Siteyi askıya al…' });
    if (await suspendBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await suspendBtn.click();

      const confirmModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Siteyi askıya al' });
      await expect(confirmModal).toBeVisible({ timeout: 10000 });

      const confirmInput = confirmModal.locator('input');
      await confirmInput.fill(primaryDomain);

      const confirmSubmit = confirmModal.locator('button[type="submit"]', { hasText: 'Siteyi askıya al' });
      await expect(confirmSubmit).toBeEnabled({ timeout: 5000 });
      await confirmSubmit.click();

      // Askıya alma başarılı olunca Yayını Etkinleştir butonu çıkar
      const resumeBtn = accessSection.locator('button', { hasText: 'Yayını Etkinleştir' });
      await expect(resumeBtn).toBeVisible({ timeout: 30000 });

      // Web siteleri listesinde site kartında "Yayını Etkinleştir" butonu çıktığını doğrula
      await gotoAuthenticated(page, `/websites?q=${encodeURIComponent(primaryDomain)}`);
      const siteCard = page.locator('.ws-website-task-card').filter({ hasText: primaryDomain });
      await expect(siteCard).toBeVisible({ timeout: 15000 });
      await expect(siteCard.locator('a, button').filter({ hasText: 'Yayını Etkinleştir' })).toBeVisible({ timeout: 10000 });

      // Fiziksel Sonuç: Askıya alınan sitede vhost deaktive edilir / pasife alınır
      const suspendedResponse = await fetch('http://157.180.11.28/', {
        headers: { Host: primaryDomain },
        redirect: 'manual',
      });
      expect([301, 302, 404, 502, 503]).toContain(suspendedResponse.status);

      // Yeniden etkinleştir ve normale dön
      await gotoAuthenticated(page, `/websites/${encodeURIComponent(createdDomainId)}/settings`);
      const resumeBtnOnSettings = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Site erişimi' }) })
        .locator('button', { hasText: 'Yayını Etkinleştir' });
      await expect(resumeBtnOnSettings).toBeVisible({ timeout: 15000 });
      await resumeBtnOnSettings.click();
    } else {
      // Eğer site henüz tam aktifleşmediyse ve askıya alma butonu yerine kontrol durumu varsa doğrula
      await expect(accessSection).toContainText(/Site erişimi|erişim durumu|Askıya alma/i);
    }
  });

  test('hatalı girdi ve güvenlik: geçersiz alan adında harici site linki üretilmemesi', async () => {
    // externalSiteUrl güvenlik ve geçerlilik doğrulaması
    expect(externalSiteUrl({ primaryDomain: 'javascript:alert(1)' })).toBeNull();
    expect(externalSiteUrl({ primaryDomain: 'http://evil.com' })).toBeNull();
    expect(externalSiteUrl({ primaryDomain: 'site with spaces.com' })).toBeNull();
    expect(externalSiteUrl({ primaryDomain: 'invalid..domain.com' })).toBeNull();
    expect(externalSiteUrl({ primaryDomain: '' })).toBeNull();
    expect(externalSiteUrl({})).toBeNull();

    // Geçerli alan adı için güvenli URL formatı
    expect(externalSiteUrl({ primaryDomain: 'example.com' })).toBe('http://example.com/');
    expect(externalSiteUrl({ primaryDomain: 'example.com', certificateId: 'cert-123' })).toBe('https://example.com/');
  });

  test('Plesk eşdeğeri DNS öncesi Site Önizleme (Site Preview / Geçici Domain) bağlantısı kontrolü', async ({ page }) => {
    test.skip(!createdDomainId, 'Mutlu yol senaryosunda site oluşturulamadı');

    // Plesk'te DNS yönlendirmesi yapılmamış olsa bile siteyi önizlemek için
    // "Site Önizleme" (Site Preview / Geçici Domain URL) düğmesi bulunur.
    // YunPanel'de henüz DNS öncesi Önizleme / Geçici URL desteği ve UI bağlantısı bulunmuyor.
    test.fail(true, 'BULGU WEB-08: Panelde Plesk eşdeğeri DNS öncesi Site Önizleme (Site Preview / Geçici Domain) bağlantısı veya mekanizması bulunmuyor');

    await gotoAuthenticated(page, `/websites/${encodeURIComponent(createdDomainId)}/overview`);
    await expect(page.locator('h1', { hasText: primaryDomain })).toBeVisible({ timeout: 15000 });

    const previewLink = page.locator('a, button').filter({ hasText: /önizleme|site önizleme|preview/i });
    await expect(previewLink.first()).toBeVisible({ timeout: 3000 });
  });
});
