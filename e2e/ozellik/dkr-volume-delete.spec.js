import { test, expect } from '@playwright/test';
import {
  OWNER_USERNAME,
  OWNER_PASSWORD,
  loginAs,
  removeDockerProject,
} from '../helpers.js';
import { createTestHostProbe } from './test-host-probe.js';

test.use({ trace: 'off' });

test.describe('DKR-VOLUME-DELETE Default down volume koruma ve güvenli tekil volume silme', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  const agentN = process.env.AGENT_N || '1';
  const timestamp = Date.now().toString(36);

  // Fixture 1: default down volume koruma
  const project1Name = `tdkrvol1_a${agentN}_${timestamp}`;
  const volAName = `${project1Name}_vol_a`;
  const volBName = `${project1Name}_vol_b`;
  const markerA = `marker_a_${timestamp}`;
  const markerB = `marker_b_${timestamp}`;

  // Fixture 2: running/stopped reddi + tekil silme + diğerinin fiziksel korunumu
  const project2Name = `tdkrvol2_a${agentN}_${timestamp}`;
  const volDelName = `${project2Name}_vol_del`;
  const volKeepName = `${project2Name}_vol_keep`;
  const markerDel = `marker_del_${timestamp}`;
  const markerKeep = `marker_keep_${timestamp}`;

  const ownedVolumeNames = [volAName, volBName, volDelName, volKeepName];

  let hostProbe;
  let project1Id = null;
  let project1Removed = false;
  let project2Id = null;
  let project2Removed = false;

  function readComposePs(name) {
    const composeOut = hostProbe.runArgvStdout(['docker', 'compose', '-p', name, 'ps', '-a', '--format', '{{.Name}} {{.Service}} {{.Status}}']);
    if (composeOut) return composeOut;
    return hostProbe.runArgvStdout(['docker', 'ps', '-a', '--filter', `label=com.docker.compose.project=${name}`, '--format', '{{.Names}} {{.Status}}']);
  }

  function inspectVolumeAndMarker(volumeName, markerFile = 'marker.txt') {
    return hostProbe.runPythonJson(`import json,os,re,subprocess,sys
vol,fname=sys.argv[1],sys.argv[2]
assert re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}',vol)
assert re.fullmatch(r'[A-Za-z0-9_.-]{1,64}',fname)
r=subprocess.run(['docker','volume','inspect','--format','{{.Mountpoint}}',vol],capture_output=True,text=True,timeout=15)
if r.returncode!=0:
    print(json.dumps({'exists':False,'mountpoint':'','marker':''}))
    raise SystemExit(0)
mp=(r.stdout or '').strip()
p=os.path.join(mp,fname)
content=open(p,'r',encoding='utf-8',errors='replace').read().strip() if (mp and os.path.isfile(p)) else ''
print(json.dumps({'exists':True,'mountpoint':mp,'marker':content}))`, [volumeName, markerFile], { timeoutMs: 25_000 });
  }

  function writeMarkerViaExec(projectName, mountPath, markerValue) {
    return hostProbe.runPythonJson(`import json,re,subprocess,sys
proj,mpath,val=sys.argv[1],sys.argv[2],sys.argv[3]
assert re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,62}',proj)
assert mpath.startswith('/') and '..' not in mpath.split('/')
cid_res=subprocess.run(
    ['docker','ps','-q','--filter',f'label=com.docker.compose.project={proj}'],
    capture_output=True,text=True,timeout=15
)
cids=[line.strip() for line in (cid_res.stdout or '').splitlines() if line.strip()]
assert len(cids)>=1, 'No running container for project'
exec_res=subprocess.run(
    ['docker','exec',cids[0],'sh','-c','printf "%s" "$1" > "$2/marker.txt"','_',val,mpath],
    capture_output=True,text=True,timeout=15
)
assert exec_res.returncode==0, f'docker exec failed: {exec_res.stderr}'
print(json.dumps({'written':True,'containerId':cids[0]}))`, [projectName, mountPath, markerValue], { timeoutMs: 25_000 });
  }

  function removeOwnedVolumeIfPresent(volumeName) {
    return hostProbe.runPythonJson(`import json,re,subprocess,sys
vol=sys.argv[1]
assert re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}',vol)
check=subprocess.run(['docker','volume','inspect',vol],capture_output=True,text=True,timeout=15)
if check.returncode!=0:
    print(json.dumps({'removed':True,'wasPresent':False}))
    raise SystemExit(0)
rm_res=subprocess.run(['docker','volume','rm',vol],capture_output=True,text=True,timeout=20)
print(json.dumps({'removed':rm_res.returncode==0,'wasPresent':True,'rc':rm_res.returncode}))`, [volumeName], { timeoutMs: 25_000 });
  }

  async function confirmLifecycleAction(page, actionKey) {
    const modal = page.locator('.ws-modal').filter({ hasText: `Docker Compose ${actionKey}` });
    await expect(modal).toBeVisible({ timeout: 15_000 });
    const confirmStr = await modal.locator('label strong').textContent();
    expect(confirmStr).toBeTruthy();
    await modal.locator('input').fill(confirmStr);
    const confirmBtn = modal.locator('button:has-text("İşi sıraya al")');
    await expect(confirmBtn).toBeEnabled({ timeout: 10_000 });
    await confirmBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 15_000 });
  }

  async function createProjectViaUi(page, name, composeYaml) {
    await page.goto('/docker');
    await expect(page.locator('h1')).toContainText('Docker', { timeout: 15_000 });

    const addBtn = page.locator('button:has-text("Compose projesi ekle"), button:has-text("Compose / Stack Ekle")').first();
    await expect(addBtn).toBeVisible({ timeout: 10_000 });
    await addBtn.click();

    const modal = page.locator('.ws-modal').filter({ hasText: 'Docker Compose projesi ekle' });
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await modal.locator('label:has-text("Proje adı") input').fill(name);
    await modal.locator('label:has-text("Compose document") textarea').fill(composeYaml);
    await modal.locator('button:has-text("Validate")').click();
    await expect(modal.locator('dt:has-text("Servis")')).toBeVisible({ timeout: 15_000 });

    const saveBtn = modal.locator('button:has-text("Projeyi kaydet")');
    await expect(saveBtn).toBeEnabled({ timeout: 10_000 });
    await saveBtn.click();

    await page.waitForURL(/\/docker\/[^/]+/, { timeout: 20_000 });
    const urlMatch = page.url().match(/\/docker\/([^/?#]+)/);
    const projectId = urlMatch ? decodeURIComponent(urlMatch[1]) : null;
    expect(projectId).toBeTruthy();
    await expect(page.locator('h1')).toContainText(name, { timeout: 15_000 });
    return projectId;
  }

  async function getPanelCsrfHeaders(request) {
    const sessionRes = await request.get('/api/auth/session');
    expect(sessionRes.ok()).toBe(true);
    const origin = new URL(sessionRes.url()).origin;
    const csrfToken = (await sessionRes.json())?.data?.csrfToken;
    expect(csrfToken).toBeTruthy();
    return { Origin: origin, 'x-csrf-token': csrfToken };
  }

  test.beforeAll(() => {
    hostProbe = createTestHostProbe();
    expect(hostProbe.verifyTarget().verified).toBe(true);
  });

  test.beforeEach(async ({ page }) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        await page.goto('/');
        const retryBtn = page.locator('button:has-text("Tekrar dene")');
        if (await retryBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
          await retryBtn.click();
        }
      }
    }
  });

  test.afterAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const cleanupErrors = [];

    const projectsToClean = [
      { id: project1Id, name: project1Name, removed: project1Removed },
      { id: project2Id, name: project2Name, removed: project2Removed },
    ].filter((entry) => !entry.removed && (entry.id || entry.name));

    if (projectsToClean.length > 0) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        for (const entry of projectsToClean) {
          try {
            await removeDockerProject(page, entry.id, entry.name);
            if (entry.id) {
              expect((await page.request.get(`/api/panel/docker/projects/${encodeURIComponent(entry.id)}`)).status()).toBe(404);
            }
            expect(readComposePs(entry.name)).toBe('');
          } catch (err) {
            cleanupErrors.push(`Docker project cleanup failed (${entry.name}): ${err.message}`);
          }
        }
      } finally {
        await context.close().catch(() => {});
      }
    }

    // Yalnız bu testin oluşturduğu sahipli volume'ları temizle; mevcut host volume'larına dokunma.
    for (const volumeName of ownedVolumeNames) {
      try {
        const res = removeOwnedVolumeIfPresent(volumeName);
        if (!res.removed) {
          cleanupErrors.push(`Owned test volume removal failed (${volumeName}, rc=${res.rc})`);
        }
        const after = inspectVolumeAndMarker(volumeName);
        if (after.exists) {
          cleanupErrors.push(`Owned test volume still present after cleanup (${volumeName})`);
        }
      } catch (err) {
        cleanupErrors.push(`Owned test volume cleanup error (${volumeName}): ${err.message}`);
      }
    }

    expect(cleanupErrors, 'DKR-VOLUME-DELETE owned project and volume cleanup must succeed').toEqual([]);
  });

  test('Fixture 1: default Projeyi kaldır (down) işlemi sahipli named volume ve marker verilerini fiziksel olarak korur', async ({ page }) => {
    const composeYaml = [
      'services:',
      '  app:',
      '    image: nginx:alpine',
      '    volumes:',
      '      - vol_a:/data_a',
      '      - vol_b:/data_b',
      'volumes:',
      '  vol_a: {}',
      '  vol_b: {}',
      '',
    ].join('\n');

    project1Id = await createProjectViaUi(page, project1Name, composeYaml);

    const lifecycleSection = page.locator('section').filter({ has: page.locator('h2:text-is("Lifecycle")') });
    await expect(lifecycleSection).toBeVisible({ timeout: 15_000 });
    const startBtn = lifecycleSection.locator('button:has-text("Başlat")');
    await expect(startBtn).toBeEnabled({ timeout: 15_000 });
    await startBtn.click();
    await confirmLifecycleAction(page, 'start');

    await expect.poll(() => readComposePs(project1Name), {
      timeout: 60_000,
      intervals: [1500, 3000],
    }).toContain('Up');

    writeMarkerViaExec(project1Name, '/data_a', markerA);
    writeMarkerViaExec(project1Name, '/data_b', markerB);

    expect(inspectVolumeAndMarker(volAName)).toMatchObject({ exists: true, marker: markerA });
    expect(inspectVolumeAndMarker(volBName)).toMatchObject({ exists: true, marker: markerB });

    // Panelden Projeyi kaldır (default docker compose down --remove-orphans)
    await page.reload();
    await expect(lifecycleSection).toBeVisible({ timeout: 15_000 });
    const removeBtn = lifecycleSection.locator('button:has-text("Projeyi kaldır")');
    await expect(removeBtn).toBeEnabled({ timeout: 35_000 });
    await removeBtn.click();
    await confirmLifecycleAction(page, 'remove');

    await expect.poll(async () => {
      const res = await page.request.get(`/api/panel/docker/projects/${encodeURIComponent(project1Id)}`);
      return res.status();
    }, { timeout: 60_000, intervals: [1500, 2500] }).toBe(404);

    await expect.poll(() => readComposePs(project1Name), {
      timeout: 30_000,
      intervals: [1000, 2000],
    }).toBe('');
    project1Removed = true;

    // Her iki volume ve marker dosyaları host'ta fiziksel olarak korunmuş olmalı
    expect(inspectVolumeAndMarker(volAName)).toMatchObject({ exists: true, marker: markerA });
    expect(inspectVolumeAndMarker(volBName)).toMatchObject({ exists: true, marker: markerB });
  });

  test('Fixture 2: çalışan ve durmuş konteyner bağlıyken reddedilir; ayrılan tekil volume panelden kalıcı silinir ve diğer volume fiziksel olarak korunur', async ({ page }) => {
    const initialYaml = [
      'services:',
      '  app:',
      '    image: nginx:alpine',
      '    volumes:',
      '      - vol_del:/data_del',
      '      - vol_keep:/data_keep',
      'volumes:',
      '  vol_del: {}',
      '  vol_keep: {}',
      '',
    ].join('\n');

    project2Id = await createProjectViaUi(page, project2Name, initialYaml);

    const lifecycleSection = page.locator('section').filter({ has: page.locator('h2:text-is("Lifecycle")') });
    await expect(lifecycleSection).toBeVisible({ timeout: 15_000 });
    const startBtn = lifecycleSection.locator('button:has-text("Başlat")');
    await expect(startBtn).toBeEnabled({ timeout: 15_000 });
    await startBtn.click();
    await confirmLifecycleAction(page, 'start');

    await expect.poll(() => readComposePs(project2Name), {
      timeout: 60_000,
      intervals: [1500, 3000],
    }).toContain('Up');

    writeMarkerViaExec(project2Name, '/data_del', markerDel);
    writeMarkerViaExec(project2Name, '/data_keep', markerKeep);
    expect(inspectVolumeAndMarker(volDelName)).toMatchObject({ exists: true, marker: markerDel });
    expect(inspectVolumeAndMarker(volKeepName)).toMatchObject({ exists: true, marker: markerKeep });

    const volumesSection = page.locator('section').filter({ has: page.locator('h2:text-is("Kalıcı volume yönetimi")') });

    // 1. Running referansı: UI Kullanımda + Sil butonu yok, API delete-preview 409 docker_volume_in_use
    await page.reload();
    await expect(volumesSection).toBeVisible({ timeout: 15_000 });
    const runningDelRow = volumesSection.locator('tbody tr').filter({ hasText: volDelName });
    const runningKeepRow = volumesSection.locator('tbody tr').filter({ hasText: volKeepName });
    await expect(runningDelRow).toContainText('Kullanımda', { timeout: 15_000 });
    await expect(runningKeepRow).toContainText('Kullanımda', { timeout: 15_000 });
    await expect(volumesSection.locator('button:text-is("Sil")')).toHaveCount(0);

    const runningPreviewRes = await page.request.post(
      `/api/panel/docker/projects/${encodeURIComponent(project2Id)}/volumes/delete-preview`,
      { headers: await getPanelCsrfHeaders(page.request), data: { volumeKey: 'vol_del' } },
    );
    expect(runningPreviewRes.status()).toBe(409);
    expect((await runningPreviewRes.json())?.error?.code).toBe('docker_volume_in_use');

    // 2. Stopped referansı: Durdur sonrası da UI Kullanımda + Sil yok, API delete-preview 409 docker_volume_in_use
    const stopBtn = lifecycleSection.locator('button:has-text("Durdur")');
    await expect(stopBtn).toBeEnabled({ timeout: 35_000 });
    await stopBtn.click();
    await confirmLifecycleAction(page, 'stop');

    await expect.poll(() => {
      const out = readComposePs(project2Name);
      return !out.includes('Up') && (out.includes('Exited') || out.includes('Created') || out.includes('Stop'));
    }, { timeout: 60_000, intervals: [1500, 2500] }).toBe(true);

    await page.reload();
    await expect(volumesSection).toBeVisible({ timeout: 15_000 });
    await expect(volumesSection.locator('tbody tr').filter({ hasText: volDelName })).toContainText('Kullanımda', { timeout: 15_000 });
    await expect(volumesSection.locator('tbody tr').filter({ hasText: volKeepName })).toContainText('Kullanımda', { timeout: 15_000 });
    await expect(volumesSection.locator('button:text-is("Sil")')).toHaveCount(0);

    const stoppedPreviewRes = await page.request.post(
      `/api/panel/docker/projects/${encodeURIComponent(project2Id)}/volumes/delete-preview`,
      { headers: await getPanelCsrfHeaders(page.request), data: { volumeKey: 'vol_del' } },
    );
    expect(stoppedPreviewRes.status()).toBe(409);
    expect((await stoppedPreviewRes.json())?.error?.code).toBe('docker_volume_in_use');

    // 3. vol_del volume'unu Compose YAML güncellemesiyle (PUT) ayır ve projeyi yeniden başlat
    const detailBeforePut = await page.request.get(`/api/panel/docker/projects/${encodeURIComponent(project2Id)}`);
    expect(detailBeforePut.status()).toBe(200);
    const currentRevision = (await detailBeforePut.json()).data.project.revision;

    const detachedYaml = [
      'services:',
      '  app:',
      '    image: nginx:alpine',
      '    volumes:',
      '      - vol_keep:/data_keep',
      'volumes:',
      '  vol_keep: {}',
      '',
    ].join('\n');

    const putRes = await page.request.put(
      `/api/panel/docker/projects/${encodeURIComponent(project2Id)}`,
      {
        headers: await getPanelCsrfHeaders(page.request),
        data: { expectedRevision: currentRevision, document: detachedYaml },
      },
    );
    expect(putRes.status()).toBe(200);

    await page.reload();
    await expect(lifecycleSection).toBeVisible({ timeout: 15_000 });
    const restartBtn = lifecycleSection.locator('button:has-text("Başlat")');
    await expect(restartBtn).toBeEnabled({ timeout: 35_000 });
    await restartBtn.click();
    await confirmLifecycleAction(page, 'start');

    await expect.poll(() => readComposePs(project2Name), {
      timeout: 60_000,
      intervals: [1500, 3000],
    }).toContain('Up');

    // Silme öncesinde her iki marker da host'ta hâlâ fiziksel olarak mevcut olmalı
    expect(inspectVolumeAndMarker(volDelName)).toMatchObject({ exists: true, marker: markerDel });
    expect(inspectVolumeAndMarker(volKeepName)).toMatchObject({ exists: true, marker: markerKeep });

    // 4. Panel UI DockerVolumesPanel içinden yalnız vol_del satırını kalıcı olarak sil
    await page.reload();
    await expect(volumesSection).toBeVisible({ timeout: 15_000 });

    const delRow = volumesSection.locator('tbody tr').filter({ hasText: volDelName });
    const keepRow = volumesSection.locator('tbody tr').filter({ hasText: volKeepName });
    await expect(delRow).toContainText('Silinebilir', { timeout: 20_000 });
    await expect(keepRow).toContainText('Kullanımda', { timeout: 20_000 });
    await expect(keepRow.locator('button:text-is("Sil")')).toHaveCount(0);

    const deleteSingleBtn = delRow.locator('button:text-is("Sil")');
    await expect(deleteSingleBtn).toBeEnabled({ timeout: 30_000 });
    await deleteSingleBtn.click();

    const confirmModal = page.locator('.ws-modal').filter({ hasText: 'Volume kaydını kalıcı olarak sil' });
    await expect(confirmModal).toBeVisible({ timeout: 15_000 });
    await expect(confirmModal).toContainText(volDelName);
    await expect(confirmModal).toContainText(/kalıcı/i);

    const confirmStr = await confirmModal.locator('label strong').textContent();
    expect(confirmStr).toBeTruthy();
    await confirmModal.locator('input').fill(confirmStr);

    const confirmDeleteBtn = confirmModal.locator('button:has-text("Kalıcı olarak sil")');
    await expect(confirmDeleteBtn).toBeEnabled({ timeout: 10_000 });
    await confirmDeleteBtn.click();
    await expect(confirmModal).not.toBeVisible({ timeout: 20_000 });

    // 5. Fiziksel sonuç: vol_del tamamen silindi; vol_keep ve marker_keep fiziksel olarak korundu
    await expect.poll(() => inspectVolumeAndMarker(volDelName).exists, {
      timeout: 60_000,
      intervals: [1500, 2500],
    }).toBe(false);

    expect(inspectVolumeAndMarker(volKeepName)).toMatchObject({ exists: true, marker: markerKeep });

    // UI yenilemesinde vol_del artık listelenmez, vol_keep Kullanımda olarak kalır
    await page.reload();
    await expect(volumesSection).toBeVisible({ timeout: 15_000 });
    await expect(volumesSection.locator('tbody tr').filter({ hasText: volDelName })).toHaveCount(0, { timeout: 15_000 });
    await expect(volumesSection.locator('tbody tr').filter({ hasText: volKeepName })).toContainText('Kullanımda', { timeout: 15_000 });
  });
});
