import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('DKR-03 Port, environment, volume ve restart politikası', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240000);

  const agentN = process.env.AGENT_N || '3';
  const timestamp = Date.now().toString(36);
  const projectName = `tdkr03_a${agentN}_${timestamp}`;
  const hostPort = 18300 + (parseInt(agentN, 10) * 20) + Math.floor(Math.random() * 15);
  const volumeName = `${projectName}_data`;

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

  async function confirmEnvReplace(page) {
    const modal = page.locator('.ws-modal').filter({ hasText: 'Compose environment’ın tamamını değiştir' });
    await expect(modal).toBeVisible({ timeout: 15000 });

    const confirmStr = await modal.locator('label strong').textContent();
    expect(confirmStr).toBeTruthy();

    const input = modal.locator('input');
    await input.fill(confirmStr);

    const confirmBtn = modal.locator('button:has-text("Değişikliği uygula")');
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

  test('hatalı girdi: geçersiz environment formatı reddedilir', async ({ page }) => {
    await page.goto('/docker');
    await expect(page.locator('h1')).toContainText('Docker', { timeout: 15000 });

    const addBtn = page.locator('button:has-text("Compose projesi ekle"), button:has-text("Compose / Stack Ekle")').first();
    await expect(addBtn).toBeVisible({ timeout: 10000 });
    await addBtn.click();

    const modal = page.locator('.ws-modal').filter({ hasText: 'Docker Compose projesi ekle' });
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Hatalı compose YAML: sözdizimi bozuk port veya env formatı
    const nameInput = modal.locator('label:has-text("Proje adı") input');
    await nameInput.fill(`inv_env_${timestamp}`);

    const docTextarea = modal.locator('label:has-text("Compose document") textarea');
    await docTextarea.fill(`services:\n  bad:\n    image: nginx:alpine\n    ports:\n      - "invalid_port_spec"\n`);

    const validateBtn = modal.locator('button:has-text("Validate")');
    await expect(validateBtn).toBeEnabled({ timeout: 5000 });
    await validateBtn.click();
    const notice = modal.locator('.ws-notice-warn, [role="alert"]');
    await expect(notice).toBeVisible({ timeout: 10000 });

    const cancelBtn = modal.locator('button:has-text("Vazgeç")');
    await cancelBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 5000 });
  });

  test('mutlu yol: port, environment, volume ve restart politikası ile container yönetimi ve fiziksel denetim', async ({ page }) => {
    await page.goto('/docker');
    await expect(page.locator('h1')).toContainText('Docker', { timeout: 15000 });

    // 1. Proje Ekleme
    const addBtn = page.locator('button:has-text("Compose projesi ekle"), button:has-text("Compose / Stack Ekle")').first();
    await expect(addBtn).toBeVisible({ timeout: 10000 });
    await addBtn.click();

    const modal = page.locator('.ws-modal').filter({ hasText: 'Docker Compose projesi ekle' });
    await expect(modal).toBeVisible({ timeout: 5000 });

    const nameInput = modal.locator('label:has-text("Proje adı") input');
    await nameInput.fill(projectName);

    // DKR-03 Konfigürasyonu:
    // - Port mapping: hostPort -> 80
    // - Environment: APP_FEATURE=DKR03_VERIFIED & INITIAL_ENV=PORT_ENV_VOL_TEST
    // - Volume: named volume (web_data -> /usr/share/nginx/html)
    // - Restart policy: unless-stopped
    const composeContent = [
      'services:',
      '  web:',
      '    image: nginx:alpine',
      '    restart: unless-stopped',
      '    ports:',
      `      - "${hostPort}:80"`,
      '    environment:',
      '      - APP_FEATURE=DKR03_VERIFIED',
      '      - INITIAL_ENV=PORT_ENV_VOL_TEST',
      '    volumes:',
      `      - ${volumeName}:/usr/share/nginx/html`,
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

    // Proje detay sayfasına yönlen
    await page.waitForURL(/\/docker\/[^/]+/, { timeout: 15000 });
    await expect(page.locator('h1')).toContainText(projectName, { timeout: 15000 });

    // 2. UI Konfigürasyon Doğrulamaları
    // a) Port Eşlemesi doğrulaması
    const desiredStateSection = page.locator('section').filter({ has: page.locator('h2:text-is("Desired state")') });
    await expect(desiredStateSection).toBeVisible({ timeout: 10000 });
    await expect(desiredStateSection).toContainText(`Inner: 80/tcp`);
    await expect(desiredStateSection).toContainText(`Outer: 127.0.0.1:${hostPort}`);

    // b) Depolama (Volume) doğrulaması
    const storageSection = page.locator('section').filter({ has: page.locator('h2:text-is("Depolama")') });
    await expect(storageSection).toBeVisible({ timeout: 10000 });
    await expect(storageSection).toContainText('Named volume');
    await expect(storageSection).toContainText(volumeName);
    await expect(storageSection).toContainText('/usr/share/nginx/html');

    // 3. Projeyi Başlat (Lifecycle: Start)
    const lifecycleSection = page.locator('section').filter({ has: page.locator('h2:text-is("Lifecycle")') });
    await expect(lifecycleSection).toBeVisible({ timeout: 10000 });

    const startBtn = lifecycleSection.locator('button:has-text("Başlat")');
    await expect(startBtn).toBeVisible({ timeout: 10000 });
    await startBtn.click();

    await confirmLifecycleAction(page, 'start');

    // Container'ın ayağa kalkmasını bekle
    const runningResult = waitForContainerState(projectName, 'running', 35, 2000);
    expect(runningResult.success, `Container Up durumuna geçmedi: ${runningResult.output}`).toBe(true);

    // Container adını bul
    const containerName = runSsh(`docker ps --filter "name=${projectName}" --format "{{.Names}}"`).split('\n')[0].trim();
    expect(containerName).toBeTruthy();

    // 4. SSH üzerinden Fiziksel Doğrulamalar (docker inspect)
    // a) Port Mapping fiziksel kontrolü
    const portsJson = runSsh(`docker inspect ${containerName} --format '{{json .NetworkSettings.Ports}}'`);
    expect(portsJson).toContain('80/tcp');
    expect(portsJson).toContain(String(hostPort));

    // HTTP cevabı kontrolü (host üzerinden curl)
    const httpCheck = runSsh(`curl -sS http://127.0.0.1:${hostPort}/`);
    expect(httpCheck).toContain('nginx');

    // b) Environment Variables fiziksel kontrolü
    const envJson = runSsh(`docker inspect ${containerName} --format '{{json .Config.Env}}'`);
    expect(envJson).toContain('APP_FEATURE=DKR03_VERIFIED');
    expect(envJson).toContain('INITIAL_ENV=PORT_ENV_VOL_TEST');

    // c) Volume / Disk Mounts fiziksel kontrolü
    const mountsJson = runSsh(`docker inspect ${containerName} --format '{{json .Mounts}}'`);
    expect(mountsJson).toContain('volume');
    expect(mountsJson).toContain('/usr/share/nginx/html');
    expect(mountsJson).toContain(volumeName);

    // Volume içine fiziksel dosya yazma ve HTTP üzerinden teyit etme
    const testFileName = `test_${timestamp}.html`;
    const testFileContent = `YunPanel_DKR03_Volume_Integration_Test_${timestamp}`;
    runSsh(`docker exec ${containerName} sh -c "echo '${testFileContent}' > /usr/share/nginx/html/${testFileName}"`);

    const fileHttpContent = runSsh(`curl -sS http://127.0.0.1:${hostPort}/${testFileName}`);
    expect(fileHttpContent).toContain(testFileContent);

    // d) Restart Policy fiziksel kontrolü
    const restartPolicy = runSsh(`docker inspect ${containerName} --format '{{.HostConfig.RestartPolicy.Name}}'`);
    expect(restartPolicy).toBe('unless-stopped');

    // 5. Compose Environment Panelinden Dinamik Environment Değiştirme
    await page.reload();
    const envSection = page.locator('section').filter({ has: page.locator('h2:text-is("Compose environment")') });
    await expect(envSection).toBeVisible({ timeout: 15000 });

    const envTextarea = envSection.locator('textarea');
    await envTextarea.fill(`RUNTIME_DYNAMIC_KEY=YunPanelDynamicVal_${timestamp}\nANOTHER_ENV=Success123`);

    const envSubmitBtn = envSection.locator('button:has-text("Environment’ı değiştir")');
    await expect(envSubmitBtn).toBeEnabled({ timeout: 10000 });
    await envSubmitBtn.click();

    await confirmEnvReplace(page);

    // Çevre değişkeni revizyonunun ve anahtarlarının güncellendiğini ekranda doğrula
    await expect(envSection).toContainText('RUNTIME_DYNAMIC_KEY', { timeout: 15000 });

    // 6. Projeyi Temizleme (Lifecycle: Projeyi kaldır)
    await page.reload();
    const lifecycleSectionAfter = page.locator('section').filter({ has: page.locator('h2:text-is("Lifecycle")') });
    await expect(lifecycleSectionAfter).toBeVisible({ timeout: 15000 });

    const removeBtn = lifecycleSectionAfter.locator('button:has-text("Projeyi kaldır")');
    await expect(removeBtn).toBeEnabled({ timeout: 35000 });
    await removeBtn.click();

    await confirmLifecycleAction(page, 'remove');

    // Container'ın durduğunu/kaldırıldığını doğrula
    const absentResult = waitForContainerState(projectName, 'absent', 35, 2000);
    expect(absentResult.success, `Container silinmedi: ${absentResult.output}`).toBe(true);
  });
});
