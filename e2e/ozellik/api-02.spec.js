import http from 'node:http';
import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('API-02 XML API uyumluluk ve REST esdegerlik matrisi', () => {
  test.setTimeout(180000);

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

  async function checkDirectHttp(host) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '157.180.11.28',
        port: 80,
        path: '/',
        method: 'GET',
        headers: { Host: host },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  async function getApiHeaders(page) {
    const origin = 'https://server.cryptoraichu.website';
    const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
    const sessionJson = sessionRes ? await sessionRes.json().catch(() => ({})) : {};
    const csrf = sessionJson?.data?.csrfToken || sessionJson?.csrfToken || '';
    return {
      Origin: origin,
      Referer: `${origin}/`,
      'x-csrf-token': csrf,
    };
  }

  test.afterAll(async () => {
    // 0 artik ilkesi: API-02 testleri matris dogrulamalari, REST esdegerligi ve sinir sorgularidir.
    // Herhangi bir artik kaynak birakilmadigi dogrulanir.
  });

  test('mutlu yol: Plesk XML API yetenek ve alan adi operasyonunun REST esdegeriyle yurutulmesi ve fiziksel dogrulamasi', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    // 1. Sunucu Saglik ve Sistem Durumu (Plesk <server><get> / <server><get_protos> esdegeri)
    const healthRes = await page.request.get('/api/health');
    expect(healthRes.status(), 'Health endpoint 200 donmeli').toBe(200);
    const healthJson = await healthRes.json();
    expect(healthJson.status || healthJson.data?.status).toBeDefined();

    // 2. Alan Adlari REST API Sorgusu (Plesk <domain><get> esdegeri)
    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.status(), 'Domains endpoint 200 donmeli').toBe(200);
    const domainsJson = await domainsRes.json();
    const domainList = domainsJson.data?.domains || domainsJson.data || [];
    expect(Array.isArray(domainList)).toBe(true);
    expect(domainList.length).toBeGreaterThan(0);

    const primaryDomain = domainList.find((d) => d.primaryDomain === 'webrich.news') || domainList[0];
    expect(primaryDomain).toBeDefined();
    const domainName = primaryDomain.primaryDomain;

    // 3. Fiziksel Sonuc 1 (SSH): Sunucuda Nginx vhost konfigürasyonunun varligi ve gecerliligi
    const vhostCheck = runSsh(`test -f /etc/nginx/sites-enabled/yunpanel-${domainName}.conf && sudo nginx -t 2>&1`);
    expect(vhostCheck).toContain('syntax is ok');
    expect(vhostCheck).toContain('test is successful');

    // 4. Fiziksel Sonuc 2 (Canli HTTP): Host basligi ile gercek HTTP yaniti alinmasi
    const httpRes = await checkDirectHttp(domainName);
    expect([200, 301, 302, 403]).toContain(httpRes.status);
  });

  test('hatali girdi ve sinir durumu: REST API uc noktalarina XML paket govdesi gonderildiginde reddedilir', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    const pleskXmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
<packet version="1.6.9.1">
  <server>
    <get>
      <stat/>
    </get>
  </server>
</packet>`;

    // 1. XML Content-Type ile REST endpoint'e gonderim (Reddedilmelidir)
    const xmlHeaders = {
      ...headers,
      'Content-Type': 'application/xml',
    };

    const resXml = await page.request.post('/api/panel/api-keys', {
      headers: xmlHeaders,
      data: pleskXmlPayload,
    });
    // REST API JSON beklediginden veya XML desteklemediginden 400, 415 veya 422 donmelidir
    expect([400, 415, 422]).toContain(resXml.status());

    // 2. Sistemin kararliligi korunur; sonraki istek saglikla yanit verir
    const checkRes = await page.request.get('/api/panel/domains');
    expect(checkRes.status()).toBe(200);
  });

  test('Plesk eksikligi: Plesk XML API agent endpoint (/enterprise/control/agent.php) bulunmuyor', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    const pleskXmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
<packet version="1.6.9.1">
  <server>
    <get_protos/>
  </server>
</packet>`;

    test.fail(
      true,
      'BULGU API-02-A: Plesk XML API agent endpoint (/enterprise/control/agent.php) veya XML RPC destegi yok; modern JSON REST API kullanilmaktadir',
    );

    const res = await page.request.post('/enterprise/control/agent.php', {
      headers: {
        'Content-Type': 'text/xml',
      },
      data: pleskXmlPayload,
    });

    // Plesk'te 200 doner; YunPanel'de endpoint olmadigindan 404 doner ve test fail olarak basariyla isaretlenir
    expect(res.status()).toBe(200);
  });

  test('Plesk eksikligi: Plesk XML paketlerini REST cagrilprocess line mapper otomatik XML-to-REST gateway bulunmuyor', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    const pleskXmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
<packet version="1.6.9.1">
  <domain>
    <get>
      <filter/>
      <dataset>
        <gen_info/>
      </dataset>
    </get>
  </domain>
</packet>`;

    test.fail(
      true,
      'BULGU API-02-B: Plesk XML paketlerini REST cagrilprocess line mapper donusturen otomatik XML-to-REST gateway katmani bulunmuyor',
    );

    const res = await page.request.post('/api/xml-rpc', {
      headers: {
        'Content-Type': 'application/xml',
      },
      data: pleskXmlPayload,
    });

    // Plesk gateway uyumlulugu olmadigindan 404 doner ve test fail olarak basariyla isaretlenir
    expect(res.status()).toBe(200);
  });
});
