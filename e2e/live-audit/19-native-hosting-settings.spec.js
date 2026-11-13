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
async function currentDomain(fixture) {
  const domain = accepted(await fixture.call('GET', domainPath(fixture)));
  expect(domain.websiteId).toBe(fixture.ledger.websiteId); expect(domain.primaryDomain).toBe(fixture.ledger.hostname); return domain;
}
async function publish(fixture, settings) {
  const root = domainPath(fixture), before = await currentDomain(fixture);
  // PATCH merges settings. A legacy PHP envelope omits cache, so clearing a
  // cache introduced by this test requires an explicit canonical null value.
  const desired = before.targetType === 'php'
    ? { ...settings, staticAssetCacheSeconds: settings.staticAssetCacheSeconds ?? null }
    : settings;
  if (!isDeepStrictEqual(before.nginxSettings, desired)) {
    const input = { changes: { nginxSettings: desired } };
    const preview = accepted(await fixture.call('POST', root + '/update-preview', input));
    accepted(await fixture.call('PATCH', root, { ...input, previewDigest: preview.previewDigest, confirmation: preview.confirmation }));
  }
  const pending = await currentDomain(fixture);
  if (pending.state !== 'active' || pending.desiredRevision !== pending.appliedRevision) {
    for (const action of ['stage', 'activate']) {
      const queued = accepted(await fixture.call('POST', root + '/' + action, {}), 202);
      expect((await fixture.waitJob(queued.id)).status).toBe('succeeded');
    }
  }
  const result = await currentDomain(fixture); expect(result.nginxSettings).toEqual(desired);
  expect(result.appliedRevision).toBe(result.desiredRevision); return result;
}

test.describe('T887 native owned hosting settings', () => {
  let actor, projectName; const sites = new Map(), originals = new Map(), keys = new Set();
  async function site(kind) {
    if (!sites.has(kind)) {
      const key = 't887-hosting-' + kind + '-' + projectName; keys.add(key);
      const fixture = await createOwnedFixture(actor, { key, runtime: kind, ...(kind === 'node' ? { source: nodeSource } : {}) });
      sites.set(kind, fixture); originals.set(kind, (await currentDomain(fixture)).nginxSettings);
      if (kind !== 'node') await uploadOwned(fixture, 'index.html', '<!doctype html><p>T887 owned ' + kind + ' hosting</p>');
      expect((await fixture.http('/')).status).toBe(200);
    }
    return sites.get(kind);
  }
  test.beforeAll(async ({}, info) => { projectName = (info.project.name.startsWith('firefox') ? 'ff' : 'cr') + '-w' + info.workerIndex; actor = await apiContext(); });
  test.afterAll(async () => {
    const failures = [];
    for (const key of [...keys].reverse()) {
      try {
        const fixture = [...sites.values()].find(value => value.ledger.key === key);
        const ledger = fixture ? await fixture.cleanup() : await cleanupOwnedFixture(actor, { key });
        const absent = readOnlyHostProbe({ ledger }, 'lifecycle-absence');
        expect(absent.unixUserExists).toBe(false); expect(absent.unixGroupExists).toBe(false);
        expect(absent.roots.every(value => !value.exists)).toBe(true); expect(absent.nginxFiles.every(value => !value.exists)).toBe(true);
        expect(absent.fpmFiles).toEqual([]); expect(absent.sockets).toEqual([]); expect(absent.mounts).toEqual([]);
      } catch (error) { failures.push(error.message); }
    }
    await actor?.api.dispose(); expect(failures, 'Every exact owned Website must be cleaned').toEqual([]);
  });

  test('@mutation reconciles only this run ledger hosting draft and removes only its recorded health file', async () => {
    test.setTimeout(480000);
    for (const kind of ['php', 'node', 'static']) {
    const fixture = await site(kind), original = originals.get(kind);
    const filename = 'yp-t887-recovery-' + randomBytes(6).toString('hex') + '.html';
    fixture.record('hosting.recovery.intent', { runtime: kind, filename, originalSettings: original });
    fixture.record('openAcceptance', { historicalCommit: 'ba33f4a8^', historicalFile: '19-native-hosting-settings.spec.js',
      historicalTitle: '@mutation source recovers only the recorded owned hosting drafts from the interrupted acceptance run',
      reason: 'The October candidate ledger is intentionally retired. This fresh ledger reconciliation covers current normal recovery; an actual interrupted old run cannot be recreated without restoring the prohibited acceptance environment.',
      requiredChannel: 'Owned interrupted current-run recovery through normal API' });
    try {
      await uploadOwned(fixture, filename, '<p>owned recovery</p>');
      await publish(fixture, { ...original, clientMaxBodySizeMb: 17 });
      expect((await readOnlyHostProbe(fixture, 'nginx-config')).clientMaxBodySizeMb).toBe(17);
      await publish(fixture, original); await fixture.deleteFile(filename);
      const listing = accepted(await fixture.call('GET', fixture.endpoint('/files')));
      expect(listing.entries.some(entry => entry.name === filename)).toBe(false);
      expect((await fixture.http('/')).status).toBe(200);
      fixture.record('hosting.recovery.current-ledger', { runtime: kind, verified: true });
    } finally { await publish(fixture, original); }
    }
  });

  for (const kind of ['php', 'node', 'static']) test('@mutation ' + kind + ' hosting saves once and changes actual response headers body limits and cache', async ({ page }) => {
    test.setTimeout(360000); const fixture = await site(kind), before = await currentDomain(fixture), original = before.nginxSettings;
    expect(before.state).toBe('active'); expect(before.appliedRevision).toBe(before.desiredRevision);
    expect(original.headers.some(header => header.name.toLowerCase() === 'x-yunpanel-t887')).toBe(false);
    const headerValue = 't887-' + kind + '-' + randomBytes(6).toString('hex'); let css, cacheBaseline, failure;
    const cssBody = 'body{color:#123}';
    fixture.record('hosting.ui.original', { runtime: kind, nginxSettings: original });
    try {
      if (['php', 'static'].includes(kind)) {
        expect(original.staticAssetCacheSeconds ?? null).not.toBe(120);
        css = 'yp-t887-' + randomBytes(6).toString('hex') + '.css';
        await uploadOwned(fixture, css, cssBody);
        const baseline = await fixture.http('/' + css);
        expect(baseline.status).toBe(200); expect(baseline.body).toBe(cssBody);
        cacheBaseline = baseline.headers['cache-control'] ?? null;
        expect((cacheBaseline ?? '').split(',').map(value => value.trim().toLowerCase())).not.toContain('max-age=120');
        fixture.record('hosting.ui.cache-baseline', { runtime: kind, filename: css, cacheControl: cacheBaseline });
      }
      await ready(page, fixture.route('hosting'));
      await expect(main(page).getByRole('heading', { name: 'Barındırma ayarları', exact: true })).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByLabel('En büyük yükleme boyutu (MB)', { exact: true }).fill('2');
      await main(page).getByRole('button', { name: 'Yanıt başlığı ekle', exact: true }).click();
      const index = original.headers.length + 1;
      await page.getByLabel('Başlık ' + index + ' adı', { exact: true }).fill('X-YunPanel-T887');
      await page.getByLabel('Başlık ' + index + ' değeri', { exact: true }).fill(headerValue);
      // PHP gained static-cache controls after the retired October scenario.
      if (['php', 'static'].includes(kind)) await page.getByLabel('Statik dosya önbelleği (saniye)', { exact: true }).fill('120');
      else await expect(page.getByLabel('Statik dosya önbelleği (saniye)', { exact: true })).toHaveCount(0);
      if (kind === 'static') await page.getByRole('checkbox', { name: 'Bulunamayan sayfalarda index.html kullan', exact: true }).uncheck();
      else await expect(page.getByRole('checkbox', { name: 'Bulunamayan sayfalarda index.html kullan', exact: true })).toHaveCount(0);
      await expect(page.getByLabel('Uygulama yanıt süresi (saniye)', { exact: true })).toHaveCount(0);
      const offset = page.auditTraffic.length;
      const stageResponse = page.waitForResponse(response => new URL(response.url()).pathname === domainPath(fixture) + '/stage' && response.request().method() === 'POST', { timeout: 120000 }).catch(error => ({ transportError: error }));
      await main(page).getByRole('button', { name: 'Kaydet ve uygula', exact: true }).click();
      const staged = await stageResponse; if (staged.transportError) throw staged.transportError;
      const stageBody = await staged.json();
      fixture.record('hosting.ui.stage-response', { runtime: kind, status: staged.status(), errorCode: stageBody.error?.code ?? null });
      expect(staged.status(), stageBody.error?.code).toBe(202);
      await expect(main(page).getByRole('status').filter({ hasText: 'Barındırma ayarları uygulandı.' })).toBeVisible({ timeout: 120000 });
      const root = domainPath(fixture), mutations = page.auditTraffic.slice(offset).filter(entry => entry.method !== 'GET' && entry.path.startsWith(root));
      for (const endpoint of ['/update-preview', '', '/stage', '/activate']) expect(mutations.filter(entry => entry.path === root + endpoint)).toHaveLength(1);
      const saved = await currentDomain(fixture); expect(saved.nginxSettings.clientMaxBodySizeMb).toBe(2);
      expect(saved.appliedRevision).toBe(saved.desiredRevision);
      expect(saved.nginxSettings.headers.at(-1)).toEqual({ name: 'X-YunPanel-T887', value: headerValue, always: true });
      const home = await fixture.http('/'); expect(home.status).toBe(200); expect(home.headers['x-yunpanel-t887']).toBe(headerValue);
      const oversized = await fixture.http('/', { method: 'POST', body: Buffer.alloc(3 * 1024 * 1024, 'x') });
      expect(oversized.status).toBe(413); expect(oversized.headers['x-yunpanel-t887']).toBe(headerValue);
      if (kind === 'static') expect((await fixture.http('/yp-t887-missing-' + headerValue)).status).toBe(404);
      if (['php', 'static'].includes(kind)) {
        const asset = await fixture.http('/' + css); expect(asset.status).toBe(200); expect(asset.body).toBe(cssBody);
        expect(asset.headers['cache-control']).toContain('max-age=120');
      }
      await page.reload(); await expect(page.getByLabel('En büyük yükleme boyutu (MB)', { exact: true })).toHaveValue('2');
      expect(page.auditErrors).toEqual([]); fixture.record('hosting.ui.http', { runtime: kind, verified: true, phpCacheEvolution: kind === 'php' });
    } catch (error) { failure = error; }
    for (const cleanup of [() => publish(fixture, original), ...(css && cacheBaseline !== undefined ? [async () => {
      const restored = await fixture.http('/' + css);
      expect(restored.status).toBe(200); expect(restored.body).toBe(cssBody);
      expect(restored.headers['cache-control'] ?? null).toBe(cacheBaseline);
      expect(restored.headers['x-yunpanel-t887'] ?? null).toBeNull();
      fixture.record('hosting.ui.cache-restored', { runtime: kind, filename: css, cacheControl: restored.headers['cache-control'] ?? null, verified: true });
    }] : []), ...(css ? [() => fixture.deleteFile(css)] : [])]) {
      try { await cleanup(); }
      catch (error) { fixture.record('hosting.ui.cleanup-failure', { runtime: kind, errorKind: error.name, errorCode: error.code ?? null }); failure ??= error; }
    }
    if (failure) throw failure;
  });

  for (const width of [320, 390, 834, 1440]) test('@mutation hosting settings retain one reachable form at width ' + width, async ({ page }) => {
    test.setTimeout(240000); const fixture = await site('php'); await page.setViewportSize({ width, height: 1000 });
    await ready(page, fixture.route('hosting'));
    await expect(main(page).getByRole('heading', { name: 'Barındırma ayarları', exact: true })).toBeVisible();
    await expect(page.getByLabel('En büyük yükleme boyutu (MB)', { exact: true })).toBeVisible();
    await expect(main(page).getByRole('button', { name: 'Kaydet ve uygula', exact: true })).toHaveCount(1);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    expect(page.auditErrors).toEqual([]);
  });

  test('@mutation hosting rejects protocol-managed headers before any preview or write request', async ({ page }) => {
    test.setTimeout(240000); const fixture = await site('php'); await ready(page, fixture.route('hosting'));
    const current = await currentDomain(fixture), index = current.nginxSettings.headers.length + 1;
    await main(page).getByRole('button', { name: 'Yanıt başlığı ekle', exact: true }).click();
    await page.getByLabel('Başlık ' + index + ' adı', { exact: true }).fill('Set-Cookie');
    await page.getByLabel('Başlık ' + index + ' değeri', { exact: true }).fill('invalid=blocked');
    const offset = page.auditTraffic.length;
    await main(page).getByRole('button', { name: 'Kaydet ve uygula', exact: true }).click();
    await expect(main(page).getByRole('alert')).toContainText('Web sunucusu ayarlarını kontrol edin');
    expect(page.auditTraffic.slice(offset).filter(entry => entry.method === 'PATCH' || /\/(?:update-preview|stage|activate)$/.test(entry.path))).toEqual([]);
    expect((await currentDomain(fixture)).nginxSettings).toEqual(current.nginxSettings); expect(page.auditErrors).toEqual([]);
  });
});
