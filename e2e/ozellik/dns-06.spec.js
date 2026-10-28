import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('DNS-06 Harici sağlayıcı entegrasyonları ve kayıt yayılım tanılaması', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  let mainDomainId = null;
  let linkedDnsZoneId = null;
  let csrfToken = '';
  const targetDomainName = 'webrich.news';

  async function refreshCsrf(page) {
    const res = await page.request.get('/api/auth/session').catch(() => null);
    if (res && res.status() === 200) {
      const json = await res.json().catch(() => null);
      csrfToken = json?.data?.csrfToken || json?.csrfToken || '';
    }
  }

  function apiHeaders(origin = 'https://server.cryptoraichu.website') {
    return {
      'x-csrf-token': csrfToken,
      Origin: origin,
      Referer: `${origin}/`,
    };
  }

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
        await refreshCsrf(page);
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

  test.afterAll(async ({ request }) => {
    // 0 artık ilkesi: provider credential oluşturulmuşsa temizle
    if (linkedDnsZoneId) {
      try {
        await request.delete(`/api/panel/dns-zones/${encodeURIComponent(linkedDnsZoneId)}/provider-credential`, {
          headers: apiHeaders(),
          data: { confirmation: `delete-dns-provider:${linkedDnsZoneId}` },
        });
      } catch {}
    }
  });

  test('mutlu yol: DNS gereksinimleri, yayılım durumu API denetimi ve fiziksel dig trace / NS tanılama doğrulaması', async ({ page }) => {
    // 1. webrich.news domain ID'sini tespit et
    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.status()).toBe(200);
    const domainsJson = await domainsRes.json();
    const domainList = domainsJson.data?.domains || domainsJson.data || [];
    const mainDomain = domainList.find((d) => d.primaryDomain === targetDomainName && !d.parentDomainId)
      || domainList.find((d) => !d.parentDomainId);
    expect(mainDomain).toBeTruthy();
    mainDomainId = mainDomain.id;

    // 2. Domain DNS gereksinimleri ve yayılım durumu uç noktasını çağır
    const reqRes = await page.request.get(`/api/panel/domains/${encodeURIComponent(mainDomainId)}/dns-requirements`);
    expect(reqRes.status()).toBe(200);
    const reqJson = await reqRes.json();
    expect(reqJson.data).toBeTruthy();
    expect(reqJson.data.zoneName).toBe(mainDomain.primaryDomain);
    expect(reqJson.data.summary).toBeTruthy();
    expect(Number.isInteger(reqJson.data.summary.total)).toBe(true);
    expect(Number.isInteger(reqJson.data.summary.fulfilled)).toBe(true);
    expect(Number.isInteger(reqJson.data.summary.pending)).toBe(true);
    expect(Array.isArray(reqJson.data.requirements)).toBe(true);
    expect(reqJson.data.requirements.length).toBeGreaterThan(0);

    // Temel Apex A ve mail/alias gereksinimlerinin yayılım durumunu doğrula
    const apexRequirement = reqJson.data.requirements.find((r) => r.key === 'web-apex-a');
    expect(apexRequirement).toBeTruthy();
    expect(apexRequirement.record.type).toBe('A');
    expect(apexRequirement.record.name).toBe(mainDomain.primaryDomain);
    expect(['fulfilled', 'pending']).toContain(apexRequirement.status);

    // 3. Varsa bağlı DNS zone için zone-requirements kontrol et
    const zonesRes = await page.request.get('/api/panel/dns-zones');
    if (zonesRes.status() === 200) {
      const zonesJson = await zonesRes.json();
      const zones = zonesJson.data || [];
      const matchedZone = zones.find((z) => z.zoneName === mainDomain.primaryDomain || z.webDomainId === mainDomainId);
      if (matchedZone) {
        linkedDnsZoneId = matchedZone.id;
        const zoneReqRes = await page.request.get(`/api/panel/dns-zones/${encodeURIComponent(linkedDnsZoneId)}/requirements`);
        expect(zoneReqRes.status()).toBe(200);
        const zoneReqJson = await zoneReqRes.json();
        expect(zoneReqJson.data.dnsZoneId).toBe(linkedDnsZoneId);
        expect(zoneReqJson.data.zoneName).toBe(matchedZone.zoneName);
        expect(Array.isArray(zoneReqJson.data.requirements)).toBe(true);
      }
    }

    // 4. Fiziksel test sunucusunda dig / host ve DNS trace tanılaması çalıştır
    const localDigOutput = runSsh(`dig @127.0.0.1 ${targetDomainName} SOA +short`);
    expect(typeof localDigOutput).toBe('string');

    // dig +trace ile root sunuculardan başlayarak NS ve SOA yayılım zincirini fiziksel olarak tanıla
    const traceOutput = runSsh(`dig ${targetDomainName} SOA +trace +nodnssec | head -n 30`);
    expect(typeof traceOutput).toBe('string');
    expect(traceOutput).toMatch(/root-servers\.net|webrich\.news|SOA|NS/i);

    // Sunucu üzerindeki resolv.conf ve DNS yapılandırmasını doğrula
    const resolvOutput = runSsh('cat /etc/resolv.conf');
    expect(resolvOutput).toMatch(/nameserver/i);
  });

  test('hatalı girdi: desteklenmeyen harici sağlayıcı (AWS Route53 / DigitalOcean) ve geçersiz onay reddedilir', async ({ page }) => {
    // 1. webrich.news domain ID ve zone'unu al
    if (!mainDomainId) {
      const domainsRes = await page.request.get('/api/panel/domains');
      const domainsJson = await domainsRes.json();
      const domainList = domainsJson.data?.domains || domainsJson.data || [];
      const mainDomain = domainList.find((d) => d.primaryDomain === targetDomainName && !d.parentDomainId)
        || domainList.find((d) => !d.parentDomainId);
      mainDomainId = mainDomain.id;
    }

    const zonesRes = await page.request.get('/api/panel/dns-zones');
    const zonesJson = await zonesRes.json();
    const zones = zonesJson.data || [];
    let testZoneId = linkedDnsZoneId || zones[0]?.id;

    if (!testZoneId) {
      // Test zone yoksa webrich.news için external dns-zone oluştur
      const createRes = await page.request.post('/api/panel/dns-zones', {
        headers: apiHeaders(),
        data: {
          name: targetDomainName,
          webDomainId: mainDomainId,
          managementMode: 'external',
        },
      });
      if (createRes.status() === 201) {
        const createJson = await createRes.json();
        testZoneId = createJson.data.id;
        linkedDnsZoneId = testZoneId;
      }
    }

    expect(testZoneId).toBeTruthy();

    // 2. Desteklenmeyen harici sağlayıcı (route53 / digitalocean) PUT isteği
    const unsupportedRes = await page.request.put(`/api/panel/dns-zones/${encodeURIComponent(testZoneId)}/provider-credential`, {
      headers: apiHeaders(),
      data: {
        provider: 'aws-route53',
        token: 'test-secret-token-key-12345678901234567890',
        confirmation: `configure-dns-provider:${testZoneId}:aws-route53`,
      },
    });
    // Desteklenmeyen sağlayıcı 409 (dns_provider_unsupported) ile reddedilmeli
    expect(unsupportedRes.status()).toBe(409);
    const unsupportedJson = await unsupportedRes.json();
    expect(unsupportedJson.error.code).toBe('dns_provider_unsupported');

    // 3. Geçersiz onay (confirmation) ile Cloudflare isteği
    const badConfirmRes = await page.request.put(`/api/panel/dns-zones/${encodeURIComponent(testZoneId)}/provider-credential`, {
      headers: apiHeaders(),
      data: {
        provider: 'cloudflare',
        token: 'x'.repeat(40),
        confirmation: 'invalid-confirmation-string',
      },
    });
    expect(badConfirmRes.status()).toBe(400);
    const badConfirmJson = await badConfirmRes.json();
    expect(badConfirmJson.error.code).toBe('dns_provider_credential_confirmation_required');

    // 4. Olmayan DNS zone ID için provider credential sorgusu 404 dönmeli
    const fakeZoneRes = await page.request.get('/api/panel/dns-zones/00000000-0000-0000-0000-000000000000/provider-credential');
    expect(fakeZoneRes.status()).toBe(404);
  });

  test('eksik özellik: panel arayüzünde harici DNS sağlayıcı (Cloudflare / AWS Route53 / DigitalOcean) yönetim kartının eksikliği', async ({ page }) => {
    test.fail(true, 'BULGU DNS-06: Panel arayüzünde harici DNS sağlayıcı (Cloudflare, AWS Route53, DigitalOcean) entegrasyonu ve senkronizasyon arayüzü bulunmuyor; backend yalnızca Cloudflare destekliyor ve UI bileşeni yok.');

    // webrich.news DNS sekmesine git
    await page.goto(`/websites/${encodeURIComponent(mainDomainId)}/overview`);
    const dnsTab = page.locator('nav[aria-label="Site araçları"] a:has-text("DNS"), a[href$="/dns"]').first();
    await expect(dnsTab).toBeVisible({ timeout: 15000 });
    await dnsTab.click();

    // Arayüzde Harici DNS Sağlayıcı / Cloudflare / Route53 / DigitalOcean kartı aranır
    const providerSection = page.locator('section').filter({
      has: page.locator('h2, h3', { hasText: /Harici DNS|DNS Sağlayıcı|Cloudflare DNS|Amazon Route 53|DigitalOcean DNS/i }),
    });

    // Plesk feature parity eşdeğerliği gereği bu kartın görünür olması beklenir (ancak henüz panelde mevcut değildir)
    await expect(providerSection).toBeVisible({ timeout: 5000 });
  });

  test('eksik özellik: panel arayüzünde DNS kayıt yayılım tanılaması (Propagation Check / dig trace / Health tools) eksikliği', async ({ page }) => {
    test.fail(true, 'BULGU DNS-06: DNS sekmesinde DNS kayıt yayılım tanılaması (propagation check, NS lookup, dig +trace aracı) görsel arayüzü bulunmuyor.');

    // webrich.news DNS sekmesine git
    await page.goto(`/websites/${encodeURIComponent(mainDomainId)}/overview`);
    const dnsTab = page.locator('nav[aria-label="Site araçları"] a:has-text("DNS"), a[href$="/dns"]').first();
    await expect(dnsTab).toBeVisible({ timeout: 15000 });
    await dnsTab.click();

    // Arayüzde DNS Yayılım Kontrolü / Propagation Check / dig +trace tanı butonları aranır
    const diagSection = page.locator('section, button, a').filter({
      hasText: /Kayıt Yayılım Tanılaması|DNS Propagation|dig \+trace|DNS Sağlık Denetimi/i,
    });

    // Plesk feature parity eşdeğerliği gereği bu tanılama aracının bulunması beklenir (ancak henüz arayüzde yoktur)
    await expect(diagSection.first()).toBeVisible({ timeout: 5000 });
  });
});
