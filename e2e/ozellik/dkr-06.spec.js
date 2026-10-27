import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('DKR-06 Container yapılandırma yedeği ile volume verisi yedeğinin ayrımı', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240000);

  const agentN = process.env.AGENT_N || '3';
  const timestamp = Date.now().toString(36);
  const projectName = `tdkr06_a${agentN}_${timestamp}`;
  const hostPort = 18400 + (parseInt(agentN, 10) * 20) + Math.floor(Math.random() * 15);
  const volumeName = `${projectName}_data`;

  let createdProjectId = null;

  function runSsh(command) {
    try {
      return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
        encoding: 'utf8',
        timeout: 25000,
      }).trim();
    } catch (err) {
      return ((err.stdout || '') + (err.stderr || '')).trim();
    }
  }

  function waitForContainerState(filterName, expectedStatus, maxAttempts = 35, intervalMs = 2000) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const output = runSsh(`docker ps -a --filter "name=${filterName}" --format "{{.Names}} {{.Status}}"`);
      if (expectedStatus === 'absent' && (!output || !output.includes(filterName))) {
        return { success: true, output };
      }
      if (expectedStatus === 'running' && output.includes('Up')) {
        return { success: true, output };
      }
      execSync(`sleep ${intervalMs / 1000}`);
    }
    const finalCheck = runSsh(`docker ps -a --filter "name=${filterName}" --format "{{.Names}} {{.Status}}"`);
    return { success: false, output: finalCheck };
  }

  async function confirmLifecycleAction(page, actionKey) {
    const modal = page.locator('.ws-modal').filter({ hasText: `Docker Compose ${actionKey}` });
    await expect(modal).toBeVisible({ timeout: 15000 });

    const confirmStr = await modal.locator('label strong').textContent();
    expect(confirmStr).toBeTruthy();

    const input = modal.locator('input');
    await input.fill(confirmStr);

    const confirmBtn = modal.locator('button:has-text("İşi sıraya al")');
    await expect(confirmBtn).toBeEnabled({ timeout: 10000 });
    await confirmBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 15000 });
  }

  test.beforeEach(async ({ page }) => {
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    } catch {
      const retryBtn = page.locator('button:has-text("Tekrar dene")');
      if (await retryBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await retryBtn.click();
      }
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    }
  });

  test.afterAll(async () => {
    if (projectName) {
      runSsh(`docker stop ${projectName}-web-1 ${projectName}_web_1 2>/dev/null || true`);
      runSsh(`docker rm -f ${projectName}-web-1 ${projectName}_web_1 2>/dev/null || true`);
      runSsh(`docker compose -p ${projectName} down --volumes --remove-orphans 2>/dev/null || true`);
      runSsh(`docker volume rm -f ${volumeName} ${projectName}_${volumeName} 2>/dev/null || true`);
    }
  });

  test('hatalı girdi: storage-backup API geçersiz sorgu parametrelerini reddeder ve olmayan projede 404 döner', async ({ page }) => {
    // 1. Olmayan fakat formatı geçerli v4 UUID sorgusunda 404 docker_compose_project_not_found dönmeli
    const notFoundRes = await page.request.get('/api/panel/docker/projects/e0000000-0000-4000-8000-000000000000/storage-backup');
    expect(notFoundRes.status()).toBe(404);
    const notFoundBody = await notFoundRes.json();
    expect(notFoundBody?.error?.code).toBe('docker_compose_project_not_found');

    // 2. Geçersiz UUID formatı için 400 invalid_docker_project_id dönmeli
    const invalidIdRes = await page.request.get('/api/panel/docker/projects/not-a-uuid/storage-backup');
    expect(invalidIdRes.status()).toBe(400);
    const invalidIdBody = await invalidIdRes.json();
    expect(invalidIdBody?.error?.code).toBe('invalid_docker_project_id');

    // 3. Query parametresi verildiğinde 400 docker_storage_backup_query_invalid dönmeli
    const invalidQueryRes = await page.request.get('/api/panel/docker/projects/e0000000-0000-4000-8000-000000000000/storage-backup?unsupported=filter');
    expect(invalidQueryRes.status()).toBe(400);
    const invalidQueryBody = await invalidQueryRes.json();
    expect(invalidQueryBody?.error?.code).toBe('docker_storage_backup_query_invalid');
  });

  test('mutlu yol: Docker projesinde depolama manifesti ve volume veri katmanının incelenmesi', async ({ page }) => {
    await page.goto('/docker');
    await expect(page.locator('h1')).toContainText('Docker', { timeout: 15000 });

    // 1. Named volume ve ephemeral storage içeren Compose projesi oluştur
    const addBtn = page.locator('button:has-text("Compose projesi ekle"), button:has-text("Compose / Stack Ekle")').first();
    await expect(addBtn).toBeVisible({ timeout: 10000 });
    await addBtn.click();

    const modal = page.locator('.ws-modal').filter({ hasText: 'Docker Compose projesi ekle' });
    await expect(modal).toBeVisible({ timeout: 5000 });

    const nameInput = modal.locator('label:has-text("Proje adı") input');
    await nameInput.fill(projectName);

    const composeContent = [
      'services:',
      '  web:',
      '    image: nginx:alpine',
      '    restart: unless-stopped',
      '    ports:',
      `      - "127.0.0.1:${hostPort}:80"`,
      '    environment:',
      '      - APP_NAME=DKR06_STORAGE_TEST',
      '    volumes:',
      `      - ${volumeName}:/data`,
      '      - type: tmpfs',
      '        target: /tmpfs-cache',
      'volumes:',
      `  ${volumeName}:`,
    ].join('\n');

    const docTextarea = modal.locator('label:has-text("Compose document") textarea');
    await docTextarea.fill(composeContent);

    const validateBtn = modal.locator('button:has-text("Validate")');
    await expect(validateBtn).toBeEnabled({ timeout: 5000 });
    await validateBtn.click();
    await expect(modal.locator('dt:has-text("Servis")')).toBeVisible({ timeout: 10000 });

    const submitBtn = modal.locator('button:has-text("Projeyi kaydet")');
    await expect(submitBtn).toBeEnabled({ timeout: 5000 });
    await submitBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 15000 });

    // 2. Proje detay sayfasına git
    await page.waitForURL(/\/docker\/[^/]+/, { timeout: 15000 });
    const currentUrl = page.url();
    const match = currentUrl.match(/\/docker\/([^/?#]+)/);
    createdProjectId = match ? decodeURIComponent(match[1]) : null;
    expect(createdProjectId).toBeTruthy();

    await expect(page.locator('h1')).toContainText(projectName, { timeout: 15000 });

    // 3. UI Depolama Paneli (StoragePanel) doğrulaması
    const storageSection = page.locator('section').filter({ has: page.locator('h2:text-is("Depolama")') });
    await expect(storageSection).toBeVisible({ timeout: 15000 });

    // Manifest sürümü ve dahil/hariç sayıları
    await expect(storageSection.locator('dt:has-text("Manifest") + dd')).toContainText('v1');
    await expect(storageSection.locator('dt:has-text("Dahil") + dd')).toContainText('1');
    await expect(storageSection.locator('dt:has-text("Backup dışı") + dd')).toContainText('1');

    // Depolama tablosunda named volume ve ephemeral satırları
    const table = storageSection.locator('table.ws-table');
    await expect(table).toBeVisible();
    await expect(table.locator(`text=${volumeName}`)).toBeVisible();
    await expect(table.locator('text=Manifest\'e dahil')).toBeVisible();
    await expect(table.locator('text=Backup dışı')).toBeVisible();

    // 4. Konteyneri başlat ve fiziksel volume varlığını doğrula
    const lifecycleSection = page.locator('section').filter({ has: page.locator('h2:text-is("Lifecycle")') });
    await expect(lifecycleSection).toBeVisible({ timeout: 15000 });

    const startBtn = lifecycleSection.locator('button:has-text("Başlat")');
    await expect(startBtn).toBeEnabled({ timeout: 15000 });
    await startBtn.click();

    await confirmLifecycleAction(page, 'start');

    // Fiziksel Kanıt 1: Container Up durumunda
    const runningCheck = waitForContainerState(projectName, 'running', 35, 2000);
    expect(runningCheck.success, `Container Up olmadı: ${runningCheck.output}`).toBe(true);

    const containerName = runSsh(`docker ps --filter "name=${projectName}" --format "{{.Names}}"`).split('\n')[0].trim();
    expect(containerName).toBeTruthy();

    // Fiziksel Kanıt 2: Docker volume host üzerinde fiziksel olarak oluşturuldu
    const volInspect = runSsh(`docker volume inspect ${volumeName} 2>/dev/null || docker volume inspect ${projectName}_${volumeName}`);
    expect(volInspect).toContain(volumeName);

    // Fiziksel Kanıt 3: Volume mount içine veri yaz ve kalıcılığı test et
    runSsh(`docker exec ${containerName} sh -c "echo 'dkr06_sample_content' > /data/persistence.txt"`);
    const readDataOutput = runSsh(`docker exec ${containerName} cat /data/persistence.txt`);
    expect(readDataOutput).toContain('dkr06_sample_content');

    // Fiziksel Kanıt 4: HTTP 200 / nginx cevabı
    const httpRes = runSsh(`curl -s -m 5 http://127.0.0.1:${hostPort}`);
    expect(httpRes).toContain('nginx');
  });

  test('Plesk Docker eşdeğerliği: Container yapılandırma yedeği ile volume verisi yedeğinin ayrımı ve seçilebilirliği', async ({ page }) => {
    test.fail(
      true,
      'BULGU DKR-06: Panelde Docker container yapılandırma (Compose YAML / env / port) yedeği ile volume verisi yedeğini bağımsız alan veya seçilebilir kılan yedekleme/geri yükleme aracı henüz mevcut değil',
    );

    await page.goto('/docker');
    await expect(page.locator('h1')).toContainText('Docker', { timeout: 15000 });

    if (createdProjectId) {
      await page.goto(`/docker/${encodeURIComponent(createdProjectId)}`);
      await expect(page.locator('h1')).toContainText(projectName, { timeout: 15000 });
    }

    // Plesk Docker eşdeğerliği:
    // Konteyner yapılandırması (Compose YAML / environment / port) yedeği ile
    // kalıcı volume verisi yedeğinin ayrı ayrı seçilebilmesi ("Yalnızca yapılandırma", "Yalnızca veriler", "Tümü").
    // Beklenen UI butonu / aracı: "Yedekleme ve Geri Yükleme" veya "Yapılandırma Yedeği Al" / "Volume Yedeği Al"
    const dockerBackupSection = page.locator('section').filter({ hasText: /Docker Yedekleme|Yedekleme ve Geri Yükleme/i });
    await expect(dockerBackupSection).toBeVisible({ timeout: 3000 });

    const configOnlyCheckbox = dockerBackupSection.locator('input[type="checkbox"][name*="config"], label:has-text("Container yapılandırması")');
    await expect(configOnlyCheckbox).toBeVisible({ timeout: 2000 });

    const volumeDataCheckbox = dockerBackupSection.locator('input[type="checkbox"][name*="volume"], label:has-text("Volume verisi")');
    await expect(volumeDataCheckbox).toBeVisible({ timeout: 2000 });
  });
});
