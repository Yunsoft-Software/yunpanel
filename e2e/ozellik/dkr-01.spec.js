import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('DKR-01 Registry/image arama, indirme ve image yönetimi', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240000);

  const agentN = process.env.AGENT_N || '2';
  const timestamp = Date.now().toString(36);
  const projectName = `tdkr01_a${agentN}_${timestamp}`;
  const testImage = 'alpine:3.20';
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
      if (expectedStatus === 'stopped_or_exited' && (output.includes('Exited') || output.includes('Created') || output.includes('Up'))) {
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
      runSsh(`docker compose -p ${projectName} down --remove-orphans 2>/dev/null || true`);
      runSsh(`docker rm -f ${projectName}-app-1 ${projectName}_app_1 2>/dev/null || true`);
      const leftoverCids = runSsh(`docker ps -a --filter "name=${projectName}" -q`);
      if (leftoverCids) {
        runSsh(`docker rm -f ${leftoverCids.split('\n').join(' ')} 2>/dev/null || true`);
      }
    }
    // Test için çekilen testImage'i temizle
    if (testImage) {
      runSsh(`docker rmi -f ${testImage} 2>/dev/null || true`);
    }
  });

  test('mutlu yol: Docker Hub kataloğunda imaj arama, kategori filtreleme ve canlı sonuç listeleme', async ({ page }) => {
    await page.goto('/docker');
    await expect(page.locator('h1')).toContainText('Docker', { timeout: 15000 });

    // 1. Canlı arama kutusuna 'redis' yaz
    const searchInput = page.locator('input[type="search"]').first();
    await expect(searchInput).toBeVisible({ timeout: 10000 });
    await searchInput.fill('redis');

    // 2. Arama sonucunda Redis kartının göründüğünü doğrula
    const redisCard = page.locator('.yp-docker-catalog-card').filter({ hasText: 'Redis' }).first();
    await expect(redisCard).toBeVisible({ timeout: 15000 });
    await expect(redisCard).toContainText('redis', { timeout: 5000 });
    await expect(redisCard).toContainText('Inner: 6379/tcp', { timeout: 5000 });

    // 3. Kategori filtreleme: "Veritabanı & Cache" butonuna tıkla
    const dbCategoryBtn = page.locator('.yp-category-pills button:has-text("Veritabanı & Cache")');
    if (await dbCategoryBtn.isVisible()) {
      await dbCategoryBtn.click();
      await expect(page.locator('.yp-docker-catalog-card').first()).toBeVisible({ timeout: 10000 });
    }

    // 4. Fiziksel Sonuç (API kanıtı): page.request ile /api/panel/docker/catalog gerçek JSON cevabı
    const catalogRes = await page.request.get('/api/panel/docker/catalog?q=redis&live=true');
    expect(catalogRes.ok()).toBe(true);
    const catalogJson = await catalogRes.json();
    const items = catalogJson.data || catalogJson.items || [];
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);
    const hasRedis = items.some((item) => (item.id === 'redis' || (item.image && item.image.includes('redis'))));
    expect(hasRedis).toBe(true);
  });

  test('hatalı girdi: Registry credentials formunda geçersiz URL-formatlı host reddedilir', async ({ page }) => {
    await page.goto('/docker');
    await expect(page.locator('h1')).toContainText('Docker', { timeout: 15000 });

    // Proje oluşturma modalını aç
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
      '  app:',
      `    image: ${testImage}`,
      '    command: ["sleep", "300"]',
      '',
    ].join('\n');

    const docTextarea = modal.locator('label:has-text("Compose document") textarea');
    await docTextarea.fill(composeContent);

    // Validate ve Projeyi kaydet
    const validateBtn = modal.locator('button:has-text("Validate")');
    await expect(validateBtn).toBeEnabled();
    await validateBtn.click();
    await expect(modal.locator('dt:has-text("Servis")')).toBeVisible({ timeout: 10000 });

    const saveBtn = modal.locator('button:has-text("Projeyi kaydet")');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    await page.waitForURL(/\/docker\/[^/]+/, { timeout: 20000 });
    const currentUrl = page.url();
    const urlMatch = currentUrl.match(/\/docker\/([^/?#]+)/);
    createdProjectId = urlMatch ? decodeURIComponent(urlMatch[1]) : null;
    expect(createdProjectId).toBeTruthy();

    await expect(page.locator('h1')).toContainText(projectName, { timeout: 15000 });

    // Registry credentials bölümünü bul
    const registrySection = page.locator('section').filter({ has: page.locator('h2:text-is("Registry credentials")') });
    await expect(registrySection).toBeVisible({ timeout: 15000 });

    // Hatalı girdi: URL formatlı geçersiz registry host (örn: https://ghcr.io/invalid/path)
    const hostInput = registrySection.locator('label:has-text("Registry host") input');
    const userInput = registrySection.locator('label:has-text("Username") input');
    const secretInput = registrySection.locator('label:has-text("Secret / token") input');

    await hostInput.fill('https://ghcr.io/invalid/path');
    await userInput.fill('testuser');
    await secretInput.fill('secret123');

    const saveCredBtn = registrySection.locator('button:has-text("Credential kaydet")');
    await expect(saveCredBtn).toBeEnabled();
    await saveCredBtn.click();

    // Hata bildirimini veya reddedilmeyi doğrula
    const errorNotice = page.locator('.ws-notice-warn, [role="alert"]').first();
    await expect(errorNotice).toBeVisible({ timeout: 10000 });
    const errorText = await errorNotice.textContent();
    expect(errorText.toLowerCase()).toContain('registry');

    // Tabloda geçersiz host'un eklenmediğini doğrula
    const tableHost = registrySection.locator('td strong:has-text("https://ghcr.io")');
    await expect(tableHost).toHaveCount(0);
  });

  test('mutlu yol: Compose başlatma ile imaj indirme (pull) ve fiziksel docker images doğrulaması', async ({ page }) => {
    // Önceki testte oluşturulan projenin detay sayfasına git
    expect(createdProjectId).toBeTruthy();
    await page.goto(`/docker/${encodeURIComponent(createdProjectId)}`);
    await expect(page.locator('h1')).toContainText(projectName, { timeout: 15000 });

    const lifecycleSection = page.locator('section').filter({ has: page.locator('h2:text-is("Lifecycle")') });
    await expect(lifecycleSection).toBeVisible({ timeout: 15000 });

    // Projeyi başlat (Compose up/start tetiklenir, imaj docker pull ile indirilir)
    const startBtn = lifecycleSection.locator('button:has-text("Başlat")');
    await expect(startBtn).toBeVisible({ timeout: 10000 });
    await expect(startBtn).toBeEnabled({ timeout: 10000 });
    await startBtn.click();

    await confirmLifecycleAction(page, 'start');

    // Container'ın oluşturulduğunu veya çalıştığını doğrula
    const stateCheck = waitForContainerState(projectName, 'stopped_or_exited', 45, 2000);
    expect(stateCheck.success, `Container oluşmadı: ${stateCheck.output}`).toBe(true);

    // Fiziksel Kanıt 1: SSH üzerinden docker images çıktısında testImage'in var olduğunu doğrula
    const imagesOutput = runSsh('docker images --format "{{.Repository}}:{{.Tag}}"');
    expect(imagesOutput).toContain('alpine');

    // Fiziksel Kanıt 2: SSH üzerinden container inspect ile imaj referansını doğrula
    const cid = runSsh(`docker ps -a --filter "name=${projectName}" -q | head -n1`);
    expect(cid.length).toBeGreaterThan(0);
    const inspectImage = runSsh(`docker inspect --format="{{.Config.Image}}" ${cid}`);
    expect(inspectImage).toContain('alpine');
  });

  test('Plesk eşdeğerlik kontrolü: Bağımsız yerel imaj yönetimi (Local Images listesi ve docker rmi arayüzü)', async ({ page }) => {
    // Plesk Docker eklentisinde bağımsız bir "Docker > Local Images" kataloğu bulunur.
    // Kullanıcı container oluşturmadan doğrudan "docker pull" ile imaj indirebilir ve
    // yerel imajları listeleyip "docker rmi" ile silebilir.
    // YunPanel'de ise bağımsız yerel imaj yönetim ekranı bulunmamakta; imajlar yalnızca Compose stack'ler üzerinden yönetilmektedir.
    test.fail(
      true,
      'BULGU DKR-01: Plesk Docker eklentisinde bulunan bağımsız yerel imaj listeleme (Local Images / docker images) ve tekil imaj silme (docker rmi) arayüzü YunPanel üzerinde bulunmuyor; imaj yönetimi yalnızca Compose stack yaşam döngüsüyle dolaylı yürütülüyor',
    );

    await page.goto('/docker');
    await expect(page.locator('h1')).toContainText('Docker', { timeout: 15000 });

    // Plesk eşdeğeri "Yerel İmajlar" veya "Local Images" sekmesi veya imaj silme eylemi aranır
    const localImagesTab = page.locator('button, a, [role="tab"]').filter({ hasText: /Yerel İmajlar|Local Images|İndirilen İmajlar/i });
    await expect(localImagesTab).toBeVisible({ timeout: 3000 });
  });
});
