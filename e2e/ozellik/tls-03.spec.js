import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

function runSsh(command) {
  return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
    encoding: 'utf8',
    timeout: 30000,
  });
}

function generateSelfSignedCert(domainName) {
  const tmpDir = execSync('mktemp -d', { encoding: 'utf8' }).trim();
  const certPath = path.join(tmpDir, 'cert.pem');
  const keyPath = path.join(tmpDir, 'key.pem');
  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -days 2 ` +
      `-subj "/CN=${domainName}" ` +
      `-addext "subjectAltName=DNS:${domainName}" ` +
      `-keyout "${keyPath}" -out "${certPath}"`,
      { stdio: 'pipe' }
    );
    return {
      certificatePem: fs.readFileSync(certPath, 'utf8'),
      privateKeyPem: fs.readFileSync(keyPath, 'utf8'),
      chainPem: '',
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test.describe.serial('TLS-03 Sertifika/anahtar/chain yükleme, CSR ve envanter', () => {
  test.setTimeout(180000);
  const agentN = process.env.AGENT_N || '2';
  const prefix = `ttls03-a${agentN}-${Date.now().toString(36)}`;
  const parentSuffix = 'webrich.news';
  const primaryDomain = `${prefix}.${parentSuffix}`;
  let createdDomainId = null;
  let installedCertId = null;
  let csrfToken = '';

  function apiHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-csrf-token': csrfToken,
      Origin: 'https://server.cryptoraichu.website',
      Referer: 'https://server.cryptoraichu.website/',
    };
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

    const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
    if (sessionRes && sessionRes.ok()) {
      const json = await sessionRes.json().catch(() => ({}));
      csrfToken = json?.data?.csrfToken || '';
    }
  });

  async function removeWebsiteById(page, domainId, domainName) {
    if (!domainId) return;
    try {
      await page.goto(`/websites/${encodeURIComponent(domainId)}/settings`);
      await page.waitForLoadState('networkidle').catch(() => {});
      const removalSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Siteyi sil' }) });
      if (await removalSection.isVisible({ timeout: 6000 }).catch(() => false)) {
        const deleteBtn = removalSection.locator('button', { hasText: /Siteyi sil/ });
        if (await deleteBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
          await deleteBtn.click();
          const dialog = page.locator('dialog.ws-modal, [role="dialog"], .ws-modal').filter({ hasText: /Siteyi kalıcı olarak sil|Silme/ });
          if (await dialog.isVisible({ timeout: 5000 }).catch(() => false)) {
            const input = dialog.locator('input');
            await input.fill(domainName);

            const submitBtn = dialog.locator('button', { hasText: /Silme işlemini başlat|Silme işlemine devam et/ });
            if (await submitBtn.isEnabled({ timeout: 4000 }).catch(() => false)) {
              await submitBtn.click();
              const resumeBtn = page.locator('button', { hasText: /Silme işlemine devam et/ });
              if (await resumeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                await resumeBtn.click();
              }
              const doneBtn = page.locator('button', { hasText: 'Web sitelerine dön' });
              await expect(doneBtn.or(page.locator('text=Site silindi'))).toBeVisible({ timeout: 20000 }).catch(() => {});
              if (await doneBtn.isVisible().catch(() => false)) {
                await doneBtn.click();
              }
              return;
            }
          }
        }
      }
    } catch (err) {
      console.warn('TLS-03 cleanup notice:', err.message);
    }
  }

  test.afterAll(async ({ browser }) => {
    test.setTimeout(180000);
    if (createdDomainId) {
      try {
        const page = await browser.newPage({ ignoreHTTPSErrors: true });
        try {
          await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
          await removeWebsiteById(page, createdDomainId, primaryDomain);
        } finally {
          await page.close().catch(() => {});
        }
      } catch (err) {
        console.warn('TLS-03 afterAll UI removal notice:', err.message);
      }
    }

    // 0 Artık ilkesi: Sunucuda kalan geçici test sertifikası ve kayıtları tamamen temizle
    try {
      const cleanCmd = "node -e \"const fs=require('fs'); const clean=(f,fn)=>{if(fs.existsSync(f)){const d=JSON.parse(fs.readFileSync(f,'utf8'));const arr=Array.isArray(d)?d:(d.domains||d.websites||d.operations||[]);const res=arr.filter(fn);if(Array.isArray(d))fs.writeFileSync(f,JSON.stringify(res,null,2));else{for(const k of Object.keys(d)){if(Array.isArray(d[k]))d[k]=d[k].filter(fn);}fs.writeFileSync(f,JSON.stringify(d,null,2));}}}; clean('/var/lib/yunpanel/control-plane/domain-registry.json',x=>!x.primaryDomain||!x.primaryDomain.includes('ttls03')); clean('/var/lib/yunpanel/control-plane/website-registry.json',x=>!x.name||!x.name.includes('ttls03')); clean('/var/lib/yunpanel/control-plane/website-removal-operations.json',x=>!x.label||!x.label.includes('ttls03')); clean('/var/lib/yunpanel/control-plane/domain-removal-operations.json',x=>!x.primaryDomain||!x.primaryDomain.includes('ttls03'));\" && rm -f /var/lib/yunpanel/staging/nginx/yunpanel-ttls03* && systemctl restart yunpanel-api.service";
      runSsh(cleanCmd);
      if (installedCertId) {
        runSsh(`rm -rf /var/lib/yunpanel/control-plane/custom-certificates/${installedCertId}`);
      }
    } catch {}
  });

  test('mutlu yol: Özel SSL sertifikası yükleme, fiziksel dosya varlığı, API envanteri ve UI doğrulaması', async ({ page }) => {
    // Varsa önceki koşudan kalan ttls03 alan adlarını temizle
    const domainsResPre = await page.request.get('/api/panel/domains');
    if (domainsResPre.ok()) {
      const json = await domainsResPre.json();
      const list = json.data?.domains || json.data || [];
      const leftovers = list.filter((d) => d.primaryDomain?.includes('ttls03') && !d.parentDomainId);
      for (const leftover of leftovers) {
        await removeWebsiteById(page, leftover.id, leftover.primaryDomain);
      }
    }

    // 1. Yeni test sitesi oluştur
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    const domainInput = page.locator('label:has-text("Alan adı") input');
    await expect(domainInput).toBeVisible();
    await domainInput.fill(primaryDomain);

    const wwwSelect = page.locator('label:has-text("www davranışı") select');
    if (await wwwSelect.isVisible().catch(() => false)) {
      await wwwSelect.selectOption('none');
    }

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
    const manageLink = resultElement.locator('a[href^="/websites/"]').first();
    await expect(manageLink).toBeVisible();
    const href = await manageLink.getAttribute('href');
    const match = href.match(/\/websites\/([^/?#]+)/);
    expect(match).toBeTruthy();
    createdDomainId = match[1];

    // 2. Gerçek RSA 2048 Özel Anahtar ve Self-Signed Sertifika üret
    const certMaterial = generateSelfSignedCert(primaryDomain);
    expect(certMaterial.certificatePem).toContain('BEGIN CERTIFICATE');
    expect(certMaterial.privateKeyPem).toContain('BEGIN PRIVATE KEY');

    // 3. Özel sertifika önizleme API çağrısı (custom-preview)
    const previewRes = await page.request.post(
      `/api/panel/domains/${encodeURIComponent(createdDomainId)}/certificates/custom-preview`,
      {
        headers: apiHeaders(),
        data: {
          certificatePem: certMaterial.certificatePem,
          chainPem: certMaterial.chainPem,
          privateKeyPem: certMaterial.privateKeyPem,
        },
      }
    );
    expect(previewRes.status()).toBe(200);
    const previewJson = await previewRes.json();
    const previewData = previewJson.data;
    expect(previewData).toBeTruthy();
    expect(previewData.operation).toBe('custom_certificate_import');
    expect(previewData.certificate.source).toBe('custom');
    expect(previewData.certificate.domains).toContain(primaryDomain);
    expect(previewData.previewDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(previewData.confirmation).toBeTruthy();

    // 4. Özel sertifikayı sisteme aktar / uygula (custom)
    const customApplyRes = await page.request.post(
      `/api/panel/domains/${encodeURIComponent(createdDomainId)}/certificates/custom`,
      {
        headers: apiHeaders(),
        data: {
          certificatePem: certMaterial.certificatePem,
          chainPem: certMaterial.chainPem,
          privateKeyPem: certMaterial.privateKeyPem,
          previewDigest: previewData.previewDigest,
          confirmation: previewData.confirmation,
        },
      }
    );
    expect(customApplyRes.status()).toBe(201);
    const customApplyJson = await customApplyRes.json();
    const appliedCert = customApplyJson.data?.certificate;
    expect(appliedCert).toBeTruthy();
    expect(appliedCert.id).toBeTruthy();
    expect(appliedCert.source).toBe('custom');
    expect(appliedCert.state).toBe('active');
    installedCertId = appliedCert.id;

    // 5. Fiziksel Sonuç Kontrolü 1: SSH ile sunucuda custom-certificates dizininde dosyaların doğrulanması
    const checkCertFiles = runSsh(
      `ls -la /var/lib/yunpanel/control-plane/custom-certificates/${installedCertId}`
    );
    expect(checkCertFiles).toContain('cert.pem');
    expect(checkCertFiles).toContain('fullchain.pem');
    expect(checkCertFiles).toContain('privkey.pem');

    const installedCertContent = runSsh(
      `cat /var/lib/yunpanel/control-plane/custom-certificates/${installedCertId}/cert.pem`
    );
    expect(installedCertContent.trim()).toBe(certMaterial.certificatePem.trim());

    // 6. Fiziksel Sonuç Kontrolü 2: Sunucu genelinde sertifika envanteri API'sinde listelenmesi
    const inventoryRes = await page.request.get('/api/panel/certificates');
    expect(inventoryRes.status()).toBe(200);
    const inventoryJson = await inventoryRes.json();
    const inventoryList = inventoryJson.data || [];
    const foundInInventory = inventoryList.find((c) => c.id === installedCertId);
    expect(foundInInventory).toBeTruthy();
    expect(foundInInventory.source).toBe('custom');
    expect(foundInInventory.state).toBe('active');
    expect(foundInInventory.domains).toContain(primaryDomain);

    // 7. Arayüz Doğrulaması: /websites/:id/ssl ekranında yüklenen sertifikanın görünmesi
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/ssl`);
    await page.waitForLoadState('networkidle').catch(() => {});

    const sslSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'SSL sertifikası' }) });
    await expect(sslSection).toBeVisible({ timeout: 15000 });
    await expect(sslSection.locator('dt', { hasText: 'Sertifika adı' })).toBeVisible({ timeout: 10000 });
    await expect(sslSection.locator('dt', { hasText: 'Kapsam' })).toBeVisible();
    await expect(sslSection.locator('dd', { hasText: primaryDomain }).first()).toBeVisible();
    await expect(sslSection.locator('dt', { hasText: 'HTTPS tercihi' })).toBeVisible();
  });

  test('hatalı girdi: Uyuşmayan özel anahtar ile özel sertifika yükleme 409 ile reddedilir', async ({ page }) => {
    expect(createdDomainId).toBeTruthy();

    // Birinci domain için cert üret, farklı bir domain için başka bir key üret
    const validCert = generateSelfSignedCert(primaryDomain);
    const differentCert = generateSelfSignedCert('different.example.com');

    // Mismatched pair: cert from valid, key from different
    const mismatchRes = await page.request.post(
      `/api/panel/domains/${encodeURIComponent(createdDomainId)}/certificates/custom-preview`,
      {
        headers: apiHeaders(),
        data: {
          certificatePem: validCert.certificatePem,
          chainPem: '',
          privateKeyPem: differentCert.privateKeyPem,
        },
      }
    );
    expect(mismatchRes.status()).toBe(409);
    const errJson = await mismatchRes.json();
    expect(errJson.error?.code).toBe('certificate_private_key_mismatch');
  });

  test('hatalı girdi: Alan adı uyuşmazlığı olan sertifika yükleme 409 ile reddedilir', async ({ page }) => {
    expect(createdDomainId).toBeTruthy();

    // Farklı alan adına ait sertifika ve eşleşen anahtarı
    const wrongDomainCert = generateSelfSignedCert('unrelated.domain.com');

    const domainMismatchRes = await page.request.post(
      `/api/panel/domains/${encodeURIComponent(createdDomainId)}/certificates/custom-preview`,
      {
        headers: apiHeaders(),
        data: {
          certificatePem: wrongDomainCert.certificatePem,
          chainPem: '',
          privateKeyPem: wrongDomainCert.privateKeyPem,
        },
      }
    );
    expect(domainMismatchRes.status()).toBe(409);
    const errJson = await domainMismatchRes.json();
    expect(errJson.error?.code).toBe('certificate_domain_mismatch');
  });

  test('eksik özellik: Plesk SSL/TLS Certificates eşdeğeri CSR oluşturma sihirbazı', async ({ page }) => {
    expect(createdDomainId).toBeTruthy();

    test.fail(
      true,
      'BULGU TLS-03: Panelde Plesk SSL/TLS Certificates eşdeğeri CSR (Certificate Signing Request) oluşturma sihirbazı ve API uç noktası bulunmuyor'
    );

    // Plesk'te Alan Adı -> SSL/TLS Certificates altında "Add SSL/TLS Certificate" -> CSR parametreleri (Domain, Ülke, İl, Şehir, Kurum, E-posta) formu bulunur.
    // YunPanel arayüzünde CSR oluşturma butonu veya modalı aranır
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/ssl`);
    await page.waitForLoadState('networkidle').catch(() => {});

    const csrButton = page.locator('button:has-text("CSR"), a:has-text("CSR"), button:has-text("İstek oluştur")');
    await expect(csrButton).toBeVisible({ timeout: 5000 });

    // API kontrolü: CSR üretme uç noktası
    const csrApiRes = await page.request.post(
      `/api/panel/domains/${encodeURIComponent(createdDomainId)}/certificates/csr`,
      {
        headers: apiHeaders(),
        data: { country: 'TR', city: 'Istanbul', organization: 'YunPanel' },
      }
    );
    expect(csrApiRes.status()).toBe(200);
  });

  test('eksik özellik: Plesk eşdeğeri arayüzden Özel Sertifika ve CA Chain yükleme formu', async ({ page }) => {
    expect(createdDomainId).toBeTruthy();

    test.fail(
      true,
      'BULGU TLS-03: Backend özel sertifika yüklemeyi (custom-preview/custom) desteklemesine rağmen arayüzde (UI) Özel Sertifika, Özel Anahtar ve CA Chain metin/dosya yükleme formu bulunmuyor'
    );

    // Plesk'te "Upload the certificate as text" (Private Key, Certificate, CA Certificate) veya dosya yükleme alanı bulunur.
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/ssl`);
    await page.waitForLoadState('networkidle').catch(() => {});

    const uploadCertForm = page.locator('textarea[name="certificatePem"], input[type="file"][accept*=".crt"], textarea[placeholder*="BEGIN CERTIFICATE"]');
    await expect(uploadCertForm).toBeVisible({ timeout: 5000 });
  });

  test('eksik özellik: Plesk eşdeğeri Alan adı veya Sunucu genelinde Sertifika Deposu ekranı', async ({ page }) => {
    test.fail(
      true,
      'BULGU TLS-03: Panel arayüzünde alan adı veya sunucu genelinde sertifikaların topluca listelendiği ve yönetildiği Plesk eşdeğeri Sertifika Deposu (Repository/Inventory) ekranı bulunmuyor'
    );

    // Plesk'te sunucu genelinde veya alan adı altında sertifikaların listelendiği "Sertifika Deposu" (Certificate Repository) sayfası bulunur.
    // YunPanel'de /ssl bağımsız bir sertifika deposu tablosu sunmaz; yalnızca "Yönetmek istediğiniz web sitesini seçin" diyerek site seçtirir.
    await page.goto('/ssl');
    await page.waitForLoadState('networkidle').catch(() => {});

    // Gerçek bir sertifika envanteri tablosunda (Geçerlilik, Veren Kuruluş / Issuer, Parmak İzi sütunları aranır)
    const certRepoHeader = page.locator('th:has-text("Geçerlilik"), th:has-text("Veren"), th:has-text("Issuer"), th:has-text("Parmak İzi")');
    await expect(certRepoHeader).toBeVisible({ timeout: 5000 });
  });
});
