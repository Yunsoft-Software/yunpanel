import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { TOTP } from 'otpauth';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs, logout } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('ROL-07 Profil, iletişim bilgisi, parola, oturum ve MFA', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '4';
  const prefix = `trol07-a${agentN}-${Date.now().toString(36)}`;
  const OWNER_USER = `${prefix}-own`;
  const RES_USER = `${prefix}-res`;
  const PASS_INITIAL = 'Tr0l07_Pass1!2026';
  const PASS_UPDATED = 'Tr0l07_Pass2!2026';
  const RECOVERY_EMAIL = `${prefix}@webrich.news`;

  const AUTH_DIR = path.resolve(process.cwd(), 'e2e/.auth');

  async function ensureOwnerLoggedIn(page) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        await page.goto('/');
      }
    }
  }

  async function findAccountRow(page, username) {
    const userSection = page.locator('section').filter({ hasText: 'Hesaplar' });
    for (let pageNum = 0; pageNum < 6; pageNum++) {
      await expect(userSection.locator('table.ws-table, .ws-empty-state').first()).toBeVisible({ timeout: 15000 });
      const row = userSection.locator('table.ws-table tbody tr', { hasText: username });
      if (await row.count() > 0 && await row.first().isVisible()) {
        return row.first();
      }
      const nextBtn = userSection.locator('footer.ws-pagination button:has-text("Sonraki")');
      if (await nextBtn.isVisible() && !await nextBtn.isDisabled()) {
        await nextBtn.click();
        await expect(userSection.locator('table.ws-table').first()).toBeVisible({ timeout: 10000 });
      } else {
        break;
      }
    }
    const finalRow = userSection.locator('table.ws-table tbody tr', { hasText: username }).first();
    await expect(finalRow).toBeVisible({ timeout: 10000 });
    return finalRow;
  }

  async function cleanupAllTestAccounts(browser, cleanPrefix = prefix) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      await ensureOwnerLoggedIn(page);

      await page.evaluate(async (pfx) => {
        const sessionResp = await fetch('/api/auth/session').catch(() => null);
        const sessionData = await sessionResp?.json().catch(() => null);
        const csrf = sessionData?.data?.csrfToken;
        const currentOwner = sessionData?.data?.user?.username;
        const headers = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };

        // 1. Bayi ve müşteri profillerini kaldır
        for (const kind of ['customer', 'reseller']) {
          const res = await fetch(`/api/panel/users/hosting/accounts?kind=${kind}&limit=100`).catch(() => null);
          const data = await res?.json().catch(() => null);
          for (const acc of data?.data?.accounts || []) {
            const u = acc.username || '';
            if (u.startsWith(pfx) || u.startsWith('trol07-')) {
              await fetch(`/api/panel/users/hosting/accounts/${encodeURIComponent(acc.id)}/profile`, {
                method: 'DELETE',
                headers,
                body: JSON.stringify({
                  revision: acc.revision ?? 1,
                  confirmation: `unregister-hosting-profile:${acc.id}:${acc.revision ?? 1}`,
                }),
              }).catch(() => null);
            }
          }
        }

        // 2. /api/panel/users listesinden kullanıcıları sil
        const usersRes = await fetch('/api/panel/users?limit=100').catch(() => null);
        const usersData = await usersRes?.json().catch(() => null);
        for (const u of usersData?.data?.users || []) {
          const uname = u.username || '';
          if (uname !== currentOwner && (uname.startsWith(pfx) || uname.startsWith('trol07-'))) {
            await fetch(`/api/panel/users/${encodeURIComponent(u.id)}`, {
              method: 'DELETE',
              headers,
              body: JSON.stringify({ revision: u.revision }),
            }).catch(() => null);
          }
        }
      }, cleanPrefix);
    } finally {
      try {
        await context.close();
      } catch {}
      for (const u of [OWNER_USER, RES_USER]) {
        try {
          fs.rmSync(path.join(AUTH_DIR, `${u}.json`), { force: true });
        } catch {}
      }
    }
  }

  test.beforeAll(async ({ browser }) => {
    await cleanupAllTestAccounts(browser);
  });

  test.afterAll(async ({ browser }) => {
    await cleanupAllTestAccounts(browser);
  });

  test('mutlu yol: izole hesapta parola değiştirme, diğer oturumu sonlandırma, yeni parolayla giriş, kurtarma e-postası ve aktif oturum yönetimi', async ({ browser, page }) => {
    // 1. Owner ile kullanıcılar sayfasına gidip izole test Owner hesabı oluştur
    await ensureOwnerLoggedIn(page);
    await expect(page.locator('aside.ws-sidebar')).toBeVisible({ timeout: 15000 });
    await page.goto('/settings/users');
    await expect(page.locator('h1')).toContainText('Kullanıcılar');

    await page.locator('button:has-text("Kullanıcı ekle")').click();
    const createDialog = page.locator('.ws-modal').filter({ hasText: 'Kullanıcı ekle' });
    await expect(createDialog).toBeVisible({ timeout: 10000 });

    await createDialog.locator('label:has-text("Kullanıcı adı") input').fill(OWNER_USER);
    await createDialog.locator('label:has-text("İlk parola") input').fill(PASS_INITIAL);
    await createDialog.locator('label:has-text("Rol") select').selectOption('owner');
    await createDialog.locator('label:has-text("Hesap durumu") select').selectOption('true');
    await createDialog.locator('button[type="submit"]:has-text("Hesap oluştur")').click();
    await expect(createDialog).toBeHidden({ timeout: 15000 });

    const ownerRow = await findAccountRow(page, OWNER_USER);
    await expect(ownerRow).toContainText('Owner');

    // 2. İki ayrı tarayıcı bağlamında (ctxA ve ctxB) OWNER_USER ile oturum aç (Owner oturumu korunur)
    const ctxA = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageA = await ctxA.newPage();
    const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageB = await ctxB.newPage();
    try {
      await pageA.goto('/');
      await expect(pageA.locator('form.auth-form')).toBeVisible({ timeout: 15000 });
      await pageA.fill('input[name="username"]', OWNER_USER);
      await pageA.fill('input[name="password"]', PASS_INITIAL);
      await pageA.click('button.auth-primary');
      await expect(pageA.locator('.auth-sessionbar')).toContainText(OWNER_USER, { timeout: 15000 });

      await pageB.goto('/');
      await expect(pageB.locator('form.auth-form')).toBeVisible({ timeout: 15000 });
      await pageB.fill('input[name="username"]', OWNER_USER);
      await pageB.fill('input[name="password"]', PASS_INITIAL);
      await pageB.click('button.auth-primary');
      await expect(pageB.locator('.auth-sessionbar')).toContainText(OWNER_USER, { timeout: 15000 });

      // 3. Hesabım modalını aç
      await pageA.locator('.auth-sessionbar button:has-text("Hesabım")').click();
      const accountDialog = pageA.locator('dialog.auth-dialog[open]');
      await expect(accountDialog).toBeVisible({ timeout: 10000 });
      await expect(accountDialog.locator('h2#account-heading')).toContainText('Hesabım');

      // 4. Kurtarma E-postası kaydetme ve API fiziki doğrulaması
      const emailInput = accountDialog.locator('form:has-text("Kurtarma E-postası") input[type="email"]');
      await emailInput.fill(RECOVERY_EMAIL);
      await accountDialog.locator('form:has-text("Kurtarma E-postası") button[type="submit"]').click();
      await expect(accountDialog.locator('p.auth-notice[role="status"]')).toContainText('Kurtarma e-postası başarıyla güncellendi.');

      // API fiziksel kontrolü
      const emailApiRes = await pageA.request.get('/api/auth/recovery-email');
      expect(emailApiRes.ok()).toBeTruthy();
      const emailApiData = await emailApiRes.json();
      expect(emailApiData.data?.email).toBe(RECOVERY_EMAIL);
      expect(emailApiData.data?.verified).toBe(true);

      // Kurtarma e-postasını temizleme
      await emailInput.fill('');
      await accountDialog.locator('form:has-text("Kurtarma E-postası") button[type="submit"]').click();
      await expect(accountDialog.locator('p.auth-notice[role="status"]')).toContainText('Kurtarma e-postası kaldırıldı.');

      // 5. Aktif oturumlar listesi ve Diğer oturumu sonlandırma
      const sessionsSection = accountDialog.locator('section.auth-sessions');
      await expect(sessionsSection).toBeVisible();
      await expect(sessionsSection.locator('div', { hasText: 'Bu oturum' })).toBeVisible({ timeout: 10000 });
      const otherSessionRow = sessionsSection.locator('div', { hasText: 'Diğer oturum' }).first();
      await expect(otherSessionRow).toBeVisible({ timeout: 10000 });

      // Diğer oturumu sonlandır
      await otherSessionRow.locator('button:has-text("Sonlandır")').click();
      await expect(sessionsSection.locator('div', { hasText: 'Diğer oturum' })).toHaveCount(0, { timeout: 10000 });

      // Fiziksel doğrulama: ctxB oturumunun iptal edildiğini (401) doğrula
      const sessionBRes = await pageB.request.get('/api/auth/session');
      expect(sessionBRes.status()).toBe(401);

      // 6. Keep-alive uç noktasını doğrula
      const keepAliveOutcome = await pageA.evaluate(async () => {
        const sessionRes = await fetch('/api/auth/session');
        const sessionData = await sessionRes.json();
        const csrf = sessionData.data?.csrfToken;
        const res = await fetch('/api/auth/keep-alive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
        });
        return { ok: res.ok, status: res.status, data: await res.json() };
      });
      expect(keepAliveOutcome.ok).toBeTruthy();
      expect(keepAliveOutcome.data?.data?.id).toBeTruthy();

      // 7. Parola değiştirme akışı
      const passForm = accountDialog.locator('form:has-text("Parolayı değiştir")');
      await passForm.getByLabel('Mevcut parola', { exact: true }).fill(PASS_INITIAL);
      await passForm.getByLabel('Yeni parola', { exact: true }).fill(PASS_UPDATED);
      await passForm.getByLabel('Yeni parola tekrarı', { exact: true }).fill(PASS_UPDATED);
      await passForm.locator('button[type="submit"]:has-text("Parolayı değiştir")').click();

      // Değişiklik sonrası kullanıcı giriş ekranına yönlendirilmeli ve bildirim gösterilmeli
      const authForm = pageA.locator('form.auth-form');
      await expect(authForm).toBeVisible({ timeout: 15000 });
      await expect(pageA.locator('p.auth-notice[role="status"]')).toContainText('Parolanız değiştirildi. Yeni parolanızla giriş yapın.');

      // 8. Fiziksel doğrulama: Eski parola ile giriş reddedilmeli
      await pageA.fill('input[name="username"]', OWNER_USER);
      await pageA.fill('input[name="password"]', PASS_INITIAL);
      await pageA.click('button.auth-primary');
      await expect(pageA.locator('p.auth-error[role="alert"]')).toContainText(/Kullanıcı adı, parola veya kurulum anahtarı geçersiz/i);

      // Yeni parola ile giriş başarılı olmalı
      await pageA.fill('input[name="password"]', PASS_UPDATED);
      await pageA.click('button.auth-primary');
      await expect(pageA.locator('.auth-sessionbar')).toContainText(OWNER_USER, { timeout: 15000 });
      try {
        await ctxA.storageState({ path: path.join(AUTH_DIR, `${OWNER_USER}.json`) });
      } catch {}
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('hatalı girdi ve sınırlar: eşleşmeyen yeni parola, yanlış mevcut parola, geçersiz e-posta, geçersiz MFA kodu ve geçersiz parola sıfırlama anahtarı', async ({ page }) => {
    // 1. OWNER_USER oturumunda Hesabım modalını aç
    await loginAs(page, OWNER_USER, PASS_UPDATED);
    await expect(page.locator('.auth-sessionbar')).toContainText(OWNER_USER);
    await page.locator('.auth-sessionbar button:has-text("Hesabım")').click();

    const accountDialog = page.locator('dialog.auth-dialog[open]');
    await expect(accountDialog).toBeVisible({ timeout: 10000 });

    // Hatalı girdi 1: Yeni parolalar eşleşmiyor
    const passForm = accountDialog.locator('form:has-text("Parolayı değiştir")');
    await passForm.getByLabel('Mevcut parola', { exact: true }).fill(PASS_UPDATED);
    await passForm.getByLabel('Yeni parola', { exact: true }).fill('MismatchPass123!');
    await passForm.getByLabel('Yeni parola tekrarı', { exact: true }).fill('DifferentPass456!');
    await passForm.locator('button[type="submit"]:has-text("Parolayı değiştir")').click();

    const errorAlert = accountDialog.locator('p.auth-error[role="alert"]');
    await expect(errorAlert).toBeVisible({ timeout: 10000 });
    await expect(errorAlert).toContainText('Yeni parolalar eşleşmiyor.');

    // Hatalı girdi 2: Yanlış mevcut parola
    await passForm.getByLabel('Mevcut parola', { exact: true }).fill('YanlisMevcutParola123!');
    await passForm.getByLabel('Yeni parola', { exact: true }).fill('GecerliYeniParola123!');
    await passForm.getByLabel('Yeni parola tekrarı', { exact: true }).fill('GecerliYeniParola123!');
    await passForm.locator('button[type="submit"]:has-text("Parolayı değiştir")').click();
    await expect(errorAlert).toBeVisible({ timeout: 10000 });
    await expect(errorAlert).toContainText(/Kullanıcı adı, parola veya kurulum anahtarı geçersiz/i);

    // Hatalı girdi 3: Geçersiz formatta e-posta adresi (API HTTP 400 invalid_email)
    const invalidEmailOutcome = await page.evaluate(async () => {
      const sessionRes = await fetch('/api/auth/session');
      const sessionData = await sessionRes.json();
      const csrf = sessionData.data?.csrfToken;
      const res = await fetch('/api/auth/recovery-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ email: 'gecersiz-eposta-formati' }),
      });
      return { status: res.status, data: await res.json() };
    });
    expect(invalidEmailOutcome.status).toBe(400);
    const code = invalidEmailOutcome.data?.error?.code || invalidEmailOutcome.data?.code;
    expect(code).toBe('invalid_email');

    // Modalı Kapat butonuyla kapat
    await accountDialog.locator('header button:has-text("Kapat")').click();
    await expect(accountDialog).toBeHidden({ timeout: 10000 });

    // 2. Parolamı unuttum ekranı ve geçersiz sıfırlama anahtarı (#reset-token)
    await logout(page);
    await expect(page.locator('form.auth-form')).toBeVisible({ timeout: 15000 });

    await page.locator('button.auth-link:has-text("Parolamı unuttum")').click();
    await expect(page.locator('h2#auth-heading')).toContainText('Parola Sıfırlama İsteği');

    await page.locator('label:has-text("Kullanıcı adı veya kurtarma e-postası") input').fill(OWNER_USER);
    await page.locator('button[type="submit"]:has-text("Sıfırlama bağlantısı gönder")').click();

    await expect(page.locator('p.auth-notice[role="status"]')).toContainText(
      /Eğer kayıtlı ve doğrulanmış bir kurtarma e-postası varsa.*sıfırlama bağlantısı/i
    );

    // Geçersiz reset token ile doğrudan hash rotasına gitme
    await page.goto('/#reset-token=gecersiz-ve-olmayan-token-12345678901234567890');
    await expect(page.locator('h2#auth-heading')).toContainText('Yeni Parola Belirleyin');

    await page.getByLabel('Yeni parola', { exact: true }).fill('SifirlamaTesti123!');
    await page.getByLabel('Yeni parola tekrarı', { exact: true }).fill('SifirlamaTesti123!');
    await page.locator('button[type="submit"]:has-text("Parolayı güncelle")').click();

    await expect(page.locator('p.auth-error[role="alert"]')).toContainText(
      /Geçersiz veya süresi dolmuş parola sıfırlama bağlantısı/i
    );
  });

  test('iki adımlı doğrulama (MFA / TOTP): kurulum, iptal, doğrulama, kurtarma kodları, MFA ile giriş, kurtarma kodu tüketimi ve MFA devre dışı bırakma', async ({ page }) => {
    // 1. OWNER_USER ile oturum aç ve Hesabım modalını aç
    await page.goto('/');
    await page.fill('input[name="username"]', OWNER_USER);
    await page.fill('input[name="password"]', PASS_UPDATED);
    await page.click('button.auth-primary');
    await expect(page.locator('.auth-sessionbar')).toContainText(OWNER_USER, { timeout: 15000 });

    await page.locator('.auth-sessionbar button:has-text("Hesabım")').click();
    const accountDialog = page.locator('dialog.auth-dialog[open]');
    await expect(accountDialog).toBeVisible({ timeout: 10000 });

    const mfaSection = accountDialog.locator('section.mfa-settings');
    await expect(mfaSection).toBeVisible();

    // Hatalı parola ile MFA başlatma
    await mfaSection.locator('label:has-text("Mevcut parola") input').fill('YanlisParola123!');
    await mfaSection.locator('button:has-text("Doğrulayıcı ekle")').click();
    await expect(accountDialog.locator('p.auth-error[role="alert"]')).toContainText(/Kullanıcı adı, parola veya kurulum anahtarı geçersiz/i);

    // Doğru parolayla MFA kurulumunu başlat
    await mfaSection.locator('label:has-text("Mevcut parola") input').fill(PASS_UPDATED);
    await mfaSection.locator('button:has-text("Doğrulayıcı ekle")').click();

    const secretInput = mfaSection.locator('input.mfa-secret');
    await expect(secretInput).toBeVisible({ timeout: 10000 });
    const initialSecret = await secretInput.inputValue();
    expect(initialSecret).toMatch(/^[A-Z2-7]{32}$/);

    // Kurulumu iptal etme testi
    await mfaSection.locator('button:has-text("Kurulumu iptal et")').click();
    await expect(mfaSection.locator('button:has-text("Doğrulayıcı ekle")')).toBeVisible({ timeout: 10000 });

    // Tekrar başlat ve geçerli anahtarı al
    await mfaSection.locator('label:has-text("Mevcut parola") input').fill(PASS_UPDATED);
    await mfaSection.locator('button:has-text("Doğrulayıcı ekle")').click();
    await expect(secretInput).toBeVisible({ timeout: 10000 });
    const totpSecret = await secretInput.inputValue();
    expect(totpSecret).toMatch(/^[A-Z2-7]{32}$/);

    // Hatalı kod ile onaylama
    await mfaSection.locator('label:has-text("Uygulama kodu") input').fill('000000');
    await mfaSection.locator('button:has-text("Doğrula ve etkinleştir")').click();
    await expect(accountDialog.locator('p.auth-error[role="alert"]')).toContainText(/Kod geçersiz veya kullanılmış/i);

    // Geçerli RFC 6238 TOTP kodu üret ve etkinleştir
    const totp = new TOTP({
      secret: totpSecret,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    });
    const validCode = totp.generate();
    await mfaSection.locator('label:has-text("Uygulama kodu") input').fill(validCode);
    await mfaSection.locator('button:has-text("Doğrula ve etkinleştir")').click();

    // 10 kurtarma kodu ekranı ve hassas modda Kapat butonunun kilitlenmesi
    const recoveryArea = mfaSection.locator('div.mfa-recovery textarea');
    await expect(recoveryArea).toBeVisible({ timeout: 10000 });
    await expect(accountDialog.locator('header button:has-text("Kapat")')).toBeDisabled();

    const recoveryCodesText = await recoveryArea.inputValue();
    const recoveryCodes = recoveryCodesText.trim().split('\n').filter(Boolean);
    expect(recoveryCodes.length).toBe(10);
    for (const code of recoveryCodes) {
      expect(code).toMatch(/^[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}$/);
    }

    // Kodları güvenle kaydettim butonuna bas
    await mfaSection.locator('button:has-text("Kodları güvenle kaydettim")').click();
    await expect(mfaSection.locator('p.auth-notice')).toContainText('Etkin · 10 kullanılmamış kurtarma kodu');

    // Modalı kapat
    await accountDialog.locator('header button:has-text("Kapat")').click();
    await expect(accountDialog).toBeHidden({ timeout: 10000 });

    // 2. Çıkış yap ve MFA ile giriş doğrulaması
    await logout(page);
    try {
      fs.rmSync(path.join(AUTH_DIR, `${OWNER_USER}.json`), { force: true });
    } catch {}

    await page.fill('input[name="username"]', OWNER_USER);
    await page.fill('input[name="password"]', PASS_UPDATED);
    await page.click('button.auth-primary');

    // İkinci adım (MFA challenge) ekranı açılmalı
    await expect(page.locator('h2#auth-heading')).toContainText('Girişinizi doğrulayın');

    // Kurtarma kodu yöntemi seçilerek ilk kurtarma kodu ile giriş yap
    await page.locator('label:has-text("Doğrulama yöntemi") select').selectOption('recovery');
    await page.locator('label:has-text("Tek kullanımlık kurtarma kodu") input').fill(recoveryCodes[0]);
    await page.locator('button[type="submit"]:has-text("Doğrula ve giriş yap")').click();

    // Giriş başarılı olmalı
    await expect(page.locator('.auth-sessionbar')).toContainText(OWNER_USER, { timeout: 15000 });

    // Kalan kurtarma kodu sayısının 9'a düştüğünü doğrula
    await page.locator('.auth-sessionbar button:has-text("Hesabım")').click();
    await expect(accountDialog).toBeVisible({ timeout: 10000 });
    await expect(mfaSection.locator('p.auth-notice')).toContainText('Etkin · 9 kullanılmamış kurtarma kodu');

    // 3. MFA kapatma akışı (kullanılmamış kurtarma kodu ile güvenli devre dışı bırakma)
    await mfaSection.locator('label:has-text("İşlem") select').selectOption('disable');
    await mfaSection.locator('label:has-text("Mevcut parola") input').fill(PASS_UPDATED);
    await mfaSection.locator('label:has-text("Doğrulama yöntemi") select').selectOption('recovery');
    await mfaSection.locator('label:has-text("Kurtarma kodu") input').fill(recoveryCodes[1]);
    await mfaSection.locator('button[type="submit"]:has-text("Doğrulamayı kapat ve çıkış yap")').click();

    // Oturum kapatılmalı ve bildirim verilmeli
    await expect(page.locator('form.auth-form')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('p.auth-notice[role="status"]')).toContainText('İki adımlı doğrulama kapatıldı. Yeniden giriş yapın.');

    // Fiziksel doğrulama: Artık MFA sormadan doğrudan giriş yapılabilmeli
    await page.fill('input[name="username"]', OWNER_USER);
    await page.fill('input[name="password"]', PASS_UPDATED);
    await page.click('button.auth-primary');
    await expect(page.locator('.auth-sessionbar')).toContainText(OWNER_USER, { timeout: 15000 });
  });

  test('rol ve yetki: Bayi hesabı oluşturma, Hesabım modalı ve temel bölümlerin kullanılabilirliği', async ({ page }) => {
    // 1. Owner ile Bayi (Reseller) hesabı oluştur
    await ensureOwnerLoggedIn(page);
    await expect(page.locator('aside.ws-sidebar')).toBeVisible({ timeout: 15000 });
    await page.goto('/resellers');
    await expect(page.locator('h1')).toContainText('Bayiler');

    await page.locator('button:has-text("Bayi ekle")').click();
    const createResDialog = page.locator('dialog[open]');
    await expect(createResDialog).toBeVisible({ timeout: 10000 });

    await createResDialog.locator('label:has-text("Kullanıcı adı") input').fill(RES_USER);
    await createResDialog.locator('label:has-text("İlk parola") input').fill(PASS_INITIAL);
    await createResDialog.locator('label:has-text("En fazla müşteri") input').fill('2');
    await createResDialog.locator('label:has-text("En fazla web sitesi") input').fill('2');
    await createResDialog.locator('button[type="submit"]:has-text("Hesabı oluştur")').click();
    await expect(createResDialog).toBeHidden({ timeout: 15000 });

    // 2. Bayi ile oturum aç
    const resContext = await page.context().browser().newContext({ ignoreHTTPSErrors: true });
    const resPage = await resContext.newPage();
    try {
      await resPage.goto('/');
      await expect(resPage.locator('form.auth-form')).toBeVisible({ timeout: 15000 });
      await resPage.fill('input[name="username"]', RES_USER);
      await resPage.fill('input[name="password"]', PASS_INITIAL);
      await resPage.click('button.auth-primary');
      await expect(resPage.locator('.auth-sessionbar')).toContainText(RES_USER, { timeout: 15000 });
      try {
        await resContext.storageState({ path: path.join(AUTH_DIR, `${RES_USER}.json`) });
      } catch {}

      // 3. Hesabım modalını aç ve izinli bölümleri kontrol et
      await resPage.locator('.auth-sessionbar button:has-text("Hesabım")').click();
      const accountDialog = resPage.locator('dialog.auth-dialog[open]');
      await expect(accountDialog).toBeVisible({ timeout: 10000 });

      await expect(accountDialog.locator('form:has-text("Parolayı değiştir")')).toBeVisible();
      await expect(accountDialog.locator('section.mfa-settings')).toBeVisible();
      await expect(accountDialog.locator('section.auth-sessions')).toBeVisible();

      await accountDialog.locator('header button:has-text("Kapat")').click();
      await expect(accountDialog).toBeHidden({ timeout: 10000 });
    } finally {
      await resContext.close();
    }
  });

  test('bilinen hata: üst oturum çubuğundaki rol rozeti Bayi hesabında Site Manager olarak görünüyor', async ({ page }) => {
    test.fail(true, 'ROL-07: Üst oturum çubuğundaki rol rozeti Bayi ve Müşteri hesaplarında Site Manager olarak görünüyor');

    await loginAs(page, RES_USER, PASS_INITIAL);
    await expect(page.locator('.auth-sessionbar')).toContainText(RES_USER);

    // Plesk Obsidian eşdeğeri olarak Bayi rol rozeti beklenir; YunPanel AuthGate.jsx:133 nedeniyle 'Site Manager' gösterir ve başarısız olur
    const roleBadge = page.locator('.auth-sessionbar .auth-role');
    await expect(roleBadge).toContainText(/bayi|reseller/i);
  });

  test('bilinen hata: Bayi hesabında Kurtarma E-postası formu gizli ve API 403 Forbidden dönüyor', async ({ page }) => {
    test.fail(true, 'ROL-07: Bayi ve Müşteri hesaplarında kurtarma/iletişim e-postası formu eksik ve API 403 Forbidden dönüyor');

    await loginAs(page, RES_USER, PASS_INITIAL);
    await expect(page.locator('.auth-sessionbar')).toContainText(RES_USER);

    // Hesabım modalında form kontrolü
    await page.locator('.auth-sessionbar button:has-text("Hesabım")').click();
    const accountDialog = page.locator('dialog.auth-dialog[open]');
    await expect(accountDialog).toBeVisible({ timeout: 10000 });

    // Plesk My Profile eşdeğeri olarak kurtarma/iletişim e-postası alanı beklenir; YunPanel'de Owner dışındaki rollere gizlidir
    await expect(accountDialog.locator('h3:has-text("Kurtarma E-postası")')).toBeVisible();
  });

  test('bilinen hata: /settings?section=account sayfasında profil/oturum yönetim formu veya butonu bulunmuyor', async ({ page }) => {
    test.fail(true, 'ROL-07: /settings?section=account sayfasında profil/parola/MFA formu veya Hesabım modalını açan bir buton bulunmuyor');

    // Owner ile ayarlar hesap bölümüne git
    await ensureOwnerLoggedIn(page);
    await expect(page.locator('aside.ws-sidebar')).toBeVisible({ timeout: 15000 });
    await page.goto('/settings?section=account');
    await expect(page.locator('h1')).toContainText(/Ayarlar|Hesap/i);

    // Plesk eşdeğeri olarak doğrudan profil düzenleme formu veya modal açıcı işlem butonu beklenir; YunPanel'de yalnızca statik yönlendirme metni vardır
    await expect(page.locator('button:has-text("Hesabımı Yönet"), form:has-text("Parola")')).toBeVisible();
  });
});
