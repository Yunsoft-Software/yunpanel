import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('SEC-04 Oturum/MFA/parola politikası ve API erişim sınırı', () => {
  test.setTimeout(240000);

  const agentN = process.env.AGENT_N || '4';
  const prefix = `tsec04-a${agentN}-${Date.now().toString(36)}`;
  const digest = (val) => crypto.createHash('sha256').update(val).digest('hex');

  function runSsh(command) {
    try {
      return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
        encoding: 'utf8',
        timeout: 20000,
      }).trim();
    } catch (err) {
      return (err.stdout || '') + (err.stderr || '');
    }
  }

  test.afterAll(async () => {
    // Test sırasında eklenmiş olabilecek geçici rate limit veya kullanıcı kayıtlarını temizle
    runSsh(`sqlite3 /var/lib/yunpanel/control-plane/auth/auth.sqlite "DELETE FROM auth_limits WHERE key LIKE '%${prefix}%'; DELETE FROM users WHERE username LIKE '%${prefix}%';"`);
  });

  test('mutlu yol: oturum çerezleri, MFA & aktif oturum listesi ve CSRF sınır kontrolü', async ({ page }) => {
    // 1. Giriş yap
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await expect(page.locator('.auth-sessionbar')).toBeVisible();

    // 2. Oturum çerezi özelliklerini doğrula (HttpOnly, SameSite=Strict, Secure)
    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((c) => c.name.includes('yunpanel_session'));
    expect(sessionCookie, 'yunpanel_session çerezi bulunmalı').toBeDefined();
    expect(sessionCookie.httpOnly, 'Oturum çerezi HttpOnly olmalı').toBe(true);
    expect(sessionCookie.sameSite, 'Oturum çerezi SameSite Strict olmalı').toBe('Strict');
    if (page.url().startsWith('https://')) {
      expect(sessionCookie.secure, 'HTTPS altında oturum çerezi Secure olmalı').toBe(true);
    }

    // 3. Arayüzden "Hesabım" (AccountDialog) modalını aç ve oturum/MFA kontrollerini yap
    const accountBtn = page.locator('.auth-sessionbar button:has-text("Hesabım")');
    await expect(accountBtn).toBeVisible({ timeout: 10000 });
    await accountBtn.click();

    const dialog = page.locator('dialog.auth-dialog[open]');
    await expect(dialog.locator('h2:has-text("Hesabım")')).toBeVisible({ timeout: 10000 });

    // MFA ve Aktif Oturumlar alanlarının mevcut olduğunu doğrula
    await expect(dialog.locator('fieldset.mfa-container')).toBeVisible();
    const sessionsSec = dialog.locator('section.auth-sessions');
    await expect(sessionsSec).toBeVisible();
    await expect(sessionsSec.locator('div', { hasText: 'Bu oturum' })).toBeVisible({ timeout: 10000 });

    // Modal'ı kapat
    await dialog.locator('button:has-text("Kapat")').click();
    await expect(page.locator('dialog.auth-dialog[open]')).toHaveCount(0, { timeout: 10000 });

    // 4. CSRF Koruması Doğrulaması (API Düzeyinde Sahte Origin Engeli)
    const forgedOriginRes = await page.request.post('/api/auth/profile', {
      headers: {
        Origin: 'https://evil-attacker-site.com',
      },
      data: {
        email: 'test@example.com',
      },
    });
    // Origin uyuşmazlığı durumunda sunucu 403 Forbidden dönmeli
    expect(forgedOriginRes.status(), 'Sahte Origin istekleri 403 ile engellenmeli').toBe(403);

    // 5. Fiziksel Sonuç: Sunucu üzerindeki auth.sqlite veritabanında aktif oturum kaydı doğrulanır
    const activeSessionsCount = runSsh(
      `sqlite3 /var/lib/yunpanel/control-plane/auth/auth.sqlite "SELECT count(*) FROM sessions WHERE expires_at > (strftime('%s', 'now') * 1000);"`
    );
    const countNum = parseInt(activeSessionsCount, 10);
    expect(Number.isFinite(countNum) && countNum >= 1, 'Sunucuda en az 1 aktif oturum fiziksel olarak kayıtlı olmalı').toBe(true);
  });

  test('hatalı girdi 1: parola politikası (12 karakter kuralı ve uyuşmazlık denetimi)', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    // 1. AccountDialog üzerinden parola politikası kısıtlarının doğrulanması
    const accountBtn = page.locator('.auth-sessionbar button:has-text("Hesabım")');
    await expect(accountBtn).toBeVisible({ timeout: 10000 });
    await accountBtn.click();

    const dialog = page.locator('dialog.auth-dialog[open]');
    await expect(dialog.locator('h2:has-text("Hesabım")')).toBeVisible({ timeout: 10000 });

    const currentPass = dialog.locator('label:has-text("Mevcut parola") input');
    const newPass = dialog.locator('label:has-text("Yeni parola"):not(:has-text("tekrarı")) input');
    const confirmPass = dialog.locator('label:has-text("Yeni parola tekrarı") input');

    // 12 karakter altı zayıf parola denetimi (HTML5 validity)
    await currentPass.fill('CurrentSecret123!');
    await newPass.fill('short123');
    await confirmPass.fill('short123');

    const isValid = await newPass.evaluate((el) => el.checkValidity());
    expect(isValid, '12 karakterden kısa parola içeren input geçersiz olmalı').toBe(false);
    const minLengthAttr = await newPass.getAttribute('minLength');
    expect(minLengthAttr, 'Parola alanında minLength=12 kuralı bulunmalı').toBe('12');

    // Parola eşleşmeme denetimi
    await newPass.fill('ValidNewSecret123456!');
    await confirmPass.fill('DifferentSecret123456!');
    await dialog.locator('button[type="submit"]:has-text("Parolayı değiştir")').click();

    const dialogError = dialog.locator('.auth-error, [role="alert"]');
    await expect(dialogError).toBeVisible({ timeout: 10000 });
    await expect(dialogError).toContainText(/eşleşmiyor/i);

    // Modal'ı kapat
    await dialog.locator('button:has-text("Kapat")').click();
    await expect(page.locator('dialog.auth-dialog[open]')).toHaveCount(0, { timeout: 10000 });

    // 2. Kullanıcılar sayfasında da yeni kullanıcı için 12 karakter parola zorunluluğunun teyidi
    await page.goto('/settings/users');
    await expect(page.locator('h1', { hasText: 'Kullanıcılar' })).toBeVisible({ timeout: 15000 });

    await page.click('button:has-text("Kullanıcı ekle")');
    await expect(page.locator('h2:has-text("Kullanıcı ekle")')).toBeVisible();

    const userPassInput = page.locator('input[name="new-password"]');
    await userPassInput.fill('short123');
    const userPassValid = await userPassInput.evaluate((el) => el.checkValidity());
    expect(userPassValid, 'Kullanıcı ekleme formunda da 12 karakter altı parola reddedilmeli').toBe(false);

    // Modalı kapat
    const cancelBtn = page.locator('dialog[open] button:has-text("Vazgeç"), dialog[open] button:has-text("İptal"), dialog[open] button:has-text("Kapat")').first();
    if (await cancelBtn.isVisible()) {
      await cancelBtn.click();
    } else {
      await page.keyboard.press('Escape');
    }
  });

  test('hatalı girdi 2: API erişim sınırı ve kaba kuvvet (brute-force rate limit) koruması', async ({ page }) => {
    await page.goto('/');
    const targetUser = `${prefix}_brute`;
    const userDigest = digest(targetUser);

    // Tarayıcı oturumu üzerinden 11 kez hatalı parola ile login dene
    const attemptsResult = await page.evaluate(async (username) => {
      const statuses = [];
      let lastBody = null;
      for (let i = 1; i <= 11; i++) {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username, password: 'WrongPassword123!' }),
        });
        statuses.push(res.status);
        if (i === 11) {
          lastBody = await res.json().catch(() => ({}));
        }
      }
      return { statuses, lastBody };
    }, targetUser);

    // İlk 10 deneme normal 401 Unauthorized döner (invalid_credentials)
    expect(attemptsResult.statuses.slice(0, 10).every((s) => s === 401 || s === 400), 'İlk 10 deneme 400 veya 401 olmalı').toBe(true);

    // 11. denemede rate limit devreye girer ve 429 Too Many Requests döner
    expect(attemptsResult.statuses[10], '11. denemede 429 Rate Limited dönmeli').toBe(429);
    expect(attemptsResult.lastBody?.error?.code || attemptsResult.lastBody?.error, 'Hata kodu rate_limited olmalı').toBe('rate_limited');

    // Fiziksel Sonuç: Sunucu üzerindeki auth_limits tablosunda user rate limit kaydı doğrulanır
    const attempts = runSsh(
      `sqlite3 /var/lib/yunpanel/control-plane/auth/auth.sqlite "SELECT attempts FROM auth_limits WHERE key = 'login:user:${userDigest}';"`
    );
    const attemptsNum = parseInt(attempts, 10);
    expect(attemptsNum >= 10, 'Sunucu auth_limits tablosunda en az 10 deneme kaydı bulunmalı').toBe(true);
  });

  test('Plesk Eşdeğerliği: Global Güvenlik Politikası (oturum süresi, parola karmaşıklığı ve zorunlu MFA) yönetim arayüzü', async ({ page }) => {
    test.fail(
      true,
      'PLESK PARITY EKSİKLİK: Tools & Settings altında global Güvenlik Politikası (oturum zaman aşımı süresi, parola karmaşıklık seçimi ve zorunlu MFA kuralı) yapılandırma ekranı bulunmuyor.'
    );

    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/settings');
    await expect(page.locator('h1')).toBeVisible();

    // Plesk'te "Security Policy" veya "Güvenlik Politikası" bağlantısı aranır
    const secPolicyLink = page.locator('a:has-text("Güvenlik Politikası"), a:has-text("Security Policy")');
    await expect(secPolicyLink).toBeVisible({ timeout: 3000 });
  });
});
