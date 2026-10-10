import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
const record = (action, proof) => { const m = manifest(); m.fixture.operations.push({ action, ...proof, at: new Date().toISOString() }); saveManifest(m); };
function owned(kind) {
  const m = manifest(), target = kind === 'php' ? m.fixture : m.fixture.extraStatic;
  if (!/^[a-f0-9]{64}$/.test(process.env.YUNPANEL_AUDIT_ACCEPTANCE_SHA ?? '') || !target || target.removed
    || !m.fixture.createdWebsiteIds.includes(target.websiteId) || !m.fixture.createdDomainIds.includes(target.domainId)
    || !/^(?:ypaudit|yp-static)-[a-z0-9-]+\.157\.180\.11\.28\.sslip\.io$/.test(target.hostname)) throw new Error('Exact owned native PHP/static fixture required');
  return target;
}
async function domain(liveApi, target) {
  const result = await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/domains/' + target.domainId);
  expect(result.status).toBe(200); expect(result.data.websiteId).toBe(target.websiteId);
  expect(result.data.primaryDomain).toBe(target.hostname); return result.data;
}
async function restore(liveApi, target, proof) {
  const root = '/api/panel/domains/' + target.domainId, files = '/api/panel/websites/' + target.websiteId + '/files';
  const current = await domain(liveApi, target);
  // Explicit null clears newly introduced optional preferences in the partial
  // update API. It preserves the original runtime defaults and all old fields.
  const original = { ...proof.original, indexFiles: proof.original.indexFiles ?? null, errorPages: proof.original.errorPages ?? null };
  if (JSON.stringify(current.nginxSettings) !== JSON.stringify(original)) {
    const changes = { nginxSettings: original };
    const preview = await apiCall(liveApi.api, liveApi.csrf, 'POST', root + '/update-preview', { changes }); expect(preview.status).toBe(200);
    expect((await apiCall(liveApi.api, liveApi.csrf, 'PATCH', root, { changes, previewDigest: preview.data.previewDigest, confirmation: preview.data.confirmation })).status).toBe(200);
  }
  const pending = await domain(liveApi, target);
  if (pending.state !== 'active' || pending.appliedRevision !== pending.desiredRevision) {
    for (const action of ['stage', 'activate']) {
      const queued = await apiCall(liveApi.api, liveApi.csrf, 'POST', root + '/' + action, {}); expect(queued.status).toBe(202);
      expect((await waitJob(liveApi.api, queued.data.id)).status).toBe('succeeded');
    }
  }
  const restored = await domain(liveApi, target); expect(restored.nginxSettings).toEqual(original);
  expect(restored.appliedRevision).toBe(restored.desiredRevision);
  const listed = await apiCall(liveApi.api, liveApi.csrf, 'GET', files); expect(listed.status).toBe(200);
  expect(Array.isArray(listed.data.entries)).toBe(true);
  for (const name of proof.uploaded) {
    expect(name).toMatch(/^yp-(?:index|error|blocked|status)-[a-f0-9]{12}\.(?:html|php)$/);
    if (listed.data.entries.some(item => item.name === name)) {
      const removed = await apiCall(liveApi.api, liveApi.csrf, 'DELETE', files, { path: name, confirmation: 'delete:' + target.websiteId + ':' + name });
      expect(removed.status).toBe(200);
    }
  }
  const origin = (restored.httpsRedirect ? 'https://' : 'http://') + target.hostname;
  expect((await liveApi.api.get(origin + '/')).status()).toBe(200);
  const m = manifest(); m.fixture.hostingFileChecks[target.websiteId].restored = true; saveManifest(m);
  record('hosting.files-runtime-original-restored', { websiteId: target.websiteId, verified: true, optionalDefaultsExplicit: true });
}

test('@mutation source recovers only recorded owned index/error preferences and their exact test files', async ({ liveApi }) => {
  test.setTimeout(240000);
  for (const kind of ['php', 'static']) {
    const target = owned(kind), proof = manifest().fixture.hostingFileChecks?.[target.websiteId];
    if (proof?.restored === false) await restore(liveApi, target, proof);
  }
});

for (const kind of ['php', 'static']) test('@mutation source ' + kind + ' index/error settings change real directory content and preserve actual error statuses', async ({ page, liveApi }) => {
  test.setTimeout(240000);
  const target = owned(kind), before = await domain(liveApi, target), suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  expect(before.state).toBe('active'); expect(before.appliedRevision).toBe(before.desiredRevision);
  const names = { index: 'yp-index-' + suffix + '.html', error: 'yp-error-' + suffix + '.html', blocked: 'yp-blocked-' + suffix + '.html', status: 'yp-status-' + suffix + '.php' };
  const markers = { index: 'ACTUAL-INDEX-' + suffix, error: 'ACTUAL-ERROR-' + suffix };
  const root = '/api/panel/websites/' + target.websiteId + '/files';
  const listing = await apiCall(liveApi.api, liveApi.csrf, 'GET', root); expect(listing.status).toBe(200);
  expect(Array.isArray(listing.data.entries)).toBe(true);
  expect(listing.data.entries.some(item => Object.values(names).includes(item.name))).toBe(false);
  const m = manifest(); m.fixture.hostingFileChecks ??= {};
  expect(m.fixture.hostingFileChecks[target.websiteId]?.restored ?? true).toBe(true);
  m.fixture.hostingFileChecks[target.websiteId] = { original: before.nginxSettings, uploaded: [], restored: false }; saveManifest(m);
  async function upload(name, body) {
    // Record intent before sending: a lost response must leave an exact owned
    // recovery target rather than invite a second upload or broad deletion.
    const state = manifest(); state.fixture.hostingFileChecks[target.websiteId].uploaded.push(name); saveManifest(state);
    const result = await liveApi.api.put(root + '/upload?path=' + name, { data: Buffer.from(body), headers: { Origin: ORIGIN, 'x-csrf-token': liveApi.csrf, 'Content-Type': 'application/octet-stream' } });
    expect(result.status()).toBe(201);
  }
  let failure;
  try {
    await upload(names.index, '<!doctype html><title>Owned index</title><p>' + markers.index + '</p>');
    await upload(names.error, '<!doctype html><title>Owned error</title><p>' + markers.error + '</p>');
    await upload(names.blocked, '<p>Owned unreadable probe</p>');
    expect((await apiCall(liveApi.api, liveApi.csrf, 'POST', root + '/permissions', { path: names.blocked, mode: '0600' })).status).toBe(200);
    if (kind === 'php') await upload(names.status, "<?php $code=(int)($_GET['code']??404); if(!in_array($code,[403,404,500,502,503,504],true)){exit;} http_response_code($code); echo 'ORIGINAL-ERROR-BODY';");
    await ready(page, '/websites/' + target.domainId + '/hosting');
    await page.getByLabel('Başlangıç dosyaları', { exact: true }).fill(names.index + (kind === 'php' ? ' index.php index.html' : ' index.html'));
    if (kind === 'static') await page.getByRole('checkbox', { name: 'Bulunamayan sayfalarda index.html kullan', exact: true }).uncheck();
    await main(page).locator('summary').filter({ hasText: 'Özel hata sayfaları' }).click();
    for (const code of ['403', '404', '500', '502', '503', '504']) await page.getByLabel(code + ' hata sayfası', { exact: true }).fill('/' + names.error);
    const offset = page.auditTraffic.length;
    await main(page).getByRole('button', { name: 'Kaydet ve uygula', exact: true }).click();
    await expect(main(page).getByRole('status').filter({ hasText: 'Barındırma ayarları uygulandı.' })).toBeVisible({ timeout: 120000 });
    const mutations = page.auditTraffic.slice(offset).filter(item => item.method !== 'GET' && item.path.startsWith('/api/panel/domains/' + target.domainId));
    for (const endpoint of ['/update-preview', '', '/stage', '/activate']) expect(mutations.filter(item => item.path === '/api/panel/domains/' + target.domainId + endpoint)).toHaveLength(1);
    const saved = await domain(liveApi, target), origin = (saved.httpsRedirect ? 'https://' : 'http://') + target.hostname;
    expect(saved.appliedRevision).toBe(saved.desiredRevision); expect(saved.nginxSettings.indexFiles[0]).toBe(names.index);
    const home = await liveApi.api.get(origin + '/', { maxRedirects: 0 }); expect(home.status()).toBe(200); expect(await home.text()).toContain(markers.index);
    for (const [url, code] of [[origin + '/yp-not-found-' + suffix, 404], [origin + '/' + names.blocked, 403], [origin + '/' + names.error, 404],
      ...(kind === 'php' ? [403, 404, 500, 502, 503, 504].map(code => [origin + '/' + names.status + '?code=' + code, code]) : [])]) {
      const response = await liveApi.api.get(url, { maxRedirects: 0 }); expect(response.status(), url).toBe(code);
      expect(await response.text()).toContain(markers.error);
    }
    await page.reload(); await expect(page.getByLabel('Başlangıç dosyaları', { exact: true })).toHaveValue(saved.nginxSettings.indexFiles.join(' '));
    expect(page.auditErrors).toEqual([]);
    record('hosting.files-ui-real-http', { websiteId: target.websiteId, kind, verified: true, directErrorPageDenied: true, originalStatusesPreserved: true });
  } catch (error) { failure = error; }
  try { await restore(liveApi, target, manifest().fixture.hostingFileChecks[target.websiteId]); }
  catch (error) { record('hosting.files-cleanup-needs-inspection', { websiteId: target.websiteId, errorKind: error.name }); failure ??= error; }
  if (failure) throw failure;
});

test('@mutation source unsafe index/error preferences are rejected before any preview or mutation', async ({ page }) => {
  const target = owned('php'); await ready(page, '/websites/' + target.domainId + '/hosting');
  const index = page.getByLabel('Başlangıç dosyaları', { exact: true });
  await index.fill('../outside.php'); const offset = page.auditTraffic.length;
  await main(page).getByRole('button', { name: 'Kaydet ve uygula', exact: true }).click();
  await expect(main(page).getByRole('alert')).toContainText('Web sunucusu ayarlarını kontrol edin');
  await index.fill('index.php index.html');
  await main(page).locator('summary').filter({ hasText: 'Özel hata sayfaları' }).click();
  await page.getByLabel('404 hata sayfası', { exact: true }).fill('https://foreign.example/error.html');
  await main(page).getByRole('button', { name: 'Kaydet ve uygula', exact: true }).click();
  await expect(main(page).getByRole('alert')).toContainText('Web sunucusu ayarlarını kontrol edin');
  expect(page.auditTraffic.slice(offset).filter(item => item.method === 'PATCH' || /\/(?:update-preview|stage|activate)$/.test(item.path))).toEqual([]);
});

test('@native-ui Passenger hosting does not offer PHP/static index or error controls', async ({ page }) => {
  const target = manifest().fixture.extraNode; expect(target?.removed).not.toBe(true); expect(target?.domainId).toBeTruthy();
  await ready(page, '/websites/' + target.domainId + '/hosting');
  await expect(page.getByLabel('Başlangıç dosyaları', { exact: true })).toHaveCount(0);
  await expect(main(page).locator('summary').filter({ hasText: 'Özel hata sayfaları' })).toHaveCount(0);
  expect(page.auditErrors).toEqual([]);
});
