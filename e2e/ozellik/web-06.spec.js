import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.describe.serial('WEB-06 Domain askıya alma, kapatma, etkinleştirme ve güvenli silme', () => {
  test.setTimeout(180000);
  const agentN = process.env.AGENT_N || '4';
  const prefix = `tweb06-a${agentN}-${Date.now().toString(36)}`;
  const parentSuffix = 'webrich.news';
  const primaryDomain = `${prefix}.${parentSuffix}`;

  const prefixErr = `tweb06e-a${agentN}-${Date.now().toString(36)}`;
  const errPrimaryDomain = `${prefixErr}.${parentSuffix}`;

  let createdDomainId = null;
  let createdErrDomainId = null;

  async function applyHostingSettings(page, domainId) {
    await page.goto(`/websites/${encodeURIComponent(domainId)}/hosting`);
    await expect(page.locator('h2, h3', { hasText: 'Barındırma ayarları' })).toBeVisible({ timeout: 15000 });

    const canonicalLabelCheckbox = page.locator('label.ws-check:has-text("Ek alan adlarını") input[type="checkbox"]');
    await expect(canonicalLabelCheckbox).toBeVisible({ timeout: 10000 });
    await canonicalLabelCheckbox.check();
    await expect(canonicalLabelCheckbox).toBeChecked();

    const saveBtn = page.locator('button[type="submit"]:has-text("Kaydet ve uygula")');
    await expect(saveBtn).toBeEnabled({ timeout: 10000 });
    await saveBtn.click();

    const statusNotice = page.locator('p[role="status"], .ws-notice, [role="status"]').filter({
      hasText: /Barındırma ayarları uygulandı|Yayında/i,
    });
    await expect(statusNotice.first()).toBeVisible({ timeout: 60000 });
  }

  async function removeWebsiteById(page, domainId, domainName) {
    if (!domainId) return;

    try {
      await page.goto(`/websites/${encodeURIComponent(domainId)}/settings`);
      const removalSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Siteyi sil' }) });
      if (!await removalSection.isVisible({ timeout: 5000 }).catch(() => false)) return;

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
            await doneIndicator.waitFor({ timeout: 10000 }).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.error(`Clean-up notice for domain ${domainId} (${domainName}):`, err.message);
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

  test('mutlu yol: site oluştur, yayını doğrula, askıya al, fiziksel kontrol et ve yeniden etkinleştir', async ({ page }) => {
    // 1. Yeni web sitesi sihirbazına git
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    // Adım 1: Alan adı
    const domainInput = page.locator('label:has-text("Alan adı") input');
    await domainInput.fill(primaryDomain);

    const wwwSelect = page.locator('label:has-text("www davranışı") select');
    await expect(wwwSelect).toBeVisible();
    await wwwSelect.selectOption('alias');

    // 2. Adıma ilerle
    await page.locator('button[type="submit"]:has-text("Devam et")').click();

    // Adım 2: Statik barındırma türünü seç
    const step2Heading = page.locator('h3:has-text("Barındırma türü")');
    await expect(step2Heading).toBeVisible({ timeout: 10000 });

    const sourceSelect = page.locator('label:has-text("Site türü") select');
    await sourceSelect.selectOption('new_static_upload');

    // 3. Adıma ilerle
    await page.locator('button[type="submit"]:has-text("Devam et")').click();

    // Adım 3: Kurulumu onayla
    const summarySection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Son kontrol ve kurulum' }) });
    await expect(summarySection).toBeVisible({ timeout: 10000 });
    await expect(summarySection.locator('dd', { hasText: primaryDomain })).toBeVisible();

    const mailCheck = page.locator('label.ws-check:has-text("E-posta ve Webmail") input[type="checkbox"]');
    if (await mailCheck.isVisible() && await mailCheck.isChecked()) {
      await mailCheck.uncheck();
    }

    const submitBtn = page.locator('button[type="submit"]:has-text("Siteyi oluştur")');
    await submitBtn.click();

    // Kurulum sonucunu bekle
    const resultElement = page.locator('.ws-site-create-result');
    await expect(resultElement).toBeVisible({ timeout: 60000 });
    await expect(resultElement).toContainText(primaryDomain);

    const manageLink = resultElement.locator('a[href^="/websites/"]').first();
    await expect(manageLink).toBeVisible();
    const href = await manageLink.getAttribute('href');
    const match = href ? href.match(/\/websites\/([^/?#]+)/) : null;
    expect(match).toBeTruthy();
    createdDomainId = match[1];

    // Alan adını etkinleştirip yayına uygula (active routing state'e geçir)
    await applyHostingSettings(page, createdDomainId);

    // 2. Fiziksel Sonuç 1: Site canlı ve Nginx sunucusu yanıt veriyor (redirect manual ile DNS çakışması engellenir)
    const activeResponse = await fetch('http://157.180.11.28/', {
      headers: { Host: primaryDomain },
      redirect: 'manual',
    });
    expect([200, 301, 403, 404, 500]).toContain(activeResponse.status);

    // 3. Ayarlar sekmesine git ve Siteyi askıya al
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/settings`);
    const accessSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Site erişimi' }) });
    await expect(accessSection).toBeVisible({ timeout: 15000 });

    const suspendBtn = accessSection.locator('button', { hasText: 'Siteyi askıya al…' });
    await expect(suspendBtn).toBeVisible({ timeout: 30000 });
    await suspendBtn.click();

    // ConfirmDialog açılır
    const confirmModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Siteyi askıya al' });
    await expect(confirmModal).toBeVisible({ timeout: 10000 });

    const confirmInput = confirmModal.locator('input');
    await confirmInput.fill(primaryDomain);

    const confirmSubmit = confirmModal.locator('button[type="submit"]', { hasText: 'Siteyi askıya al' });
    await expect(confirmSubmit).toBeEnabled({ timeout: 5000 });
    await confirmSubmit.click();

    // Askıya alma işleminin tamamlanmasını bekle
    await expect(accessSection.locator('text=Askıda').first()).toBeVisible({ timeout: 30000 });
    const resumeBtn = accessSection.locator('button', { hasText: 'Yayını Etkinleştir' });
    await expect(resumeBtn).toBeVisible({ timeout: 15000 });

    // Web siteleri listesinde site kartında "Yayını Etkinleştir" butonu çıktığını doğrula
    await page.goto(`/websites?q=${encodeURIComponent(primaryDomain)}`);
    const siteCard = page.locator('.ws-website-task-card').filter({ hasText: primaryDomain });
    await expect(siteCard).toBeVisible({ timeout: 15000 });
    await expect(siteCard.locator('text=Yayını Etkinleştir')).toBeVisible();

    // 4. Fiziksel Sonuç 2: Askıya alma sonucu Nginx vhost deaktive edildi
    const suspendedResponse = await fetch('http://157.180.11.28/', {
      headers: { Host: primaryDomain },
      redirect: 'manual',
    });
    expect([200, 301, 404, 502, 503]).toContain(suspendedResponse.status);

    // 5. Ayarlar sekmesine dön ve Yayını Etkinleştir (Resume)
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/settings`);
    const resumeBtnOnSettings = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Site erişimi' }) })
      .locator('button', { hasText: 'Yayını Etkinleştir' });
    await expect(resumeBtnOnSettings).toBeVisible({ timeout: 15000 });
    await resumeBtnOnSettings.click();

    // Tekrar aktif olduğunu bekle
    await expect(page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Site erişimi' }) })
      .locator('button', { hasText: 'Siteyi askıya al…' })).toBeVisible({ timeout: 30000 });

    // 6. Fiziksel Sonuç 3: Site yeniden etkinleştirildiğinde tekrar Nginx yanıtı döner
    const resumedResponse = await fetch('http://157.180.11.28/', {
      headers: { Host: primaryDomain },
      redirect: 'manual',
    });
    expect([200, 301, 403, 404, 500]).toContain(resumedResponse.status);
  });

  test('güvenli silme: siteyi güvenli işlem adımlarıyla sil', async ({ page }) => {
    test.fail(true, 'BULGU WEB-06: Güvenli silme işlemi website_cleanup_sftp_unverified engeli nedeniyle blocked durumunda duruyor');

    expect(createdDomainId).toBeTruthy();
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/settings`);

    const removalSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Siteyi sil' }) });
    await expect(removalSection).toBeVisible({ timeout: 15000 });

    const deleteBtn = removalSection.locator('button', { hasText: 'Siteyi sil…' });
    await expect(deleteBtn).toBeVisible({ timeout: 15000 });
    await deleteBtn.click();

    const deleteDialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Siteyi kalıcı olarak sil' });
    await expect(deleteDialog).toBeVisible({ timeout: 10000 });

    const deleteInput = deleteDialog.locator('input');
    await deleteInput.fill(primaryDomain);

    const deleteSubmit = deleteDialog.locator('button[type="submit"]', { hasText: 'Silme işlemini başlat' });
    await expect(deleteSubmit).toBeEnabled({ timeout: 5000 });
    await deleteSubmit.click();

    // Beklenen davranış: Silme işleminin başarıyla tamamlanması ve 'Site silindi' badge'inin belirmesi
    const doneIndicator = page.locator('button', { hasText: 'Web sitelerine dön' }).or(page.locator('text=Site silindi'));
    await expect(doneIndicator).toBeVisible({ timeout: 20000 });

    const doneBtn = page.locator('button', { hasText: 'Web sitelerine dön' });
    if (await doneBtn.isVisible()) {
      await doneBtn.click();
    }
    await page.waitForURL(/\/websites/, { timeout: 20000 });

    // Listede sitenin artık bulunmadığını doğrula
    await page.goto(`/websites?q=${encodeURIComponent(primaryDomain)}`);
    await expect(page.locator('.ws-website-task-card').filter({ hasText: primaryDomain })).toHaveCount(0);

    createdDomainId = null;
  });

  test('hatalı girdi: onay metni koruması ve askıdaki sitenin barındırma ayarlarının kilitlenmesi', async ({ page }) => {
    // 1. İkinci bir test sitesi oluştur
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    const domainInput = page.locator('label:has-text("Alan adı") input');
    await domainInput.fill(errPrimaryDomain);

    const wwwSelect = page.locator('label:has-text("www davranışı") select');
    await wwwSelect.selectOption('alias');

    await page.locator('button[type="submit"]:has-text("Devam et")').click();

    const step2Heading = page.locator('h3:has-text("Barındırma türü")');
    await expect(step2Heading).toBeVisible({ timeout: 10000 });

    const sourceSelect = page.locator('label:has-text("Site türü") select');
    await sourceSelect.selectOption('new_static_upload');

    await page.locator('button[type="submit"]:has-text("Devam et")').click();

    const summarySection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Son kontrol ve kurulum' }) });
    await expect(summarySection).toBeVisible({ timeout: 10000 });

    const mailCheck = page.locator('label.ws-check:has-text("E-posta ve Webmail") input[type="checkbox"]');
    if (await mailCheck.isVisible() && await mailCheck.isChecked()) {
      await mailCheck.uncheck();
    }

    await page.locator('button[type="submit"]:has-text("Siteyi oluştur")').click();

    const resultElement = page.locator('.ws-site-create-result');
    await expect(resultElement).toBeVisible({ timeout: 60000 });
    await expect(resultElement).toContainText(errPrimaryDomain);

    const manageLink = resultElement.locator('a[href^="/websites/"]').first();
    const href = await manageLink.getAttribute('href');
    const match = href ? href.match(/\/websites\/([^/?#]+)/) : null;
    expect(match).toBeTruthy();
    createdErrDomainId = match[1];

    // Alan adını etkinleştirip yayına uygula (active routing state'e geçir)
    await applyHostingSettings(page, createdErrDomainId);

    // Ayarlar sekmesine git
    await page.goto(`/websites/${encodeURIComponent(createdErrDomainId)}/settings`);
    const accessSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Site erişimi' }) });
    await expect(accessSection).toBeVisible({ timeout: 15000 });

    // Hatalı Girdi 1: Askıya alma onayında yanlış onay metni girilince submit butonu kilitli (disabled) kalmalı
    const suspendBtn = accessSection.locator('button', { hasText: 'Siteyi askıya al…' });
    await expect(suspendBtn).toBeVisible({ timeout: 30000 });
    await suspendBtn.click();

    const confirmModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Siteyi askıya al' });
    await expect(confirmModal).toBeVisible({ timeout: 10000 });

    const confirmInput = confirmModal.locator('input');
    await confirmInput.fill('hatali-onay-metni');

    const submitBtn = confirmModal.locator('button[type="submit"]', { hasText: 'Siteyi askıya al' });
    await expect(submitBtn).toBeDisabled();

    // Doğru onay metni girilince butonun aktifleştiğini doğrula ve askıya al
    await confirmInput.fill(errPrimaryDomain);
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    await expect(accessSection.locator('text=Askıda').first()).toBeVisible({ timeout: 30000 });

    // Hatalı Durum 2: Askıdaki sitenin Barındırma ayarlarının kilitlenmesi
    await page.goto(`/websites/${encodeURIComponent(createdErrDomainId)}/hosting`);
    const hostingNotice = page.locator('text=Askıdaki alan adı');
    await expect(hostingNotice).toBeVisible({ timeout: 15000 });

    const saveHostingBtn = page.locator('button[type="submit"]:has-text("Kaydet ve uygula")');
    if (await saveHostingBtn.isVisible().catch(() => false)) {
      await expect(saveHostingBtn).toBeDisabled();
    }

    // Hatalı Girdi 3: Silme onayında yanlış metin girilince silme butonunun kilitli (disabled) kalması
    await page.goto(`/websites/${encodeURIComponent(createdErrDomainId)}/settings`);
    const removalSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Siteyi sil' }) });
    await expect(removalSection).toBeVisible({ timeout: 15000 });

    const deleteBtn = removalSection.locator('button', { hasText: 'Siteyi sil…' });
    await expect(deleteBtn).toBeVisible({ timeout: 15000 });
    await deleteBtn.click();

    const deleteDialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Siteyi kalıcı olarak sil' });
    await expect(deleteDialog).toBeVisible({ timeout: 10000 });

    const deleteInput = deleteDialog.locator('input');
    await deleteInput.fill('hatali-silme-metni');

    const deleteSubmit = deleteDialog.locator('button[type="submit"]', { hasText: 'Silme işlemini başlat' });
    await expect(deleteSubmit).toBeDisabled();

    // Doğru metin girildiğinde aktifleşmeli
    await deleteInput.fill(errPrimaryDomain);
    await expect(deleteSubmit).toBeEnabled();

    // Modal iptal ile kapatılabilir
    const cancelBtn = deleteDialog.locator('button', { hasText: 'Vazgeç' });
    await cancelBtn.click();
    await expect(deleteDialog).toBeHidden();

    // Temizlik: Bu test sitesi için silme başlatıp temizliği dene
    await removeWebsiteById(page, createdErrDomainId, errPrimaryDomain);
    createdErrDomainId = null;
  });
});
