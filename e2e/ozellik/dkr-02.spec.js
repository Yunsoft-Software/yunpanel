import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('DKR-02 Container oluşturma, başlatma, durdurma, yeniden oluşturma/silme', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240000);

  const agentN = process.env.AGENT_N || '4';
  const timestamp = Date.now().toString(36);
  const projectName = `tdkr02_a${agentN}_${timestamp}`;
  const hostPort = 18800 + Math.floor(Math.random() * 100);
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
      if (expectedStatus === 'stopped' && (output.includes('Exited') || output.includes('Created') || output.includes('Stop'))) {
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

    // ConfirmDialog içindeki confirmation dizgisini oku ve inputa yaz
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
      runSsh(`docker compose -p ${projectName} down --remove-orphans 2>/dev/null || true`);
    }
  });

  test('hatalı girdi: geçersiz compose YAML dokümanı reddedilir', async ({ page }) => {
    await page.goto('/docker');
    await expect(page.locator('h1')).toContainText('Docker', { timeout: 15000 });

    const addBtn = page.locator('button:has-text("Compose projesi ekle"), button:has-text("Compose / Stack Ekle")').first();
    await expect(addBtn).toBeVisible({ timeout: 10000 });
    await addBtn.click();

    const modal = page.locator('.ws-modal').filter({ hasText: 'Docker Compose projesi ekle' });
    await expect(modal).toBeVisible({ timeout: 5000 });

    const nameInput = modal.locator('label:has-text("Proje adı") input');
    await expect(nameInput).toBeVisible();
    await nameInput.fill(`inv_${timestamp}`);

    const docTextarea = modal.locator('label:has-text("Compose document") textarea');
    await expect(docTextarea).toBeVisible();
    // Sözdizimi bozuk YAML gir
    await docTextarea.fill('services:\n  broken:\n    [invalid yaml structure\n');

    const validateBtn = modal.locator('button:has-text("Validate")');
    await expect(validateBtn).toBeEnabled();
    await validateBtn.click();

    // Hata bildiriminin ekranda çıktığını doğrula
    const errorNotice = modal.locator('.ws-notice-warn, [role="alert"]');
    await expect(errorNotice).toBeVisible({ timeout: 10000 });
    const errorText = await errorNotice.textContent();
    expect(errorText.length).toBeGreaterThan(0);

    // Modalı kapat
    await modal.locator('button:has-text("Vazgeç")').click();
    await expect(modal).not.toBeVisible({ timeout: 5000 });
  });

  test('mutlu yol: container oluşturma, başlatma, yeniden başlatma, durdurma ve silme döngüsü', async ({ page }) => {
    await page.goto('/docker');
    await expect(page.locator('h1')).toContainText('Docker', { timeout: 15000 });

    // 1. Proje oluşturma modalını aç
    const addBtn = page.locator('button:has-text("Compose projesi ekle"), button:has-text("Compose / Stack Ekle")').first();
    await expect(addBtn).toBeVisible({ timeout: 10000 });
    await addBtn.click();

    const modal = page.locator('.ws-modal').filter({ hasText: 'Docker Compose projesi ekle' });
    await expect(modal).toBeVisible({ timeout: 5000 });

    const nameInput = modal.locator('label:has-text("Proje adı") input');
    await expect(nameInput).toBeVisible();
    await nameInput.fill(projectName);

    const composeContent = [
      'services:',
      '  web:',
      '    image: nginx:alpine',
      '    ports:',
      `      - "127.0.0.1:${hostPort}:80"`,
      '',
    ].join('\n');

    const docTextarea = modal.locator('label:has-text("Compose document") textarea');
    await docTextarea.fill(composeContent);

    // Validasyon yap
    const validateBtn = modal.locator('button:has-text("Validate")');
    await expect(validateBtn).toBeEnabled();
    await validateBtn.click();
    await expect(modal.locator('dt:has-text("Servis")')).toBeVisible({ timeout: 10000 });

    // Projeyi kaydet ve detay sayfasına git
    const saveBtn = modal.locator('button:has-text("Projeyi kaydet")');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    await page.waitForURL(/\/docker\/[^/]+/, { timeout: 20000 });
    const currentUrl = page.url();
    const urlMatch = currentUrl.match(/\/docker\/([^/?#]+)/);
    createdProjectId = urlMatch ? decodeURIComponent(urlMatch[1]) : null;
    expect(createdProjectId).toBeTruthy();

    await expect(page.locator('h1')).toContainText(projectName, { timeout: 15000 });

    const lifecycleSection = page.locator('section').filter({ has: page.locator('h2:text-is("Lifecycle")') });
    await expect(lifecycleSection).toBeVisible({ timeout: 15000 });

    // 2. BAŞLAT (start)
    const startBtn = lifecycleSection.locator('button:has-text("Başlat")');
    await expect(startBtn).toBeVisible({ timeout: 10000 });
    await expect(startBtn).toBeEnabled({ timeout: 10000 });
    await startBtn.click();

    await confirmLifecycleAction(page, 'start');

    // Fiziksel Kanıt 1: Container'ın ayakta (Up) olduğunu doğrula
    const startCheck = waitForContainerState(projectName, 'running', 40, 2000);
    expect(startCheck.success, `Container Up durumuna geçmedi: ${startCheck.output}`).toBe(true);

    // Fiziksel Kanıt 2: Container HTTP portundan yanıt veriyor mu?
    const httpOutput = runSsh(`curl -s -m 5 http://127.0.0.1:${hostPort}`);
    expect(httpOutput).toContain('nginx');

    // Fiziksel Kanıt 3: Docker inspect ile container metadata kontrolü
    const inspectOutput = runSsh(`docker inspect --format '{{.State.Running}} {{.Config.Image}}' ${projectName}-web-1`);
    expect(inspectOutput).toContain('true');
    expect(inspectOutput).toContain('nginx:alpine');

    // 3. RESTART (yeniden başlat)
    await page.reload();
    await expect(lifecycleSection).toBeVisible({ timeout: 15000 });
    const restartBtn = lifecycleSection.locator('button:has-text("Restart")');
    await expect(restartBtn).toBeEnabled({ timeout: 35000 });
    await restartBtn.click();

    await confirmLifecycleAction(page, 'restart');

    // Restart sonrası container'ın hala koştuğunu doğrula
    const restartCheck = waitForContainerState(projectName, 'running', 35, 2000);
    expect(restartCheck.success, `Restart sonrası container Up olmadı: ${restartCheck.output}`).toBe(true);

    // 4. DURDUR (stop)
    await page.reload();
    await expect(lifecycleSection).toBeVisible({ timeout: 15000 });
    const stopBtn = lifecycleSection.locator('button:has-text("Durdur")');
    await expect(stopBtn).toBeEnabled({ timeout: 35000 });
    await stopBtn.click();

    await confirmLifecycleAction(page, 'stop');

    // Fiziksel Kanıt 4: Container'ın durduğunu (Exited) doğrula
    const stopCheck = waitForContainerState(projectName, 'stopped', 40, 2000);
    expect(stopCheck.success, `Durdurma sonrası container durmadı: ${stopCheck.output}`).toBe(true);

    // 5. SİLME / KALDIRMA (remove)
    await page.reload();
    await expect(lifecycleSection).toBeVisible({ timeout: 15000 });
    const removeBtn = lifecycleSection.locator('button:has-text("Projeyi kaldır")');
    await expect(removeBtn).toBeEnabled({ timeout: 35000 });
    await removeBtn.click();

    await confirmLifecycleAction(page, 'remove');

    // Fiziksel Kanıt 5: Container'ın tamamen silindiğini doğrula
    const removeCheck = waitForContainerState(projectName, 'absent', 40, 2000);
    expect(removeCheck.success, `Container silinmedi, hala mevcut: ${removeCheck.output}`).toBe(true);

    // UI Doğrulaması: Projeler listesine dönüldüğünde silinen projenin listede olmadığını gör
    await page.goto('/docker');
    await expect(page.locator('h1')).toContainText('Docker', { timeout: 15000 });
    await expect(page.locator(`text=${projectName}`)).not.toBeVisible({ timeout: 10000 });
  });
});
