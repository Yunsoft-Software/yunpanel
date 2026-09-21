import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs, openFirstWebsiteWorkspace } from './helpers.js';

test.describe('Module 6: Authoritative DNS & PowerDNS Management', () => {
  test('6.1. Zone RRsets: open DNS tab, verify zone info and existing records', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    const dnsTab = page.locator('nav.ws-tabs a', { hasText: 'DNS' });
    await expect(dnsTab).toBeVisible({ timeout: 10000 });
    await dnsTab.click();

    // Check if zone already exists or needs provisioning
    const provisionBtn = page.locator('button:has-text("Yerel DNS Zone Oluştur")');
    if (await provisionBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await provisionBtn.click();
      await expect(page.locator('text=Yerel PowerDNS authoritative zone başarıyla oluşturuldu.')).toBeVisible({ timeout: 15000 });
    }

    // Verify Authoritative DNS zone section
    const zoneSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Authoritative DNS zone' }) });
    await expect(zoneSection).toBeVisible({ timeout: 15000 });

    // Wait for DNS table to load
    const dnsTable = zoneSection.locator('.dns-table');
    await expect(dnsTable).toBeVisible({ timeout: 15000 });

    // Verify key values
    await expect(zoneSection.locator('dt', { hasText: 'Zone' }).first()).toBeVisible();
    await expect(zoneSection.locator('dt', { hasText: 'SOA serial' })).toBeVisible();

    // Verify DNS table headers
    await expect(dnsTable.locator('th:has-text("Ad")')).toBeVisible();
    await expect(dnsTable.locator('th:has-text("Tür")')).toBeVisible();
    await expect(dnsTable.locator('th:has-text("TTL")')).toBeVisible();
    await expect(dnsTable.locator('th:has-text("Kaynak")')).toBeVisible();
    await expect(dnsTable.locator('th:has-text("Değer")')).toBeVisible();

    // Verify at least SOA, NS, or A record exists
    await expect(dnsTable.locator('code:has-text("SOA"), code:has-text("NS"), code:has-text("A")').first()).toBeVisible();
  });

  test('6.2. Manual DNS record: create TXT record and verify in table', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    await page.locator('nav.ws-tabs a', { hasText: 'DNS' }).click();

    // Click "Manual kayıt ekle"
    const addBtn = page.locator('button:has-text("Manual kayıt ekle")');
    await expect(addBtn).toBeVisible({ timeout: 15000 });
    await addBtn.click();

    // Verify dialog opens
    const dialog = page.locator('.ws-modal', { hasText: 'Manual DNS kaydı ekle' });
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Enter Record Name
    const ownerInput = dialog.locator('label:has-text("Kayıt adı") input');
    await ownerInput.fill('e2e-test-record');

    // Enter TTL
    const ttlInput = dialog.locator('label:has-text("TTL") input');
    await ttlInput.fill('300');

    // Select TXT type button
    const txtBtn = dialog.locator('.dns-type-grid button:has-text("TXT")');
    await txtBtn.click();
    await expect(txtBtn).toHaveClass(/active/);

    // Enter TXT value
    const valInput = dialog.locator('label:has-text("Değerler") textarea');
    await valInput.fill('"yunpanel-e2e-token-12345"');

    // Submit
    const submitBtn = dialog.locator('button:has-text("Kaydı ekle")');
    await submitBtn.click();

    // Wait for modal close
    await expect(dialog).not.toBeVisible({ timeout: 15000 });

    // Verify the record row in table
    const table = page.locator('.dns-table');
    const recordRow = table.locator('tr', { hasText: 'e2e-test-record' });
    await expect(recordRow).toBeVisible({ timeout: 10000 });
    await expect(recordRow.locator('code:has-text("TXT")')).toBeVisible();
    await expect(recordRow).toContainText('yunpanel-e2e-token-12345');
  });

  test('6.3. Manual DNS record: edit and delete with confirmation', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    await page.locator('nav.ws-tabs a', { hasText: 'DNS' }).click();

    const table = page.locator('.dns-table');
    const recordRow = table.locator('tr', { hasText: 'e2e-test-record' });
    await expect(recordRow).toBeVisible({ timeout: 15000 });

    // Click Edit on record
    const editBtn = recordRow.locator('button:has-text("Düzenle")');
    await editBtn.click();

    // Verify edit dialog
    const editDialog = page.locator('.ws-modal', { hasText: 'Manual DNS kaydını düzenle' });
    await expect(editDialog).toBeVisible({ timeout: 5000 });

    // Edit value
    const valInput = editDialog.locator('label:has-text("Değerler") textarea');
    await valInput.fill('"yunpanel-e2e-token-updated-999"');

    // Submit update
    const updateBtn = editDialog.locator('button:has-text("Kaydı güncelle")');
    await updateBtn.click();

    await expect(editDialog).not.toBeVisible({ timeout: 15000 });

    // Verify updated value in table
    await expect(recordRow).toContainText('yunpanel-e2e-token-updated-999', { timeout: 10000 });

    // Click Delete on record
    const deleteBtn = recordRow.locator('button:has-text("Sil")');
    await deleteBtn.click();

    // Verify confirm dialog
    const confirmDialog = page.locator('.ws-modal', { hasText: 'Manual DNS kaydını sil' });
    await expect(confirmDialog).toBeVisible({ timeout: 5000 });

    // Extract confirmation text
    const confirmCode = await confirmDialog.locator('label strong').textContent();
    expect(confirmCode).toContain('delete-dns:');

    // Fill confirmation input
    await confirmDialog.locator('label input').fill(confirmCode.trim());

    // Click confirm delete
    const confirmDeleteBtn = confirmDialog.locator('button:has-text("Kaydı sil")');
    await expect(confirmDeleteBtn).toBeEnabled();
    await confirmDeleteBtn.click();

    // Verify dialog closed and record deleted from table
    await expect(confirmDialog).not.toBeVisible({ timeout: 15000 });
    await expect(table.locator('tr', { hasText: 'e2e-test-record' })).not.toBeVisible({ timeout: 10000 });
  });

  test('6.4. Zone Template synchronization: inspect diff and template status', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    await page.locator('nav.ws-tabs a', { hasText: 'DNS' }).click();

    const reapplySection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Zone Template senkronizasyonu' }) });
    await expect(reapplySection).toBeVisible({ timeout: 15000 });

    // Click "Diff’i yenile"
    const refreshDiffBtn = reapplySection.locator('button:has-text("Diff’i yenile")');
    await expect(refreshDiffBtn).toBeVisible();
    await refreshDiffBtn.click();

    // Verify diff status elements
    await expect(reapplySection.locator('dt', { hasText: 'Template sürümü' })).toBeVisible({ timeout: 10000 });
    await expect(reapplySection.locator('strong:has-text("Zone güncel")')).toBeVisible({ timeout: 10000 });
  });

  test('6.5. DNSSEC and Secondary DNS: inspect status and refresh', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await openFirstWebsiteWorkspace(page);

    await page.locator('nav.ws-tabs a', { hasText: 'DNS' }).click();

    // DNSSEC Section
    const dnssecSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'DNSSEC' }) });
    await expect(dnssecSection).toBeVisible({ timeout: 15000 });
    await expect(dnssecSection.locator('dt', { hasText: 'Local signing' })).toBeVisible({ timeout: 10000 });

    const dnssecRefreshBtn = dnssecSection.locator('button:has-text("Durumu yenile")');
    await expect(dnssecRefreshBtn).toBeVisible();
    await dnssecRefreshBtn.click();

    // Secondary DNS Section
    const secondarySection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Secondary DNS' }) });
    await expect(secondarySection).toBeVisible({ timeout: 10000 });
    const secRefresh = secondarySection.locator('button:has-text("Secondary durumu yenile")');
    await expect(secRefresh).toBeVisible();
    await secRefresh.click();
  });
});
