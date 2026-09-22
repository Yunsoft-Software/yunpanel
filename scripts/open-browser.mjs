import { chromium } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD } from '../e2e/helpers.js';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'https://server.cryptoraichu.website';

async function main() {
  console.log('Tarayıcı başlatılıyor...');
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();
  console.log(`${BASE_URL} adresine gidiliyor...`);
  await page.goto(BASE_URL);

  await page.waitForSelector('.auth-sessionbar, form.auth-form', { timeout: 20000 });

  const authForm = page.locator('form.auth-form');
  if (await authForm.isVisible()) {
    console.log('Giriş yapılıyor...');
    await page.fill('input[name="username"]', OWNER_USERNAME);
    await page.fill('input[name="password"]', OWNER_PASSWORD);
    await page.click('button.auth-primary');
    await page.waitForSelector('.auth-sessionbar', { timeout: 20000 });
    console.log('Başarıyla giriş yapıldı!');
  } else {
    console.log('Zaten oturum açık.');
  }

  console.log('Tarayıcı kullanıma hazır ve açık bırakıldı.');
  // Keep process alive indefinitely so browser stays open for user
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('Hata:', err);
  process.exit(1);
});
