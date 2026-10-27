import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('DKR-05 Compose stack oluşturma/yükleme/güncelleme/up/stop/down', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240000);

  const agentN = process.env.AGENT_N || '2';
  const timestamp = Date.now().toString(36);
  const projectName = `tdkr05_a${agentN}_${timestamp}`;
  const hostPort1 = 18200 + (parseInt(agentN, 10) * 100) + Math.floor(Math.random() * 40);
  const hostPort2 = hostPort1 + 50;

  let tempYmlPath = null;
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

  function waitForComposeState(name, expectedStatus, maxAttempts = 35, intervalMs = 2000) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const output = runSsh(`docker compose -p ${name} ps -a --format "{{.Name}} {{.Service}} {{.Status}}" 2>/dev/null || docker ps -a --filter "name=${name}" --format "{{.Names}} {{.Status}}"`);
      if (expectedStatus === 'absent') {
        if (!output || (!output.includes(name) && !output.includes('web1') && !output.includes('web2'))) {
          return { success: true, output };
        }
      } else if (expectedStatus === 'running_single') {
        if (output.includes('web1') && output.includes('Up')) {
          return { success: true, output };
        }
      } else if (expectedStatus === 'running_multi') {
        if (output.includes('web1') && output.includes('web2') && output.includes('Up')) {
          return { success: true, output };
        }
      } else if (expectedStatus === 'stopped') {
        const hasUp = output.includes('Up');
        const hasExited = output.includes('Exited') || output.includes('Created') || output.includes('Stop');
        if (!hasUp && hasExited) {
          return { success: true, output };
        }
      }
      execSync(`sleep ${intervalMs / 1000}`);
    }
    const finalCheck = runSsh(`docker compose -p ${name} ps -a --format "{{.Name}} {{.Service}} {{.Status}}" 2>/dev/null || docker ps -a --filter "name=${name}" --format "{{.Names}} {{.Status}}"`);
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

  async function confirmDocumentUpdate(page) {
    const modal = page.locator('.ws-modal').filter({ hasText: 'Compose desired state’i değiştir' });
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
    if (tempYmlPath && fs.existsSync(tempYmlPath)) {
      try {
        fs.unlinkSync(tempYmlPath);
      } catch {}
    }
    if (projectName) {
      runSsh(`docker compose -p ${projectName} down --remove-orphans 2>/dev/null || true`);
      runSsh(`docker stop ${projectName}-web1-1 ${projectName}-web2-1 2>/dev/null || true`);
      runSsh(`docker rm -f ${projectName}-web1-1 ${projectName}-web2-1 2>/dev/null || true`);
    }
  });

  test('hatalı girdi: geçersiz compose YAML sözdizimi doğrulamada reddedilir', async ({ page }) => {
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
    await docTextarea.fill('services:\n  invalid:\n    [broken yaml structure: {\n');

    const validateBtn = modal.locator('button:has-text("Validate")');
    await expect(validateBtn).toBeEnabled();
    await validateBtn.click();

    // Hata bildiriminin modal içinde çıktığını doğrula
    const errorNotice = modal.locator('.ws-notice-warn, [role="alert"]');
    await expect(errorNotice).toBeVisible({ timeout: 10000 });
    const errorText = await errorNotice.textContent();
    expect(errorText.length).toBeGreaterThan(0);

    // Modalı kapat
    await modal.locator('button:has-text("Vazgeç")').click();
    await expect(modal).not.toBeVisible({ timeout: 5000 });
  });

  test('mutlu yol: compose stack dosyası yükleme, oluşturma, up, güncelleme, stop ve down yaşam döngüsü', async ({ page }) => {
    // 1. Compose YAML dosyasını geçici diske oluştur (Dosya yükleme hazırlığı)
    const initialComposeYaml = [
      'services:',
      '  web1:',
      '    image: nginx:alpine',
      '    ports:',
      `      - "127.0.0.1:${hostPort1}:80"`,
      '',
    ].join('\n');

    tempYmlPath = path.join(os.tmpdir(), `stack-${projectName}.yml`);
    fs.writeFileSync(tempYmlPath, initialComposeYaml, 'utf8');

    await page.goto('/docker');
    await expect(page.locator('h1')).toContainText('Docker', { timeout: 15000 });

    // 2. Proje ekleme modalını aç
    const addBtn = page.locator('button:has-text("Compose projesi ekle"), button:has-text("Compose / Stack Ekle")').first();
    await expect(addBtn).toBeVisible({ timeout: 10000 });
    await addBtn.click();

    const modal = page.locator('.ws-modal').filter({ hasText: 'Docker Compose projesi ekle' });
    await expect(modal).toBeVisible({ timeout: 5000 });

    const nameInput = modal.locator('label:has-text("Proje adı") input');
    await expect(nameInput).toBeVisible();
    await nameInput.fill(projectName);

    // 3. .yml dosyasını file input ile yükle
    const fileInput = modal.locator('input[type="file"][accept*=".yml"], input[type="file"][aria-label*=".yml"]');
    await expect(fileInput).toBeAttached();
    await fileInput.setInputFiles(tempYmlPath);

    // Textarea'nın yüklenen dosya içeriğiyle dolduğunu doğrula
    const docTextarea = modal.locator('label:has-text("Compose document") textarea');
    await expect(docTextarea).toHaveValue(/web1:/);
    await expect(docTextarea).toHaveValue(/nginx:alpine/);

    // Validasyon yap
    const validateBtn = modal.locator('button:has-text("Validate")');
    await expect(validateBtn).toBeEnabled();
    await validateBtn.click();
    await expect(modal.locator('dt:has-text("Servis")')).toBeVisible({ timeout: 10000 });

    // Projeyi kaydet ve detay sayfasına geç
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

    // 4. STACK UP (Başlat)
    const startBtn = lifecycleSection.locator('button:has-text("Başlat")');
    await expect(startBtn).toBeEnabled({ timeout: 15000 });
    await startBtn.click();

    await confirmLifecycleAction(page, 'start');

    // Fiziksel Kanıt 1: Container ayakta ve docker compose ps listesinde Up
    const upCheck1 = waitForComposeState(projectName, 'running_single', 35, 2000);
    expect(upCheck1.success, `Stack Up durumuna geçmedi: ${upCheck1.output}`).toBe(true);

    // Fiziksel Kanıt 2: web1 portundan Nginx HTTP cevabı alınıyor mu?
    const httpOutput1 = runSsh(`curl -s -m 5 http://127.0.0.1:${hostPort1}`);
    expect(httpOutput1).toContain('nginx');

    // 5. STACK GÜNCELLEME (Compose desired state güncelle: web2 servisi ekle)
    await page.reload();
    const desiredStateSection = page.locator('section').filter({ has: page.locator('h2:text-is("Compose desired state")') });
    await expect(desiredStateSection).toBeVisible({ timeout: 15000 });

    // Mevcut YAML'ı editöre yükle ve kontrol et
    const loadDocBtn = desiredStateSection.locator('button:has-text("Mevcut Compose YAML\'ı Editöre Yükle")');
    await expect(loadDocBtn).toBeEnabled({ timeout: 10000 });
    await loadDocBtn.click();

    const updateDocTextarea = desiredStateSection.locator('label:has-text("Yeni tam Compose document") textarea');
    await expect(updateDocTextarea).toHaveValue(/web1:/, { timeout: 15000 });

    const updatedComposeYaml = [
      'services:',
      '  web1:',
      '    image: nginx:alpine',
      '    ports:',
      `      - "127.0.0.1:${hostPort1}:80"`,
      '  web2:',
      '    image: nginx:alpine',
      '    ports:',
      `      - "127.0.0.1:${hostPort2}:80"`,
      '',
    ].join('\n');

    await updateDocTextarea.fill(updatedComposeYaml);
    await expect(updateDocTextarea).toHaveValue(/web2:/);

    const updateSubmitBtn = desiredStateSection.locator('button:has-text("Desired state’i değiştir")');
    await expect(updateSubmitBtn).toBeEnabled({ timeout: 10000 });
    await updateSubmitBtn.click();

    await confirmDocumentUpdate(page);

    // Başarı bildirimini doğrula
    await expect(desiredStateSection.locator('.ws-notice')).toContainText('Compose desired state kaydedildi', { timeout: 15000 });

    // Kayıtlı state'i validate et butonuna tıkla ve 2 servis olduğunu doğrula
    const validateSavedBtn = desiredStateSection.locator('button:has-text("Kayıtlı state’i validate et")');
    await expect(validateSavedBtn).toBeEnabled({ timeout: 10000 });
    await validateSavedBtn.click();

    await expect(desiredStateSection.locator('dt:has-text("Servis")')).toBeVisible({ timeout: 10000 });
    await expect(desiredStateSection.locator('dt:has-text("Servis") + dd')).toContainText('2');

    // 6. GÜNCELLENMİŞ STACK'İ UP ET (Başlat ile yeni servisleri ayağa kaldır)
    await page.reload();
    await expect(lifecycleSection).toBeVisible({ timeout: 15000 });
    const applyStartBtn = lifecycleSection.locator('button:has-text("Başlat")');
    await expect(applyStartBtn).toBeEnabled({ timeout: 35000 });
    await applyStartBtn.click();

    await confirmLifecycleAction(page, 'start');

    // Fiziksel Kanıt 3: İki servis de (web1 ve web2) Up durumunda koşuyor
    const upCheck2 = waitForComposeState(projectName, 'running_multi', 35, 2000);
    expect(upCheck2.success, `Güncelleme sonrası servisler Up olmadı: ${upCheck2.output}`).toBe(true);

    // Fiziksel Kanıt 4: Yeni web2 portundan da HTTP 200/nginx cevabı alınıyor
    const httpOutput2 = runSsh(`curl -s -m 5 http://127.0.0.1:${hostPort2}`);
    expect(httpOutput2).toContain('nginx');

    // Fiziksel Kanıt 5: docker compose ps ile compose servis listesi
    const composePsOutput = runSsh(`docker compose -p ${projectName} ps --format "{{.Service}} {{.Status}}"`);
    expect(composePsOutput).toContain('web1');
    expect(composePsOutput).toContain('web2');

    // 7. STACK STOP (Durdur)
    await page.reload();
    await expect(lifecycleSection).toBeVisible({ timeout: 15000 });
    const stopBtn = lifecycleSection.locator('button:has-text("Durdur")');
    await expect(stopBtn).toBeEnabled({ timeout: 35000 });
    await stopBtn.click();

    await confirmLifecycleAction(page, 'stop');

    // Fiziksel Kanıt 6: Container'lar Exited / Stopped durumuna geçti
    const stopCheck = waitForComposeState(projectName, 'stopped', 35, 2000);
    expect(stopCheck.success, `Durdurma sonrası containerlar durmadı: ${stopCheck.output}`).toBe(true);

    // 8. STACK DOWN (Projeyi kaldır)
    await page.reload();
    await expect(lifecycleSection).toBeVisible({ timeout: 15000 });
    const removeBtn = lifecycleSection.locator('button:has-text("Projeyi kaldır")');
    await expect(removeBtn).toBeEnabled({ timeout: 35000 });
    await removeBtn.click();

    await confirmLifecycleAction(page, 'remove');

    // Fiziksel Kanıt 7: Container'ların tamamı silindi (absent)
    const removeCheck = waitForComposeState(projectName, 'absent', 35, 2000);
    expect(removeCheck.success, `Kaldırma sonrası containerlar silinmedi: ${removeCheck.output}`).toBe(true);

    // UI Doğrulaması: Projeler sayfasına dönüldüğünde silinen projenin artık listede olmadığını gör
    await page.goto('/docker');
    await expect(page.locator('h1')).toContainText('Docker', { timeout: 15000 });
    await expect(page.locator(`text=${projectName}`)).not.toBeVisible({ timeout: 10000 });
  });
});
