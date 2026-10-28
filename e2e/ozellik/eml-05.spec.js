import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.describe('EML-05 Mailing list ve üyelik yönetimi; OS/eklenti matrisi', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300000);

  const agentN = process.env.AGENT_N || '3';
  const prefix = `teml05-a${agentN}-${Date.now().toString(36)}`;
  let targetDomainName = '';
  let mailDomainId = '';

  function runSsh(command) {
    const b64 = Buffer.from(command).toString('base64');
    return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test "echo ${b64} | base64 -d | bash"`, {
      encoding: 'utf8',
      timeout: 30000,
    });
  }

  test.beforeEach(async ({ page }) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        await page.goto('/');
        const retryBtn = page.locator('button:has-text("Tekrar dene")');
        if (await retryBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await retryBtn.click();
        }
      }
    }
  });

  test.afterAll(async () => {
    try {
      runSsh(`node -e "
        const fs = require('fs');
        const { execSync } = require('child_process');
        try {
          execSync(\\"sqlite3 /var/lib/yunpanel/mail-auth/virtual-mail.sqlite3 \\\\\\"DELETE FROM virtual_mailboxes WHERE address LIKE '${prefix}%';\\\\\\"\\");
        } catch {}
        try {
          const mbPath = '/var/lib/yunpanel/control-plane/mailbox-registry.json';
          if (fs.existsSync(mbPath)) {
            const data = JSON.parse(fs.readFileSync(mbPath, 'utf8'));
            data.mailboxes = (data.mailboxes || []).filter(m => !m.address.startsWith('${prefix}'));
            fs.writeFileSync(mbPath, JSON.stringify(data, null, 2) + '\\n');
          }
        } catch {}
      " 2>/dev/null || true`);
    } catch {
      // Temizlik adımı
    }
  });

  test('mutlu yol: Mail arayüzü ve mevcut posta servislerinin çalışırlığı doğrulanır, EML-05 sistem capability durumu incelenir', async ({ page }) => {
    // 1. Mail sayfasına git ve yerel mail alan adını doğrula
    await page.goto('/mail');
    await expect(page.locator('h1:has-text("Mail")')).toBeVisible({ timeout: 15000 });

    const localDomainRow = page.locator('table.ws-table tbody tr', { hasText: 'Bu sunucuda' }).first();
    await expect(localDomainRow).toBeVisible({ timeout: 15000 });

    const domainNameEl = localDomainRow.locator('td strong').first();
    targetDomainName = (await domainNameEl.textContent())?.trim() || 'webrich.news';

    // Mail alan adı detay sayfasına geç
    const manageLink = localDomainRow.locator('a:has-text("Yönet")');
    await manageLink.click();
    await page.waitForURL(/\/mail\/[^/?]+/, { timeout: 15000 });

    const urlMatch = page.url().match(/\/mail\/([^/?]+)/);
    mailDomainId = urlMatch ? urlMatch[1] : '';
    expect(mailDomainId).toBeTruthy();

    // 2. Mevcut e-posta yönetim sekmelerinin çalıştığını doğrula
    const tabNav = page.locator('nav.ws-tabs[aria-label="Mail yönetimi"]');
    await expect(tabNav).toBeVisible({ timeout: 15000 });
    await expect(tabNav.locator('text=Posta kutuları')).toBeVisible({ timeout: 5000 });
    await expect(tabNav.locator('text=Webmail')).toBeVisible({ timeout: 5000 });
    await expect(tabNav.locator('text=Takma adlar')).toBeVisible({ timeout: 5000 });

    // 3. Fiziksel kanıt 1: Postfix ve Dovecot e-posta servislerinin ana makinede aktif çalıştığı doğrulanır
    const serviceStatus = runSsh('systemctl is-active postfix dovecot');
    expect(serviceStatus).toContain('active');

    // 4. Fiziksel kanıt 2: EML-05 capability kaydının deferred ve Mailman motoru olarak tanımlı olduğu doğrulanır
    const capOutput = runSsh(`node -e '
      import("/usr/lib/yunpanel/apps/api/src/non-reseller-capabilities.js").then(m => {
        const c = m.getCapabilityById("EML-05");
        console.log(JSON.stringify({ id: c.id, status: c.status, serviceAdapters: c.serviceAdapters }));
      });
    '`);
    expect(capOutput).toContain('"id":"EML-05"');
    expect(capOutput).toContain('"status":"deferred"');
    expect(capOutput).toContain('"serviceAdapters":"Mailman"');
  });

  test('hatalı girdi ve sınır durumları: Olmayan posta listesi API uç noktaları 404 döner, Mailman servisi ve ikilileri host üzerinde mevcut değildir', async ({ request }) => {
    // 1. API üzerinden tanımlanmamış mailing-list uç noktalarına GET, POST ve DELETE çağrıları 404 dönmeli
    const dummyDomainId = mailDomainId || '00000000-0000-4000-8000-000000000000';
    const listRes = await request.get(`/api/mail-domains/${dummyDomainId}/mailing-lists`);
    expect(listRes.status()).toBe(404);

    const postRes = await request.post(`/api/mailing-lists`, {
      data: {
        domain: targetDomainName || 'webrich.news',
        listName: `${prefix}-announcements`,
        adminEmail: `admin@${targetDomainName || 'webrich.news'}`,
        password: 'Password123!',
      },
    });
    expect(postRes.status()).toBe(404);

    const singleRes = await request.get(`/api/mailing-lists/nonexistent-list-id`);
    expect(singleRes.status()).toBe(404);

    const deleteRes = await request.delete(`/api/mailing-lists/nonexistent-list-id`);
    expect(deleteRes.status()).toBe(404);

    // 2. Fiziksel kontrol: Sunucuda Mailman sistem servisinin ve ikililerinin bulunmadığı doğrulanır
    const mailmanStatus = runSsh('systemctl is-active mailman mailman3 2>&1 || true');
    expect(mailmanStatus).toContain('inactive');

    const mailmanBinaryCheck = runSsh('which mailman list_members mmsitepass 2>&1 || echo "NOT_INSTALLED"');
    expect(mailmanBinaryCheck).toContain('NOT_INSTALLED');

    const mailmanDirsCheck = runSsh('[ ! -d /var/lib/mailman ] && [ ! -d /var/lib/mailman3 ] && echo "NO_MAILMAN_DIRS"');
    expect(mailmanDirsCheck.trim()).toBe('NO_MAILMAN_DIRS');
  });

  test('Plesk Parity kontrolü: E-posta altında Posta Listeleri (Mailing Lists / Mailman) sekmesi, liste CRUD ve üyelik yönetimi arayüzü', async ({ page }) => {
    test.fail(
      true,
      'BULGU EML-05: Panelde Plesk eşdeğeri Mailman / Posta Listeleri (Mailing Lists), liste oluşturma/silme ve üye yönetimi arayüzü ve backend desteği henüz mevcut değil (deferred/sonraki faz).'
    );

    // 1. Mail sayfasına git ve mail domain detayını aç
    await page.goto('/mail');
    const localDomainRow = page.locator('table.ws-table tbody tr', { hasText: 'Bu sunucuda' }).first();
    await localDomainRow.locator('a:has-text("Yönet")').click();
    await page.waitForURL(/\/mail\/[^/?]+/, { timeout: 15000 });

    // 2. Plesk'te yer alan "Posta Listeleri" (Mailing Lists) sekmesi veya arayüz butonu
    const tabNav = page.locator('nav.ws-tabs[aria-label="Mail yönetimi"]');
    await expect(tabNav).toBeVisible({ timeout: 15000 });

    const mailingListTab = tabNav.locator('a, button').filter({
      hasText: /Posta listeleri|Posta Listeleri|Mailing Lists|Mailman/i,
    });
    await expect(mailingListTab).toBeVisible({ timeout: 5000 });

    // Sekmeye tıklandığında posta listesi paneli ve "Posta Listesi Ekle" butonu beklenir
    await mailingListTab.click();
    const addListBtn = page.locator('button:has-text("Posta listesi ekle"), button:has-text("Add mailing list")');
    await expect(addListBtn).toBeVisible({ timeout: 5000 });

    // Liste oluşturma modalında liste adı, yönetici e-posta, parola ve üye (subscribers) listesi alanları
    await addListBtn.click();
    const listModal = page.locator('.ws-modal, section').filter({ hasText: /Posta listesi/i });
    await expect(listModal).toBeVisible({ timeout: 5000 });
    await expect(listModal.locator('input[name="listName"], label:has-text("Liste adı")')).toBeVisible({ timeout: 5000 });
    await expect(listModal.locator('input[name="adminEmail"], label:has-text("Yönetici")')).toBeVisible({ timeout: 5000 });
    await expect(listModal.locator('textarea[name="subscribers"], label:has-text("Üyeler")')).toBeVisible({ timeout: 5000 });
  });
});
