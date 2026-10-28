import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.describe('UX-05 Arama, filtre, sıralama, sayfalama ve toplu eylemler', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    const config = Object.fromEntries(readFileSync('.local/test-server.env', 'utf8').split('\n')
      .filter((line) => /^[A-Z_]+=/.test(line)).map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, '')];
      }));
    const resolved = execFileSync('ssh', ['-G', config.YUNPANEL_TEST_SERVER_SSH_ALIAS], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(config.YUNPANEL_TEST_SERVER_HOST.endsWith('.28')
      && resolved.match(/^hostname (.+)$/m)?.[1] === config.YUNPANEL_TEST_SERVER_HOST).toBe(true);
  });

  test.beforeEach(async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
  });

  test.afterEach(async ({ page }) => {
    if (!page.isClosed()) {
      await page.evaluate(() => {
        try {
          localStorage.removeItem('yunpanel.ui.preferences.v1');
        } catch {}
      });
    }
  });

  test('mutlu yol: web siteleri listesinde arama, filtreleme, siralama ve sayfalama calisir', async ({ page }) => {
    await page.goto('/websites');
    await expect(page.locator('.ws-website-task-list, .ws-empty')).toBeVisible({ timeout: 15_000 });

    const taskCards = page.locator('.ws-website-task-list .ws-website-task-card');
    const initialCount = await taskCards.count();
    expect(initialCount).toBeGreaterThan(0);

    // İlk alan adının adını al
    const firstDomainName = (await taskCards.first().locator('.ws-website-task-title h3 a').textContent() || '').trim();
    expect(firstDomainName.length).toBeGreaterThan(0);

    // 1. Arama testi: ilk alan adının bir parçasıyla ara
    const searchTerm = firstDomainName.slice(0, Math.min(5, firstDomainName.length));
    const searchInput = page.locator('.ws-filter-search input[type="search"]');
    await searchInput.fill(searchTerm);

    // URL parametresinin güncellendiğini doğrula
    await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(searchTerm)}`));

    // Arama sonucu filtrelenmiş kartların aranan ifadeyi içerdiğini fiziksel doğrula
    const filteredCards = page.locator('.ws-website-task-list .ws-website-task-card');
    const filteredCount = await filteredCards.count();
    expect(filteredCount).toBeGreaterThanOrEqual(1);

    for (let i = 0; i < filteredCount; i++) {
      const title = (await filteredCards.nth(i).locator('.ws-website-task-title h3 a').textContent() || '').trim();
      const isContextParent = await filteredCards.nth(i).locator('text=Filtrelenen alt alan adının üst kaydı').isVisible().catch(() => false);
      if (!isContextParent) {
        expect(title.toLowerCase()).toContain(searchTerm.toLowerCase());
      }
    }

    // Aramayı temizle ve tüm listenin geri geldiğini doğrula
    await searchInput.fill('');
    await expect(page).toHaveURL(new RegExp('/websites($|\\?)'));
    await expect(taskCards).toHaveCount(initialCount);

    // 2. Sıralama testi: "Görünüm ve filtreler" detayını aç
    const optionsDetails = page.locator('details.ws-list-options');
    if (!(await optionsDetails.evaluate((el) => el.open))) {
      await optionsDetails.locator('summary').click();
    }
    const sortSelect = page.locator('.ws-filter-options label:has-text("Sıralama") select');
    await expect(sortSelect).toBeVisible();

    // A–Z sıralamada ilk kartın adını kaydet
    const ascFirst = (await taskCards.first().locator('.ws-website-task-title h3 a').textContent() || '').trim();

    // Z–A sıralamaya geç
    await sortSelect.selectOption('desc');
    await expect(page).toHaveURL(/sort=desc/);

    // Sıralama değiştiğinde DOM'daki ilk kartın Z–A sırasına göre güncellendiğini doğrula
    if (initialCount > 1) {
      const descFirst = (await taskCards.first().locator('.ws-website-task-title h3 a').textContent() || '').trim();
      expect(descFirst).not.toBe(ascFirst);
    }

    // Tekrar A–Z'ye döndür
    await sortSelect.selectOption('asc');
    await expect(page).toHaveURL(/sort=asc/);

    // 3. Durum ve Tür filtreleri testi
    const statusSelect = page.locator('.ws-filters label:has-text("Durum") select');
    await statusSelect.selectOption('active');
    await expect(page).toHaveURL(/status=active/);

    const typeSelect = page.locator('.ws-filter-options label:has-text("Tür") select');
    await typeSelect.selectOption('proxy');
    await expect(page).toHaveURL(/type=proxy/);

    // Filtreleri sıfırla
    await statusSelect.selectOption('all');
    await typeSelect.selectOption('all');

    // 4. Sayfalama footer kontrolü
    const pagination = page.locator('footer.ws-pagination');
    await expect(pagination).toBeVisible();
    await expect(pagination.locator('span').first()).toContainText('ana alan adı');
    await expect(pagination.locator('button:has-text("Önceki")')).toBeDisabled();
  });

  test('hatali girdi ve sinir durumlari: bos arama sonucu, temizleme ve gecersiz sayfa parametresi', async ({ page }) => {
    await page.goto('/websites');
    await expect(page.locator('.ws-website-task-list')).toBeVisible({ timeout: 15_000 });

    const searchInput = page.locator('.ws-filter-search input[type="search"]');

    // Var olmayan ve özel regex karakterleri içeren arama terimi
    const nonExistentTerm = '__tux05_nonexistent_!@#$%^&*()_+{}[]__';
    await searchInput.fill(nonExistentTerm);

    // Liste boşalmalı ve boş durum (EmptyState) görünmeli
    await expect(page.locator('.ws-website-task-list .ws-website-task-card')).toHaveCount(0);
    const emptyState = page.locator('.ws-empty');
    await expect(emptyState).toBeVisible();
    await expect(emptyState).toContainText('Eşleşen alan adı bulunamadı');

    // "Filtreleri temizle" düğmesine tıklandığında liste geri gelmeli
    const clearBtn = emptyState.locator('button:has-text("Filtreleri temizle")');
    await expect(clearBtn).toBeVisible();
    await clearBtn.click();

    // Listenin geri geldiğini ve arama kutusunun sıfırlandığını fiziksel doğrula
    await expect(page.locator('.ws-website-task-list .ws-website-task-card')).not.toHaveCount(0);
    expect(await searchInput.inputValue()).toBe('');

    // Geçersiz sayfa parametresi kenetlenmesi (clamp): aşırı yüksek sayfa
    await page.goto('/websites?page=999999');
    await expect(page.locator('.workspace-shell')).toBeVisible();
    await expect(page.locator('.ws-website-task-list, .ws-empty')).toBeVisible();

    // Negatif sayfa parametresi: panel çökmeyip güvenle render etmeli
    await page.goto('/websites?page=-5');
    await expect(page.locator('.workspace-shell')).toBeVisible();
    await expect(page.locator('.ws-website-task-list, .ws-empty')).toBeVisible();

    // Alfabetik / geçersiz tipte sayfa parametresi
    await page.goto('/websites?page=corrupted_page_string');
    await expect(page.locator('.workspace-shell')).toBeVisible();
    await expect(page.locator('.ws-website-task-list, .ws-empty')).toBeVisible();
  });

  test('veritabanlari sayfasinda arama, filtre ve sayfalama calisir', async ({ page }) => {
    await page.goto('/databases');
    await expect(page.locator('.workspace-shell')).toBeVisible({ timeout: 15_000 });

    const dbSearchInput = page.locator('.ws-filters .ws-filter-search input[type="search"]');
    await expect(dbSearchInput).toBeVisible();

    // Arama kutusuna sorgu yazıldığında URL q parametresi güncellenmeli
    await dbSearchInput.fill('webrich');
    await expect(page).toHaveURL(/q=webrich/);

    // Erişim filtresi değiştirildiğinde URL güncellenmeli
    const accessSelect = page.locator('.ws-filters select[aria-label="Erişim"]');
    await expect(accessSelect).toBeVisible();
    await accessSelect.selectOption('ready');
    await expect(page).toHaveURL(/access=ready/);

    // Sayfalama göstergesi kontrolü
    const pagination = page.locator('footer.ws-pagination');
    if (await pagination.isVisible()) {
      await expect(pagination.locator('span').first()).toContainText('sonuç');
    }
  });

  test('Plesk Obsidian esdegerligi: web siteleri listesinde toplu secim ve toplu eylem cubugu (mass actions)', async ({ page }) => {
    test.fail(true, 'Plesk Obsidian eşdeğerliği: Web siteleri listesinde toplu seçim kutuları (checkbox) ve toplu eylem çubuğu (mass actions) bulunmuyor');

    await page.goto('/websites');
    await expect(page.locator('.ws-website-task-list')).toBeVisible({ timeout: 15_000 });

    // Plesk'te her sitenin yanında bir seçim kutusu ve üstte Toplu Eylemler (Mass Actions) bulunur
    const checkboxes = page.locator('.ws-website-task-list input[type="checkbox"]');
    const massActionsBar = page.locator('.ws-mass-actions, .ws-bulk-actions, [aria-label*="Toplu eylemler"]');

    await expect(checkboxes.first()).toBeVisible({ timeout: 3_000 });
    await expect(massActionsBar).toBeVisible({ timeout: 3_000 });
  });

  test('Plesk Obsidian esdegerligi: web sitelerinde tarih ve disk kullanimina gore gelismis siralama', async ({ page }) => {
    test.fail(true, 'Plesk Obsidian eşdeğerliği: Web siteleri listesinde oluşturma tarihi, disk alanı veya trafiğe göre sıralama seçenekleri bulunmuyor');

    await page.goto('/websites');
    const optionsDetails = page.locator('details.ws-list-options');
    if (!(await optionsDetails.evaluate((el) => el.open))) {
      await optionsDetails.locator('summary').click();
    }

    const sortSelect = page.locator('.ws-filter-options label:has-text("Sıralama") select');
    await expect(sortSelect).toBeVisible();

    // Plesk Obsidian'da bulunan tarih veya disk kullanımına göre sıralama opsiyonları
    const advancedOptions = sortSelect.locator('option[value="created_at"], option[value="disk_usage"], option[value="traffic"]');
    await expect(advancedOptions.first()).toBeAttached({ timeout: 3_000 });
  });

  test('Plesk Obsidian esdegerligi: sayfalamada 100 kayit secenegi ve dogrudan sayfa numarasina atlama', async ({ page }) => {
    test.fail(true, 'Plesk Obsidian eşdeğerliği: Sayfalama seçeneklerinde 100 kayıt ve doğrudan sayfa numarası girdisi (jump to page) bulunmuyor');

    await page.goto('/websites');
    const optionsDetails = page.locator('details.ws-list-options');
    if (!(await optionsDetails.evaluate((el) => el.open))) {
      await optionsDetails.locator('summary').click();
    }

    const perPageSelect = page.locator('.ws-filter-options label:has-text("Sayfada alan adı grubu") select');
    await expect(perPageSelect).toBeVisible();

    // 100 kayıt seçeneği veya doğrudan sayfa numarası girme alanı
    const option100 = perPageSelect.locator('option[value="100"]');
    const pageInput = page.locator('.ws-pagination input[type="number"], .ws-pagination input[aria-label*="Sayfa"]');

    await expect(option100.or(pageInput).first()).toBeAttached({ timeout: 3_000 });
  });
});
