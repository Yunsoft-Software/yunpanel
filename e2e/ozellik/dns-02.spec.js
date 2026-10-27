import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('DNS-02 TTL, SOA, zone şablonu ve şablon değişimini uygulama', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '1';
  const prefix = `tdns02-a${agentN}-${Date.now().toString(36)}`;
  let domainId = null;

  function runSsh(command) {
    return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
      encoding: 'utf8',
      timeout: 30000,
    });
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

  test.afterAll(async () => {
    // Test sırasında eklenen test kayıtlarını fiziksel PowerDNS üzerinden temizle
    try {
      runSsh(`pdnsutil delete-rrset webrich.news ${prefix}-ttl TXT 2>/dev/null || true`);
      runSsh(`pdnsutil delete-rrset webrich.news ${prefix}-err A 2>/dev/null || true`);
    } catch {
      // Temizlik hatası göz ardı edilebilir
    }
  });

  test('mutlu yol: Özel TTL değeri tanımlama, güncelleme ve yerel PowerDNS üzerinden TTL fiziksel doğrulaması', async ({ page }) => {
    // 1. Domain tespit et ve webrich.news DNS sekmesine git
    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.status()).toBe(200);
    const domainsJson = await domainsRes.json();
    const domainList = domainsJson.data?.domains || domainsJson.data || [];
    const mainDomain = domainList.find((d) => d.primaryDomain === 'webrich.news' && !d.parentDomainId)
      || domainList.find((d) => !d.parentDomainId)
      || domainList[0];
    expect(mainDomain).toBeTruthy();
    domainId = mainDomain.id;

    await page.goto(`/websites/${encodeURIComponent(domainId)}/overview`);
    const dnsTab = page.locator('nav[aria-label="Site araçları"] a:has-text("DNS"), a[href$="/dns"]').first();
    await expect(dnsTab).toBeVisible({ timeout: 15000 });
    await dnsTab.click();

    const zoneSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Authoritative DNS zone' }) });
    await expect(zoneSection).toBeVisible({ timeout: 15000 });

    // 2. Özel TTL ile (7200 saniye) yeni TXT kaydı ekle
    const addBtn = page.locator('button:has-text("Manual kayıt ekle")');
    await expect(addBtn).toBeVisible({ timeout: 10000 });
    await addBtn.click();

    const recordDialog = page.locator('.ws-modal', { hasText: 'Manual DNS kaydı ekle' });
    await expect(recordDialog).toBeVisible({ timeout: 5000 });

    await recordDialog.locator('input[placeholder*="@ veya api"]').fill(`${prefix}-ttl`);

    // TTL alanına özel 7200 değerini yaz
    const ttlInput = recordDialog.locator('label:has-text("TTL (saniye)") input');
    await expect(ttlInput).toBeVisible();
    await ttlInput.fill('7200');

    // TXT türünü seç
    const txtBtn = recordDialog.locator('.dns-type-grid button', { hasText: 'TXT' });
    await txtBtn.click();

    // Değeri gir ve kaydet
    await recordDialog.locator('textarea').fill('custom ttl 7200 test');
    const saveBtn = recordDialog.locator('button:has-text("Kaydı ekle")');
    await saveBtn.click();

    await expect(recordDialog).toBeHidden({ timeout: 15000 });

    // 3. Tabloda özel TTL değerinin (7200) göründüğünü doğrula
    const recordRow = zoneSection.locator('table.dns-table tbody tr').filter({ hasText: `${prefix}-ttl` });
    await expect(recordRow).toBeVisible({ timeout: 15000 });
    await expect(recordRow.locator('td').nth(1)).toContainText('TXT');
    await expect(recordRow.locator('td').nth(2)).toContainText('7200');

    // 4. Fiziksel PowerDNS doğrulaması: SSH ile dig sorgusu yaparak yanıt TTL değerini ölç
    const digInitial = runSsh(`dig @127.0.0.1 ${prefix}-ttl.webrich.news TXT +noall +answer`);
    expect(digInitial).toContain('7200');
    expect(digInitial).toContain('custom ttl 7200 test');

    // 5. Kaydı düzenle: TTL değerini 1800 yap
    const editBtn = recordRow.locator('button:has-text("Düzenle")');
    await expect(editBtn).toBeVisible();
    await editBtn.click();

    const editDialog = page.locator('.ws-modal', { hasText: 'Manual DNS kaydını düzenle' });
    await expect(editDialog).toBeVisible({ timeout: 5000 });

    const editTtlInput = editDialog.locator('label:has-text("TTL (saniye)") input');
    await editTtlInput.fill('1800');
    await editDialog.locator('textarea').fill('updated ttl 1800 test');

    const updateBtn = editDialog.locator('button:has-text("Kaydı güncelle")');
    await updateBtn.click();
    await expect(editDialog).toBeHidden({ timeout: 15000 });

    // Tabloda güncellenen TTL 1800 değerini doğrula
    await expect(recordRow.locator('td').nth(2)).toContainText('1800');

    // Fiziksel PowerDNS doğrulaması: TTL artık 1800 olmalı
    const digUpdated = runSsh(`dig @127.0.0.1 ${prefix}-ttl.webrich.news TXT +noall +answer`);
    expect(digUpdated).toContain('1800');
    expect(digUpdated).toContain('updated ttl 1800 test');

    // 6. Temizlik: Kaydı UI üzerinden sil
    const deleteBtn = recordRow.locator('button:has-text("Sil")');
    await expect(deleteBtn).toBeVisible();
    await deleteBtn.click();

    const confirmModal = page.locator('.ws-modal', { hasText: 'Manual DNS kaydını sil' });
    await expect(confirmModal).toBeVisible({ timeout: 5000 });
    const confirmCode = await confirmModal.locator('label strong').textContent();
    expect(confirmCode).toContain('delete-dns:');

    await confirmModal.locator('label input').fill(confirmCode.trim());
    const confirmDeleteBtn = confirmModal.locator('button:has-text("Kaydı sil")');
    await expect(confirmDeleteBtn).toBeEnabled();
    await confirmDeleteBtn.click();
    await expect(confirmModal).toBeHidden({ timeout: 15000 });

    await expect(recordRow).toBeHidden({ timeout: 15000 });

    // Fiziksel doğrulama: Kayıt PowerDNS'ten silindi
    const digDeleted = runSsh(`dig @127.0.0.1 ${prefix}-ttl.webrich.news TXT +noall +answer`);
    expect(digDeleted.trim()).toBe('');
  });

  test('mutlu yol: Sunucu SOA politikası ayarlarını (Primary NS, Hostmaster, Refresh, Retry, Expire, Min TTL) görüntüleme ve zone template diff doğrulaması', async ({ page }) => {
    // 1. Ayarlar -> DNS ve SSL sayfasına git
    await page.goto('/settings?section=dns');

    const dnsSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Network / Authoritative DNS' }) });
    await expect(dnsSection).toBeVisible({ timeout: 15000 });

    // 2. Temel kimlik ve SOA alanlarının ekranda görüntülendiğini doğrula
    await expect(dnsSection.locator('dt:has-text("Sunucu hostname")')).toBeVisible();
    await expect(dnsSection.locator('dt:has-text("ns1")')).toBeVisible();
    await expect(dnsSection.locator('dt:has-text("ns2")')).toBeVisible();
    await expect(dnsSection.locator('dt:has-text("SOA responsible name")')).toBeVisible();

    const rnameText = await dnsSection.locator('dd').filter({ hasText: 'cryptoraichu.website' }).first().textContent();
    expect(rnameText).toBeTruthy();

    // 3. "DNS kimliğini düzenle" modalını aç ve SOA politikası girdilerini doğrula
    const editIdentityBtn = dnsSection.locator('button:has-text("DNS kimliğini düzenle")');
    await expect(editIdentityBtn).toBeVisible();
    await editIdentityBtn.click();

    const identityModal = page.locator('.ws-modal', { hasText: 'Authoritative DNS kimliği' });
    await expect(identityModal).toBeVisible({ timeout: 5000 });

    // Form üzerindeki SOA alanlarını kontrol et
    await expect(identityModal.locator('h3:has-text("SOA politikası")')).toBeVisible();
    const rnameInput = identityModal.locator('label:has-text("Responsible name") input');
    await expect(rnameInput).toBeVisible();
    expect(await rnameInput.inputValue()).toBeTruthy();

    const soaTtlInput = identityModal.locator('label:has-text("TTL") input');
    await expect(soaTtlInput).toBeVisible();
    expect(Number(await soaTtlInput.inputValue())).toBeGreaterThanOrEqual(60);

    const refreshInput = identityModal.locator('label:has-text("Refresh") input');
    await expect(refreshInput).toBeVisible();
    expect(Number(await refreshInput.inputValue())).toBeGreaterThanOrEqual(300);

    const retryInput = identityModal.locator('label:has-text("Retry") input');
    await expect(retryInput).toBeVisible();
    expect(Number(await retryInput.inputValue())).toBeGreaterThanOrEqual(60);

    const expireInput = identityModal.locator('label:has-text("Expire") input');
    await expect(expireInput).toBeVisible();
    expect(Number(await expireInput.inputValue())).toBeGreaterThanOrEqual(86400);

    const minimumInput = identityModal.locator('label:has-text("Negative minimum") input');
    await expect(minimumInput).toBeVisible();
    expect(Number(await minimumInput.inputValue())).toBeGreaterThanOrEqual(60);

    // Modalı değişiklik yapmadan kapat
    const cancelBtn = identityModal.locator('button:has-text("Vazgeç")');
    await cancelBtn.click();
    await expect(identityModal).toBeHidden({ timeout: 5000 });

    // 4. Fiziksel SOA kaydı doğrulaması: SSH ile dig sorgusu
    const soaOutput = runSsh('dig @127.0.0.1 webrich.news SOA +short');
    const soaParts = soaOutput.trim().split(/\s+/);
    expect(soaParts.length).toBe(7);
    const [primaryNs, mailbox, serial, refresh, retry, expire, minimum] = soaParts;

    expect(primaryNs).toContain('ns1.');
    expect(mailbox).toContain('hostmaster.');
    expect(Number(serial)).toBeGreaterThan(0);
    expect(Number(refresh)).toBeGreaterThanOrEqual(300);
    expect(Number(retry)).toBeGreaterThanOrEqual(60);
    expect(Number(expire)).toBeGreaterThan(Number(refresh));
    expect(Number(minimum)).toBeGreaterThanOrEqual(60);

    // 5. webrich.news sitesine gidip "Zone Template senkronizasyonu" diff durumunu incele
    if (!domainId) {
      const domainsRes = await page.request.get('/api/panel/domains');
      const domainsJson = await domainsRes.json();
      const domainList = domainsJson.data?.domains || domainsJson.data || [];
      const mainDomain = domainList.find((d) => d.primaryDomain === 'webrich.news' && !d.parentDomainId) || domainList[0];
      domainId = mainDomain.id;
    }
    await page.goto(`/websites/${encodeURIComponent(domainId)}/dns`);

    const reapplySection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Zone Template senkronizasyonu' }) });
    await expect(reapplySection).toBeVisible({ timeout: 15000 });

    const refreshDiffBtn = reapplySection.locator('button:has-text("Diff’i yenile")');
    await expect(refreshDiffBtn).toBeVisible();
    await refreshDiffBtn.click();

    await expect(reapplySection.locator('dt:has-text("Template sürümü")')).toBeVisible({ timeout: 10000 });
    await expect(reapplySection.locator('dt:has-text("DNS identity revision")')).toBeVisible({ timeout: 10000 });
    await expect(reapplySection.locator('dt:has-text("Mevcut SOA serial")')).toBeVisible({ timeout: 10000 });
  });

  test('hatalı girdi: Geçersiz TTL ve geçersiz SOA parametreleri reddedilir', async ({ page }) => {
    // 1. Geçersiz TTL girdi kontrolü (min 60 sınırı)
    if (!domainId) {
      const domainsRes = await page.request.get('/api/panel/domains');
      const domainsJson = await domainsRes.json();
      const domainList = domainsJson.data?.domains || domainsJson.data || [];
      const mainDomain = domainList.find((d) => d.primaryDomain === 'webrich.news' && !d.parentDomainId) || domainList[0];
      domainId = mainDomain.id;
    }
    await page.goto(`/websites/${encodeURIComponent(domainId)}/dns`);

    const addBtn = page.locator('button:has-text("Manual kayıt ekle")');
    await expect(addBtn).toBeVisible({ timeout: 15000 });
    await addBtn.click();

    const recordDialog = page.locator('.ws-modal', { hasText: 'Manual DNS kaydı ekle' });
    await expect(recordDialog).toBeVisible({ timeout: 5000 });

    const ttlInput = recordDialog.locator('label:has-text("TTL (saniye)") input');
    await ttlInput.fill('30'); // 60'tan küçük, HTML min="60"

    const isInvalid = await ttlInput.evaluate((el) => !el.checkValidity());
    expect(isInvalid).toBe(true);

    const cancelRecordBtn = recordDialog.locator('button:has-text("Vazgeç")');
    await cancelRecordBtn.click();
    await expect(recordDialog).toBeHidden({ timeout: 5000 });

    // 2. Geçersiz SOA politikası kontrolü: Expire <= Refresh DNS RFC kural ihlali
    await page.goto('/settings?section=dns');
    const dnsSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Network / Authoritative DNS' }) });
    await expect(dnsSection).toBeVisible({ timeout: 15000 });

    const editIdentityBtn = dnsSection.locator('button:has-text("DNS kimliğini düzenle")');
    await expect(editIdentityBtn).toBeVisible();
    await editIdentityBtn.click();

    const identityModal = page.locator('.ws-modal', { hasText: 'Authoritative DNS kimliği' });
    await expect(identityModal).toBeVisible({ timeout: 5000 });

    // Refresh değerini expire'dan büyük yap veya HTML sınırını zorla
    // expire min 86400, refresh 300-86400
    // Refresh'i 86400 yap, Expire'ı 86400 yap (expire > refresh kuralı ihlal edilir)
    const refreshInput = identityModal.locator('label:has-text("Refresh") input');
    const expireInput = identityModal.locator('label:has-text("Expire") input');

    await refreshInput.fill('86400');
    await expireInput.fill('86400'); // expire Refresh'ten büyük olmalı

    const previewBtn = identityModal.locator('button:has-text("Değişikliği önizle")');
    await previewBtn.click();

    // Hata mesajının gösterildiğini doğrula
    const errorNotice = identityModal.locator('.ws-error, .ws-notice-danger, [role="alert"]');
    await expect(errorNotice).toBeVisible({ timeout: 10000 });
    await expect(errorNotice).toContainText('SOA expire must be greater than refresh');

    // Modalı temiz kapat
    const cancelModalBtn = identityModal.locator('button:has-text("Vazgeç")');
    await cancelModalBtn.click();
    await expect(identityModal).toBeHidden({ timeout: 5000 });
  });

  test('Plesk eşdeğerliği: Panel arayüzünde Genel DNS Zone Şablonu (DNS Zone Template) kayıt yönetim arayüzü bulunmamaktadır', async ({ page }) => {
    test.fail(
      true,
      'BULGU DNS-02-A: Panel arayüzünde (Araçlar ve Ayarlar / Ayarlar) Plesk eşdeğeri Genel DNS Zone Şablonu (DNS Zone Template) kayıt yönetim arayüzü bulunmamaktadır; şablon yönetimi yalnızca arka uç API (/api/servers/:serverId/dns/template) ile sınırlıdır.',
    );

    // Plesk'te "Araçlar ve Ayarlar" altında "DNS Şablonu" (DNS Zone Template) yer alır.
    // Yönetici bu ekranda varsayılan zone kayıtlarını (A, CNAME, MX, TXT vb.) ekler, düzenler veya siler.
    await page.goto('/tools-settings');
    await page.waitForLoadState('networkidle').catch(() => {});

    const dnsTemplateLink = page.locator('a:has-text("DNS Şablonu"), a:has-text("DNS Zone Template")');
    await expect(dnsTemplateLink).toBeVisible({ timeout: 5000 });
  });

  test('Plesk eşdeğerliği: Şablon değişikliklerini tüm mevcut alan adlarının zone\'larına topluca uygulama (Apply DNS Template Changes) özelliği bulunmamaktadır', async ({ page }) => {
    test.fail(
      true,
      'BULGU DNS-02-B: Plesk eşdeğeri DNS Şablon değişikliklerinin tüm mevcut alan adlarının zone\'larına topluca uygulanması (Bulk Apply DNS Template Changes) arayüzde bulunmamaktadır; her alan adı için ayrı ayrı Reapply gerekmektedir.',
    );

    // Plesk'te DNS Şablonu üzerinde yapılan değişiklikler "Şablon Değişikliklerini Uygula" (Apply DNS Template Changes)
    // butonu ile sunucudaki tüm mevcut alan adlarının zone'larına tek tıkla senkronize edilebilir.
    // YunPanel'de ise bu özellik kasıtlı olarak yalnızca domain bazında tekil Reapply olarak tasarlanmıştır.
    await page.goto('/settings?section=dns');
    await page.waitForLoadState('networkidle').catch(() => {});

    const bulkApplyBtn = page.locator('button:has-text("Şablon Değişikliklerini Topluca Uygula"), button:has-text("Apply DNS Template Changes")');
    await expect(bulkApplyBtn).toBeVisible({ timeout: 5000 });
  });
});
