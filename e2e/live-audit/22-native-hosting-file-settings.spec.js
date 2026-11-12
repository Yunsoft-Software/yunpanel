import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { test, expect, apiContext, ready, main } from './support.js';
import { createOwnedFixture, cleanupOwnedFixture, readOnlyHostProbe } from './owned-fixture.js';

const nodeSource = { kind: 'new_node', repositoryUrl: 'https://github.com/heroku/node-js-getting-started.git', branch: 'main', retention: 2,
  runtime: { nodeMajor: 24, installMode: 'ci', buildScript: null, startMode: 'node', entryFile: 'index.js', healthPath: '/', healthTimeoutSeconds: 30, restartPolicy: 'on-failure' } };
const accepted = (result, status = 200) => { expect(result.status, result.body?.error?.code).toBe(status); return result.data; };
const domainPath = fixture => '/api/panel/domains/' + fixture.ledger.domainId;
async function uploadOwned(fixture, filename, value) {
  try { await fixture.upload(filename, value); }
  catch (error) {
    if (error.code !== 'owned_fixture_transport') throw error;
    let readback;
    try { readback = await fixture.readText(filename); }
    catch { fixture.record('files.upload.unconfirmed', { filename, receiptKnown: false }); throw error; }
    const sha256 = createHash('sha256').update(value).digest('hex');
    expect(readback.sha256).toBe(sha256); expect(readback.content).toBe(Buffer.from(value).toString('utf8'));
    fixture.record('files.upload.reconciled', { filename, sha256, receiptKnown: false, actualContentVerified: true });
  }
}
async function domain(fixture) {
  const value = accepted(await fixture.call('GET', domainPath(fixture)));
  expect(value.websiteId).toBe(fixture.ledger.websiteId); expect(value.primaryDomain).toBe(fixture.ledger.hostname); return value;
}
async function restore(fixture, original, files) {
  const root = domainPath(fixture), settings = { ...original, indexFiles: original.indexFiles ?? null, errorPages: original.errorPages ?? null };
  const current = await domain(fixture);
  if (!isDeepStrictEqual(current.nginxSettings, settings)) {
    const input = { changes: { nginxSettings: settings } }, preview = accepted(await fixture.call('POST', root + '/update-preview', input));
    accepted(await fixture.call('PATCH', root, { ...input, previewDigest: preview.previewDigest, confirmation: preview.confirmation }));
  }
  const pending = await domain(fixture);
  if (pending.state !== 'active' || pending.appliedRevision !== pending.desiredRevision) for (const action of ['stage', 'activate']) {
    const job = accepted(await fixture.call('POST', root + '/' + action, {}), 202); expect((await fixture.waitJob(job.id)).status).toBe('succeeded');
  }
  const restored = await domain(fixture); expect(restored.nginxSettings).toEqual(settings); expect(restored.appliedRevision).toBe(restored.desiredRevision);
  for (const filename of files) {
    const listing = accepted(await fixture.call('GET', fixture.endpoint('/files')));
    if (listing.entries.some(entry => entry.name === filename)) await fixture.deleteFile(filename);
  }
  expect((await fixture.http('/')).status).toBe(200); fixture.record('hosting.files-restored', { verified: true, files });
}

test.describe('T887 native owned index and error preferences', () => {
  let actor, projectName; const sites = new Map(), keys = new Set();
  async function site(kind) {
    if (!sites.has(kind)) {
      const key = 't887-file-settings-' + kind + '-' + projectName; keys.add(key);
      const fixture = await createOwnedFixture(actor, { key, runtime: kind, ...(kind === 'node' ? { source: nodeSource } : {}) });
      sites.set(kind, fixture);
      if (kind !== 'node') await uploadOwned(fixture, 'index.html', '<!doctype html><p>T887 original index</p>');
      expect((await fixture.http('/')).status).toBe(200);
    }
    return sites.get(kind);
  }
  test.beforeAll(async ({}, info) => { projectName = (info.project.name.startsWith('firefox') ? 'ff' : 'cr') + '-w' + info.workerIndex; actor = await apiContext(); });
  test.afterAll(async () => {
    const failures = [];
    for (const key of [...keys].reverse()) try {
      const fixture = [...sites.values()].find(value => value.ledger.key === key);
      const ledger = fixture ? await fixture.cleanup() : await cleanupOwnedFixture(actor, { key });
      const absent = readOnlyHostProbe({ ledger }, 'lifecycle-absence');
      expect(absent.unixUserExists).toBe(false); expect(absent.unixGroupExists).toBe(false);
      expect(absent.roots.every(value => !value.exists)).toBe(true); expect(absent.nginxFiles.every(value => !value.exists)).toBe(true);
      expect(absent.fpmFiles).toEqual([]); expect(absent.sockets).toEqual([]); expect(absent.mounts).toEqual([]);
    } catch (error) { failures.push(error.message); }
    await actor?.api.dispose(); expect(failures, 'Every exact owned Website must be cleaned').toEqual([]);
  });

  test('@mutation reconciles only owned current ledger index and error preferences and exact test files', async () => {
    test.setTimeout(360000);
    for (const kind of ['php', 'static']) {
    const fixture = await site(kind), before = await domain(fixture);
    const suffix = randomBytes(6).toString('hex'), filename = 'yp-index-' + suffix + '.html';
    fixture.record('hosting.files-recovery.intent', { runtime: kind, originalSettings: before.nginxSettings, files: [filename] });
    fixture.record('openAcceptance', { historicalCommit: 'ba33f4a8^', historicalFile: '22-native-hosting-file-settings.spec.js',
      historicalTitle: '@mutation source recovers only recorded owned index/error preferences and their exact test files',
      reason: 'The October candidate ledger is retired. This fresh owned ledger exercises normal reconciliation without recreating an interrupted historical environment.',
      requiredChannel: 'Owned interrupted current-run recovery through normal API' });
    await uploadOwned(fixture, filename, '<p>T887 recovery owned index</p>');
    const root = domainPath(fixture), input = { changes: { nginxSettings: { ...before.nginxSettings, indexFiles: [filename, 'index.html'] } } };
    try {
      const preview = accepted(await fixture.call('POST', root + '/update-preview', input));
      accepted(await fixture.call('PATCH', root, { ...input, previewDigest: preview.previewDigest, confirmation: preview.confirmation }));
      expect((await domain(fixture)).desiredRevision).toBeGreaterThan((await domain(fixture)).appliedRevision);
      await restore(fixture, before.nginxSettings, [filename]);
      expect(accepted(await fixture.call('GET', fixture.endpoint('/files'))).entries.some(entry => entry.name === filename)).toBe(false);
    } finally { await restore(fixture, before.nginxSettings, [filename]); }
    }
  });

  for (const kind of ['php', 'static']) test('@mutation ' + kind + ' index and error settings change real content while preserving actual HTTP statuses', async ({ page }) => {
    test.setTimeout(360000); const fixture = await site(kind), before = await domain(fixture), suffix = randomBytes(6).toString('hex');
    expect(before.state).toBe('active'); expect(before.appliedRevision).toBe(before.desiredRevision);
    const names = { index: 'yp-index-' + suffix + '.html', error: 'yp-error-' + suffix + '.html', blocked: 'yp-blocked-' + suffix + '.html', status: 'yp-status-' + suffix + '.php' };
    const markers = { index: 'ACTUAL-INDEX-' + suffix, error: 'ACTUAL-ERROR-' + suffix }, uploaded = []; let failure;
    fixture.record('hosting.files.intent', { originalSettings: before.nginxSettings, filenames: Object.values(names) });
    async function upload(filename, content) { uploaded.push(filename); await uploadOwned(fixture, filename, content); }
    try {
      await upload(names.index, '<!doctype html><p>' + markers.index + '</p>');
      await upload(names.error, '<!doctype html><p>' + markers.error + '</p>');
      await upload(names.blocked, '<p>owned unreadable health</p>');
      accepted(await fixture.call('POST', fixture.endpoint('/files/permissions'), { path: names.blocked, mode: '0600' }));
      if (kind === 'php') await upload(names.status, "<?php $code=(int)($_GET['code']??404); if(!in_array($code,[403,404,500,502,503,504],true)){exit;} http_response_code($code); echo 'ORIGINAL-ERROR-BODY';");
      await ready(page, fixture.route('hosting'));
      await page.getByLabel('Başlangıç dosyaları', { exact: true }).fill(names.index + (kind === 'php' ? ' index.php index.html' : ' index.html'));
      if (kind === 'static') await page.getByRole('checkbox', { name: 'Bulunamayan sayfalarda index.html kullan', exact: true }).uncheck();
      await main(page).locator('summary').filter({ hasText: 'Özel hata sayfaları' }).click();
      for (const status of [403, 404, 500, 502, 503, 504]) await page.getByLabel(status + ' hata sayfası', { exact: true }).fill('/' + names.error);
      const offset = page.auditTraffic.length;
      const stageResponse = page.waitForResponse(response => new URL(response.url()).pathname === domainPath(fixture) + '/stage' && response.request().method() === 'POST', { timeout: 120000 }).catch(error => ({ transportError: error }));
      await main(page).getByRole('button', { name: 'Kaydet ve uygula', exact: true }).click();
      const staged = await stageResponse; if (staged.transportError) throw staged.transportError;
      const stageBody = await staged.json(); fixture.record('hosting.files.stage-response', { runtime: kind, status: staged.status(), errorCode: stageBody.error?.code ?? null });
      expect(staged.status(), stageBody.error?.code).toBe(202);
      await expect(main(page).getByRole('status').filter({ hasText: 'Barındırma ayarları uygulandı.' })).toBeVisible({ timeout: 120000 });
      const root = domainPath(fixture), mutations = page.auditTraffic.slice(offset).filter(entry => entry.method !== 'GET' && entry.path.startsWith(root));
      for (const endpoint of ['/update-preview', '', '/stage', '/activate']) expect(mutations.filter(entry => entry.path === root + endpoint)).toHaveLength(1);
      const saved = await domain(fixture); expect(saved.appliedRevision).toBe(saved.desiredRevision); expect(saved.nginxSettings.indexFiles[0]).toBe(names.index);
      const home = await fixture.http('/'); expect(home.status).toBe(200); expect(home.body).toContain(markers.index);
      const probes = [['/yp-missing-' + suffix + (kind === 'php' ? '.php' : ''), 404], ['/' + names.blocked, 403], ['/' + names.error, 404],
        ...(kind === 'php' ? [403, 404, 500, 502, 503, 504].map(status => ['/' + names.status + '?code=' + status, status]) : [])];
      for (const [pathname, status] of probes) {
        const response = await fixture.http(pathname); expect(response.status, pathname).toBe(status); expect(response.body).toContain(markers.error);
      }
      await page.reload(); await expect(page.getByLabel('Başlangıç dosyaları', { exact: true })).toHaveValue(saved.nginxSettings.indexFiles.join(' '));
      expect(page.auditErrors).toEqual([]); fixture.record('hosting.index-errors.real-http', { runtime: kind, verified: true, directErrorDenied: true, originalStatusesPreserved: true });
    } catch (error) { failure = error; }
    try { await restore(fixture, before.nginxSettings, uploaded); }
    catch (error) { fixture.record('hosting.files.cleanup-failure', { runtime: kind, errorKind: error.name, errorCode: error.code ?? null }); failure ??= error; }
    if (failure) throw failure;
  });

  test('@mutation unsafe index and external error preferences reject before any preview or mutation', async ({ page }) => {
    test.setTimeout(240000); const fixture = await site('php'); await ready(page, fixture.route('hosting'));
    const original = await domain(fixture), index = page.getByLabel('Başlangıç dosyaları', { exact: true });
    await index.fill('../outside.php'); const offset = page.auditTraffic.length;
    await main(page).getByRole('button', { name: 'Kaydet ve uygula', exact: true }).click();
    await expect(main(page).getByRole('alert')).toContainText('Web sunucusu ayarlarını kontrol edin');
    await index.fill('index.php index.html'); await main(page).locator('summary').filter({ hasText: 'Özel hata sayfaları' }).click();
    await page.getByLabel('404 hata sayfası', { exact: true }).fill('https://foreign.example/error.html');
    await main(page).getByRole('button', { name: 'Kaydet ve uygula', exact: true }).click();
    await expect(main(page).getByRole('alert')).toContainText('Web sunucusu ayarlarını kontrol edin');
    expect(page.auditTraffic.slice(offset).filter(entry => entry.method === 'PATCH' || /\/(?:update-preview|stage|activate)$/.test(entry.path))).toEqual([]);
    expect((await domain(fixture)).nginxSettings).toEqual(original.nginxSettings); expect(page.auditErrors).toEqual([]);
  });

  test('@mutation Passenger hosting excludes PHP and static index and error controls', async ({ page }) => {
    test.setTimeout(360000); const fixture = await site('node'); await ready(page, fixture.route('hosting'));
    await expect(main(page).getByRole('heading', { name: 'Barındırma ayarları', exact: true })).toBeVisible();
    await expect(page.getByLabel('Başlangıç dosyaları', { exact: true })).toHaveCount(0);
    await expect(main(page).locator('summary').filter({ hasText: 'Özel hata sayfaları' })).toHaveCount(0); expect(page.auditErrors).toEqual([]);
  });
});
