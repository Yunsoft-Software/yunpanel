import fs from 'node:fs';
import path from 'node:path';
import { test, expect, ORIGIN, manifest, saveManifest, apiCall, waitJob, ready, main } from './support.js';

test.beforeEach(async ({ context }) => {
  const dist = path.resolve('apps/web/dist');
  await context.route(url => url.origin === ORIGIN && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/tools/'), async route => {
    const url = new URL(route.request().url());
    const file = route.request().isNavigationRequest() ? path.join(dist, 'index.html') : path.join(dist, url.pathname);
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.continue();
    const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }[path.extname(file)] ?? 'application/octet-stream';
    return route.fulfill({ body: fs.readFileSync(file), contentType, headers: { 'Cache-Control': 'no-store' } });
  });
});
function record(action, proof) {
  const m = manifest(); m.fixture.operations.push({ action, ...proof, at: new Date().toISOString() }); saveManifest(m);
}
function owned(kind) {
  const m = manifest();
  const target = kind === 'php' ? m.fixture : m.fixture[kind === 'node' ? 'extraNode' : 'extraStatic'];
  if (!/^[a-f0-9]{64}$/.test(process.env.YUNPANEL_AUDIT_ACCEPTANCE_SHA ?? '') || !target || target.removed
    || !m.fixture.createdWebsiteIds.includes(target.websiteId) || !m.fixture.createdDomainIds.includes(target.domainId)
    || !/^(?:ypaudit|yp-node|yp-static)-[a-z0-9-]+\.157\.180\.11\.28\.sslip\.io$/.test(target.hostname)) throw new Error('Exact owned hosting fixture required');
  return target;
}
async function domain(liveApi, target) {
  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { result = await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/domains/' + target.domainId); break; }
    catch (error) {
      if (attempt === 2 || !error.message.includes('socket hang up')) throw error;
      record('hosting.read-reconnect-after-reload', { domainId: target.domainId, readOnly: true });
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  expect(result.status).toBe(200); expect(result.data.websiteId).toBe(target.websiteId);
  expect(result.data.primaryDomain).toBe(target.hostname); return result.data;
}
async function restoreSettings(liveApi, target, original) {
  const root = '/api/panel/domains/' + target.domainId;
  const current = await domain(liveApi, target);
  const jobs = await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/jobs'); expect(jobs.status).toBe(200);
  const records = Array.isArray(jobs.data) ? jobs.data : jobs.data.items ?? jobs.data.jobs;
  expect(Array.isArray(records)).toBe(true);
  expect(records.some(job => job.resourceId === target.domainId && ['queued', 'running'].includes(job.status))).toBe(false);
  if (JSON.stringify(current.nginxSettings) !== JSON.stringify(original)) {
    const changes = { nginxSettings: original };
    const preview = await apiCall(liveApi.api, liveApi.csrf, 'POST', root + '/update-preview', { changes }); expect(preview.status).toBe(200);
    const saved = await apiCall(liveApi.api, liveApi.csrf, 'PATCH', root, { changes,
      previewDigest: preview.data.previewDigest, confirmation: preview.data.confirmation }); expect(saved.status).toBe(200);
  }
  const pending = await domain(liveApi, target);
  if (pending.appliedRevision !== pending.desiredRevision || pending.state !== 'active') {
    for (const action of ['stage', 'activate']) {
      const queued = await apiCall(liveApi.api, liveApi.csrf, 'POST', root + '/' + action, {}); expect(queued.status).toBe(202);
      const job = await waitJob(liveApi.api, queued.data.id); expect(job.status).toBe('succeeded');
    }
  }
  const restored = await domain(liveApi, target);
  expect(restored.nginxSettings).toEqual(original); expect(restored.appliedRevision).toBe(restored.desiredRevision);
  const m = manifest(); m.fixture.hostingUiChecks[target.websiteId].restored = true; saveManifest(m);
  record('hosting.ui-original-restored', { websiteId: target.websiteId, verified: true });
}

test('@mutation source recovers only the recorded owned hosting drafts from the interrupted acceptance run', async ({ liveApi }) => {
  test.setTimeout(180000);
  for (const kind of ['php', 'node', 'static']) {
    const target = owned(kind), saved = manifest().fixture.hostingUiChecks?.[target.websiteId];
    if (saved?.restored === false) await restoreSettings(liveApi, target, saved.original);
  }
});

for (const kind of ['php', 'node', 'static']) {
  test('@mutation source ' + kind + ' hosting saves one form and changes actual HTTP headers and request limits', async ({ page, liveApi }) => {
    test.setTimeout(240000); const target = owned(kind), before = await domain(liveApi, target);
    expect(before.state).toBe('active'); expect(before.appliedRevision).toBe(before.desiredRevision);
    const m = manifest(); m.fixture.hostingUiChecks ??= {};
    expect(m.fixture.hostingUiChecks[target.websiteId]?.restored ?? true).toBe(true);
    m.fixture.hostingUiChecks[target.websiteId] = { original: before.nginxSettings, restored: false }; saveManifest(m);
    const name = 'X-YunPanel-Acceptance', value = 'hosting-' + kind + '-' + m.runId;
    const websiteOrigin = (before.httpsRedirect ? 'https://' : 'http://') + target.hostname;
    expect(before.nginxSettings.headers.some(item => item.name.toLowerCase() === name.toLowerCase())).toBe(false);
    try {
      await ready(page, '/websites/' + target.domainId + '/hosting');
      await expect(main(page).getByRole('heading', { name: 'Barındırma ayarları', exact: true })).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const body = page.getByLabel('En büyük yükleme boyutu (MB)', { exact: true }); await body.fill('2');
      await main(page).getByRole('button', { name: 'Yanıt başlığı ekle', exact: true }).click();
      const index = before.nginxSettings.headers.length + 1;
      await page.getByLabel('Başlık ' + index + ' adı', { exact: true }).fill(name);
      await page.getByLabel('Başlık ' + index + ' değeri', { exact: true }).fill(value);
      if (kind === 'static') {
        await page.getByLabel('Statik dosya önbelleği (saniye)', { exact: true }).fill('120');
        await page.getByRole('checkbox', { name: 'Bulunamayan sayfalarda index.html kullan', exact: true }).uncheck();
      } else {
        await expect(page.getByLabel('Statik dosya önbelleği (saniye)', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('checkbox', { name: 'Bulunamayan sayfalarda index.html kullan', exact: true })).toHaveCount(0);
      }
      await expect(page.getByLabel('Uygulama yanıt süresi (saniye)', { exact: true })).toHaveCount(0);
      const offset = page.auditTraffic.length;
      await main(page).getByRole('button', { name: 'Kaydet ve uygula', exact: true }).click();
      await expect(main(page).getByRole('status').filter({ hasText: 'Barındırma ayarları uygulandı.' })).toBeVisible({ timeout: 120000 });
      const mutations = page.auditTraffic.slice(offset).filter(item => item.method !== 'GET' && item.path.startsWith('/api/panel/domains/' + target.domainId));
      for (const suffix of ['/update-preview', '', '/stage', '/activate']) expect(mutations.filter(item => item.path === '/api/panel/domains/' + target.domainId + suffix)).toHaveLength(1);
      const saved = await domain(liveApi, target); expect(saved.nginxSettings.clientMaxBodySizeMb).toBe(2);
      expect(saved.appliedRevision).toBe(saved.desiredRevision); expect(saved.nginxSettings.headers.at(-1)).toEqual({ name, value, always: true });
      const actual = await liveApi.api.get(websiteOrigin + '/', { maxRedirects: 0 }); expect(actual.status()).toBe(200);
      expect(actual.headers()[name.toLowerCase()]).toBe(value);
      const large = await liveApi.api.post(websiteOrigin + '/__yp_body_limit_' + m.runId,
        { data: Buffer.alloc(3 * 1024 * 1024, 65), headers: { 'Content-Type': 'application/octet-stream' }, maxRedirects: 0 });
      expect(large.status()).toBe(413); expect(large.headers()[name.toLowerCase()]).toBe(value);
      if (kind === 'static') {
        expect((await liveApi.api.get('http://' + target.hostname + '/__yp_missing_' + m.runId)).status()).toBe(404);
        const upload = await liveApi.api.put('/api/panel/websites/' + target.websiteId + '/files/upload?path=hosting-proof.css',
          { data: Buffer.from('/* ' + value + ' */'), headers: { Origin: ORIGIN, 'x-csrf-token': liveApi.csrf, 'Content-Type': 'application/octet-stream' } }); expect([200, 201]).toContain(upload.status());
        const asset = await liveApi.api.get('http://' + target.hostname + '/hosting-proof.css'); expect(asset.status()).toBe(200);
        expect(asset.headers()['cache-control']).toContain('max-age=120');
        const deleted = await apiCall(liveApi.api, liveApi.csrf, 'DELETE', '/api/panel/websites/' + target.websiteId + '/files',
          { path: 'hosting-proof.css', confirmation: 'delete:' + target.websiteId + ':hosting-proof.css' }); expect(deleted.status).toBe(200);
      }
      await page.reload(); await expect(body).toHaveValue('2');
      expect(page.auditErrors).toEqual([]);
      record('hosting.ui-real-http', { kind, websiteId: target.websiteId, verified: true, bodyLimitRejected: true });
    } catch (error) {
      record('hosting.ui-test-failure', { kind, websiteId: target.websiteId, phase: 'assertions', errorKind: error.name });
      try { await restoreSettings(liveApi, target, before.nginxSettings); }
      catch { record('hosting.ui-cleanup-needs-inspection', { websiteId: target.websiteId }); }
      throw error;
    }
    await restoreSettings(liveApi, target, before.nginxSettings);
  });
}

for (const width of [320, 390, 834, 1440]) {
  test('@native-ui hosting settings stay in one screen at width ' + width, async ({ page }) => {
    const target = owned('php'); await page.setViewportSize({ width, height: 1000 });
    await ready(page, '/websites/' + target.domainId + '/hosting');
    await expect(main(page).getByRole('heading', { name: 'Barındırma ayarları', exact: true })).toBeVisible();
    await expect(page.getByLabel('En büyük yükleme boyutu (MB)', { exact: true })).toBeVisible();
    await expect(main(page).getByRole('button', { name: 'Kaydet ve uygula', exact: true })).toHaveCount(1);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    expect(page.auditErrors).toEqual([]);
  });
}

test('@mutation source hosting rejects protocol-managed headers before any update request', async ({ page }) => {
  const target = owned('php'); await ready(page, '/websites/' + target.domainId + '/hosting');
  await main(page).getByRole('button', { name: 'Yanıt başlığı ekle', exact: true }).click();
  await page.getByLabel(/Başlık \d+ adı/).last().fill('Set-Cookie');
  await page.getByLabel(/Başlık \d+ değeri/).last().fill('invalid-for-panel-policy');
  const offset = page.auditTraffic.length;
  await main(page).getByRole('button', { name: 'Kaydet ve uygula', exact: true }).click();
  await expect(main(page).getByRole('alert')).toContainText('Web sunucusu ayarlarını kontrol edin');
  expect(page.auditTraffic.slice(offset).filter(item => item.method === 'PATCH' || item.path.endsWith('/update-preview') || item.path.endsWith('/stage'))).toEqual([]);
});
