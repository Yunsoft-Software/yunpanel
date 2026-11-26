import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createCrowdsecManager } from '@yunpanel/host-runtime';
import { createAuthenticatedApi } from '../../api/src/auth/auth-http.js';
import { createAuthStore } from '../../api/src/auth/auth-store.js';
import { createApp } from '../../api/src/http/management-app.js';
import { createFirewallService } from '../../api/src/runtime/firewall-service.js';
import { createServerRegistry } from '../../api/src/runtime/server-registry.js';
import { createPanelServer } from '../server.js';
import { isFirewallStatusVerified } from '../src/workspace/firewall-model.js';

const WEB_DIST_ROOT = path.resolve(fileURLToPath(new URL('../dist', import.meta.url)));

async function pickFreePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function closeHttpServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

test('Real Playwright Chromium + Panel Gateway + Real FirewallService (Zero Mocks): gateway routing, partial CrowdSec failure, real TCP scan, real 502 outage, and strict status-gated locking', async (t) => {
  await stat(path.join(WEB_DIST_ROOT, 'index.html'));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-fw-browser-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const store = createAuthStore({ filePath: path.join(dir, 'auth.sqlite') });
  t.after(() => store.close());
  const password = randomBytes(24).toString('base64url');
  await store.completeSetup({
    setupToken: store.issueSetupToken().token,
    username: 'owner',
    password,
  });

  const registry = createServerRegistry({ filePath: path.join(dir, 'servers.json') });
  await registry.init();
  const local = await registry.createLocalServer({ hostname: 'firewall-browser.example.test' });

  // Real bound 127.0.0.1 TCP listener for real end-to-end port scan verification
  const tcpListener = net.createServer((socket) => socket.end());
  tcpListener.listen(0, '127.0.0.1');
  await once(tcpListener, 'listening');
  const tcpListenerPort = tcpListener.address().port;
  t.after(() => new Promise((resolve) => (tcpListener.listening ? tcpListener.close(resolve) : resolve())));

  // Real default FirewallService + real CrowdsecManager pointing to a real nonexistent cscli binary path (zero mocks!)
  const missingCscliPath = path.join(dir, 'nonexistent-cscli-secret-marker');
  const firewallService = createFirewallService({
    crowdsecManager: createCrowdsecManager({ cscliPath: missingCscliPath }),
    localServerId: local.id,
  });

  const proxyToken = 'f'.repeat(43);
  const apiPort = await pickFreePort();
  const webPort = await pickFreePort();
  const origin = `http://127.0.0.1:${webPort}`;

  const authApiHandler = createAuthenticatedApi({
    store,
    publicOrigin: origin,
    development: true,
    ownerMfaRequired: false,
    proxyToken,
    createHandler: () => createApp({
      registry,
      localServerId: local.id,
      firewallService,
    }),
  });

  let apiServer = null;
  async function startApiServer() {
    apiServer = http.createServer(authApiHandler);
    apiServer.listen(apiPort, '127.0.0.1');
    await once(apiServer, 'listening');
  }
  async function stopApiServer() {
    const current = apiServer;
    apiServer = null;
    await closeHttpServer(current);
  }
  await startApiServer();
  t.after(() => stopApiServer());

  const panelServer = createPanelServer({
    allowedClientIps: '127.0.0.1',
    apiHost: '127.0.0.1',
    apiPort,
    proxyToken,
    publicOrigin: origin,
    webRoot: WEB_DIST_ROOT,
  });
  panelServer.listen(webPort, '127.0.0.1');
  await once(panelServer, 'listening');
  t.after(() => closeHttpServer(panelServer));

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();

  const firewallResponses = [];
  let lastStatusPayload = null;
  page.on('response', (response) => {
    const pathname = new URL(response.url()).pathname;
    if (pathname.includes('/firewall')) {
      firewallResponses.push({ pathname, status: response.status(), method: response.request().method() });
      if (pathname === '/api/panel/firewall/status' && response.status() === 200) {
        response.json().then((body) => {
          lastStatusPayload = body?.data ?? null;
        }).catch(() => {});
      }
    }
  });

  // 1. Real Owner login through the UI -> /firewall
  await page.goto(`${origin}/firewall`);
  await page.locator('input[name="username"]').fill('owner');
  await page.locator('input[name="password"]').fill(password);
  const initialStatusResponsePromise = page.waitForResponse(
    (res) => new URL(res.url()).pathname === '/api/panel/firewall/status',
  );
  await page.getByRole('button', { name: 'Giriş yap', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Güvenlik Duvarı ve Port Yönetimi' })).toBeVisible();
  const initialStatusResponse = await initialStatusResponsePromise;
  assert.equal(initialStatusResponse.status(), 200);
  const initialStatusBody = await initialStatusResponse.json();
  const initialStatusData = initialStatusBody?.data ?? lastStatusPayload;
  const hostStatusVerified = isFirewallStatusVerified(initialStatusData);

  const statusSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Genel Güvenlik ve Firewall Durumu' }) });
  const profilesSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Sunucu Servis Profilleri' }) });
  const portsSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Port ve Güvenlik Duvarı Kuralları' }) });
  const scanSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Hedef Port Taraması ve Doğrulama' }) });
  const bansSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'CrowdSec Tehdit ve Engelleme Yönetimi' }) });

  // Wait for all 4 real /api/panel/firewall/* responses to settle:
  // status/service-profiles/ports -> 200, bans -> real 400 decisions_list_failed (exact .28 partial failure profile)
  await expect(profilesSection.getByText('Yerel E-Posta', { exact: true })).toBeVisible();
  await expect(portsSection.getByRole('table')).toBeVisible();
  await expect(bansSection.getByRole('alert')).toContainText('CrowdSec engelleme listesi alınamadı');

  // Verify ZERO legacy /api/firewall/* calls and real /api/panel/firewall/* status codes
  assert.equal(firewallResponses.some((r) => r.pathname.startsWith('/api/firewall/')), false);
  for (const ep of ['status', 'service-profiles', 'ports']) {
    assert.ok(
      firewallResponses.some((r) => r.pathname === `/api/panel/firewall/${ep}` && r.status === 200),
      `Expected real 200 on /api/panel/firewall/${ep}`,
    );
  }
  assert.ok(
    firewallResponses.some((r) => r.pathname === '/api/panel/firewall/bans' && r.status === 400),
    'Expected real 400 decisions_list_failed on /api/panel/firewall/bans',
  );

  // Verify partial-failure isolation for CrowdSec bans (NEVER renders fake 0 IP or empty-success state)
  await expect(page.getByTestId('firewall-card-crowdsec')).toContainText('Aktif Engellemeler: Erişilemedi');
  await expect(page.getByTestId('firewall-card-crowdsec')).not.toContainText('0 IP');
  await expect(bansSection).not.toContainText('Şu anda aktif CrowdSec engellemesi bulunmuyor');
  await expect(bansSection).not.toContainText(missingCscliPath);
  await expect(bansSection).not.toContainText(dir);
  await expect(bansSection.getByRole('button', { name: 'IP Engelle' })).toBeDisabled();

  // Verify zero forbidden hardcoded dev strings or parenthetical English jargon in the live DOM
  const bodyText = await page.locator('body').innerText();
  for (const forbidden of [
    '157.180.11.28',
    'server.cryptoraichu.website',
    '.44',
    '(Unknown)',
    '(Boot)',
    '(Local Mail)',
    '(Authoritative DNS)',
    'E-Posta (Mail)',
    'Local-mail',
    'Authoritative-DNS',
  ]) {
    assert.equal(bodyText.includes(forbidden), false, `Firewall UI must not contain "${forbidden}"`);
  }

  // 2. Verify fail-closed status gating based on real host firewall status + real TCP scan through gateway
  if (!hostStatusVerified) {
    // Real host returned HTTP 200 with unverified status (e.g. status: 'error' without nft/systemctl):
    // UI MUST stay strictly fail-closed — no fake Standart/Korunuyor/Bouncer Pasif, and ALL mutations locked!
    await expect(statusSection.getByRole('alert')).toContainText('Güvenlik duvarı durumu doğrulanamadı');
    await expect(page.getByTestId('firewall-card-status')).toContainText('Hata');
    await expect(page.getByTestId('firewall-card-status')).toContainText('Tablo: Bilinmiyor');
    await expect(page.getByTestId('firewall-card-status')).not.toContainText('Standart');

    await expect(page.getByTestId('firewall-card-boot')).toContainText('Bilinmiyor');
    await expect(page.getByTestId('firewall-card-boot')).toContainText('Servis durumu: Bilinmiyor');
    await expect(page.getByTestId('firewall-card-boot')).not.toContainText('Pasif');
    await expect(page.getByTestId('firewall-card-boot')).not.toContainText('Devre dışı');

    await expect(page.getByTestId('firewall-card-docker')).toContainText('Bilinmiyor');
    await expect(page.getByTestId('firewall-card-docker')).toContainText('Docker ağ kuralları doğrulanamadı');
    await expect(page.getByTestId('firewall-card-docker')).not.toContainText('Korunuyor');

    await expect(page.getByTestId('firewall-card-crowdsec')).toContainText('Bilinmiyor');
    await expect(page.getByTestId('firewall-card-crowdsec')).not.toContainText('Bouncer Pasif');

    const initialProfileButtons = profilesSection.getByRole('button', { name: /Profili/ });
    assert.equal(await initialProfileButtons.count(), 2);
    await expect(initialProfileButtons.nth(0)).toBeDisabled();
    await expect(initialProfileButtons.nth(1)).toBeDisabled();
    await expect(portsSection.getByRole('button', { name: 'Port Kuralını Ekle' })).toBeDisabled();
    await expect(scanSection.getByRole('button', { name: 'Portu Test Et' })).toBeDisabled();

    // Still verify real authenticated browser POST /api/panel/firewall/scan + CSRF against real 127.0.0.1 TCP listener
    const liveScanOpen = await page.evaluate(async (targetPort) => {
      const sess = await (await fetch('/api/auth/session', { credentials: 'same-origin' })).json();
      const res = await fetch('/api/panel/firewall/scan', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': sess.data.csrfToken,
        },
        body: JSON.stringify({ host: '127.0.0.1', port: targetPort }),
      });
      return { status: res.status, body: await res.json() };
    }, tcpListenerPort);
    assert.equal(liveScanOpen.status, 200);
    assert.equal(liveScanOpen.body.data.reachable, true);

    await new Promise((resolve) => tcpListener.close(resolve));
    const liveScanClosed = await page.evaluate(async (targetPort) => {
      const sess = await (await fetch('/api/auth/session', { credentials: 'same-origin' })).json();
      const res = await fetch('/api/panel/firewall/scan', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': sess.data.csrfToken,
        },
        body: JSON.stringify({ host: '127.0.0.1', port: targetPort }),
      });
      return { status: res.status, body: await res.json() };
    }, tcpListenerPort);
    assert.equal(liveScanClosed.status, 200);
    assert.equal(liveScanClosed.body.data.reachable, false);
  } else {
    // Verified host firewall status (active/degraded/inactive): healthy controls unlock while CrowdSec stays locked
    await expect(profilesSection.getByRole('button', { name: 'Profili Etkinleştir' }).first()).toBeEnabled();
    await expect(portsSection.getByRole('button', { name: 'Port Kuralını Ekle' })).toBeEnabled();
    await expect(scanSection.getByRole('button', { name: 'Portu Test Et' })).toBeEnabled();

    await scanSection.locator('#firewall-scan-host').fill('127.0.0.1');
    await scanSection.locator('#firewall-scan-port').fill(String(tcpListenerPort));
    const scanOkResponse = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/panel/firewall/scan' && res.request().method() === 'POST');
    await scanSection.getByRole('button', { name: 'Portu Test Et' }).click();
    assert.equal((await scanOkResponse).status(), 200);
    await expect(scanSection).toContainText('Bağlantı Başarılı (Erişilebilir)');

    await new Promise((resolve) => tcpListener.close(resolve));
    const scanRefusedResponse = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/panel/firewall/scan' && res.request().method() === 'POST');
    await scanSection.getByRole('button', { name: 'Portu Test Et' }).click();
    assert.equal((await scanRefusedResponse).status(), 200);
    await expect(scanSection).toContainText('Erişilemedi');
  }

  // 3. Real upstream API outage (stop real apiServer while real createPanelServer stays running -> genuine 502!)
  firewallResponses.length = 0;
  await stopApiServer();
  await page.getByRole('button', { name: 'Yenile', exact: true }).click();

  await expect(page.getByTestId('firewall-card-status')).toContainText('Durum alınamadı');
  await expect(page.getByTestId('firewall-card-status')).not.toContainText('Pasif');
  await expect(page.getByTestId('firewall-card-status')).not.toContainText('Standart');

  await expect(page.getByTestId('firewall-card-boot')).toContainText('Bilinmiyor');
  await expect(page.getByTestId('firewall-card-boot')).not.toContainText('Pasif');
  await expect(page.getByTestId('firewall-card-boot')).not.toContainText('Devre dışı');

  await expect(page.getByTestId('firewall-card-docker')).toContainText('Bilinmiyor');
  await expect(page.getByTestId('firewall-card-docker')).not.toContainText('Korunuyor');

  await expect(page.getByTestId('firewall-card-crowdsec')).toContainText('Bilinmiyor');
  await expect(page.getByTestId('firewall-card-crowdsec')).toContainText('Aktif Engellemeler: Erişilemedi');
  await expect(page.getByTestId('firewall-card-crowdsec')).not.toContainText('Bouncer Pasif');
  await expect(page.getByTestId('firewall-card-crowdsec')).not.toContainText('0 IP');

  await expect(profilesSection.getByRole('alert')).toContainText('Servis profilleri alınamadı');
  await expect(profilesSection).not.toContainText('Zorunlu / Korumalı');
  await expect(profilesSection).not.toContainText('Devre Dışı');
  assert.equal(await profilesSection.getByRole('button', { name: /Profili/ }).count(), 0);

  await expect(portsSection.getByRole('alert')).toContainText('Port ve güvenlik duvarı kuralları alınamadı');
  await expect(portsSection).not.toContainText('Tümü (0)');
  await expect(portsSection).not.toContainText('Bu filtreye uygun port kuralı bulunamadı');
  await expect(portsSection.getByRole('button', { name: 'Port Kuralını Ekle' })).toBeDisabled();

  await expect(scanSection.getByRole('button', { name: 'Portu Test Et' })).toBeDisabled();

  await expect(bansSection.getByRole('alert')).toContainText('CrowdSec engelleme listesi alınamadı');
  await expect(bansSection).not.toContainText('Şu anda aktif CrowdSec engellemesi bulunmuyor');
  await expect(bansSection.getByRole('button', { name: 'IP Engelle' })).toBeDisabled();

  // Confirm all 4 real gateway requests got genuine 502 from createPanelServer and 0 legacy /api/firewall/* calls
  assert.equal(firewallResponses.some((r) => r.pathname.startsWith('/api/firewall/')), false);
  for (const ep of ['status', 'service-profiles', 'ports', 'bans']) {
    assert.ok(
      firewallResponses.some((r) => r.pathname === `/api/panel/firewall/${ep}` && r.status === 502),
      `Expected real 502 from createPanelServer on /api/panel/firewall/${ep}`,
    );
  }

  // 4. Strict status-gated mutation locking: restart real apiServer and recover ONLY service-profiles + ports
  //    while leaving status in error state -> ALL mutation controls MUST remain disabled until status recovers!
  await startApiServer();

  const retryProfiles = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/panel/firewall/service-profiles' && res.status() === 200);
  await profilesSection.getByRole('button', { name: 'Yeniden dene' }).click();
  await retryProfiles;
  await expect(profilesSection.getByText('Yerel E-Posta', { exact: true })).toBeVisible();

  const retryPorts = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/panel/firewall/ports' && res.status() === 200);
  await portsSection.getByRole('button', { name: 'Yeniden dene' }).click();
  await retryPorts;
  await expect(portsSection.getByRole('table')).toBeVisible();

  // Because status is STILL errored (unknown firewall state), EVERY mutation button on the page MUST remain disabled!
  await expect(page.getByTestId('firewall-card-status')).toContainText('Durum alınamadı');
  const profileButtons = profilesSection.getByRole('button', { name: /Profili/ });
  assert.equal(await profileButtons.count(), 2);
  await expect(profileButtons.nth(0)).toBeDisabled();
  await expect(profileButtons.nth(1)).toBeDisabled();
  await expect(portsSection.getByRole('button', { name: 'Port Kuralını Ekle' })).toBeDisabled();
  await expect(scanSection.getByRole('button', { name: 'Portu Test Et' })).toBeDisabled();
  await expect(bansSection.getByRole('button', { name: 'IP Engelle' })).toBeDisabled();

  // Now recover status via its per-section Yeniden dene:
  // - If host status is verified (active/degraded/inactive): healthy controls unlock while failed bans stays disabled!
  // - If host status is unverified (e.g. HTTP 200 status: 'error'): alert + fail-closed cards stay locked and ALL controls remain disabled!
  const retryStatus = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/panel/firewall/status' && res.status() === 200);
  await statusSection.getByRole('button', { name: 'Yeniden dene' }).click();
  await retryStatus;

  if (hostStatusVerified) {
    await expect(profileButtons.nth(0)).toBeEnabled();
    await expect(profileButtons.nth(1)).toBeEnabled();
    await expect(portsSection.getByRole('button', { name: 'Port Kuralını Ekle' })).toBeEnabled();
    await expect(scanSection.getByRole('button', { name: 'Portu Test Et' })).toBeEnabled();
    await expect(bansSection.getByRole('button', { name: 'IP Engelle' })).toBeDisabled();
  } else {
    await expect(statusSection.getByRole('alert')).toContainText('Güvenlik duvarı durumu doğrulanamadı');
    await expect(page.getByTestId('firewall-card-status')).toContainText('Hata');
    await expect(page.getByTestId('firewall-card-status')).toContainText('Tablo: Bilinmiyor');
    await expect(page.getByTestId('firewall-card-status')).not.toContainText('Standart');
    await expect(page.getByTestId('firewall-card-docker')).not.toContainText('Korunuyor');
    await expect(page.getByTestId('firewall-card-crowdsec')).not.toContainText('Bouncer Pasif');
    await expect(profileButtons.nth(0)).toBeDisabled();
    await expect(profileButtons.nth(1)).toBeDisabled();
    await expect(portsSection.getByRole('button', { name: 'Port Kuralını Ekle' })).toBeDisabled();
    await expect(scanSection.getByRole('button', { name: 'Portu Test Et' })).toBeDisabled();
    await expect(bansSection.getByRole('button', { name: 'IP Engelle' })).toBeDisabled();
  }

  // Final check: ZERO legacy /api/firewall/* requests across the entire session
  assert.equal(firewallResponses.some((r) => r.pathname.startsWith('/api/firewall/')), false);
});
