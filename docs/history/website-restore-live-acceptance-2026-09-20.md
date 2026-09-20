# Website Backup Set ve Durable Restore Canlı Kabul Raporu (2026-09-20)

## 1. Kapsam ve Amaç
Bu rapor, `plan.md` (P1.2 Website Restore Durable Operation) ve `todo.md` (T-SITE-FEATURES-SETTINGS altındaki Website backup set ve restore kabul maddeleri) gereksinimlerinin Ubuntu 24.04 LTS `.28` test sunucusu (`157.180.11.28`) üzerindeki canlı uçtan uca doğrulanmasını belgeler.

## 2. Doğrulanan Bileşenler ve Güvenlik Sınırları

1. **Website Backup Set Üretimi:**
   - PHP (`webrich.news`), Static (`yunpanel-static-deploy.test`), Node (`yunpanel-node-smoke.test`) ve Mail (`mailtest.webrich.news`) siteleri için dosya, veri, DB dump hook'u, Nginx vhost ve mail konfigürasyonlarını içeren deterministic digest'e sahip backup set'ler üretildi.

2. **Restic Entegrasyonu & Anlık Görüntü:**
   - `createResticRepositoryRegistry` ile local backend repository oluşturuldu (`/var/lib/yunpanel/backups/restic/repos/site_a_repo_*`).
   - Restic init işlemi yapıldı.
   - Site A (`webrich.news`) için `resticManager.createSnapshot` çağrısıyla `tags: ['website:<id>', 'server:<id>', ...]` etiketleriyle anlık görüntü başarıyla alındı.

3. **Website Restore Preview & Tipli Onay:**
   - `POST /api/panel/websites/:websiteId/restore/preview` çağrıldı.
   - Belirli snapshot ve hedef repository için `previewDigest` (SHA-256) ve `confirmation` (`restore:<websiteId>:<snapshotId>:<previewDigest>`) üretildi.
   - `websiteRevision` preview içine dahil edilerek eşzamanlı değişiklik tespiti sağlandı.

4. **Resource Locking (Assert Idle):**
   - Website üzerinde aktif job varken restore ve preview reddedilir (HTTP 409 `website_job_conflict`).

5. **Pre-Restore Snapshot & Geri Alma Garantisi:**
   - Dosya sisteminde herhangi bir mutasyon yapılmadan önce `preRestoreSnapshotId` üretildi.
   - Target snapshot restore edildi.
   - HTTP sağlık kontrolü loopback üzerinden Nginx ve HTTPS (port 443 SNI desteği) ile test edildi ve `200 OK` doğrulandı.

6. **Root-Private Durable Receipt Store:**
   - `/var/lib/yunpanel/backups/websites/.restore-receipts/restore:<websiteId>:<digestPrefix>.json` altında `0600` izinli receipt yazıldı.
   - Başarılı restore sonucu `status: 'succeeded'`, `preRestoreSnapshotId` ve `healthCheck` ile kaydedildi.

7. **Idempotent Replay:**
   - Aynı previewDigest ve onay ile tekrar çağrılan `POST /api/panel/websites/:websiteId/restore`, dosyaları yeniden ezmeden mevcut makbuzu `idempotent: true` bayrağı ile döndürdü.

8. **Kasıtlı Sağlık Kontrolü Başarısızlığı ve Otomatik Rollback:**
   - Kasıtlı olarak başarısız olacak sağlık rotası (`/.env` -> HTTP 403 Forbidden) ile restore denendi.
   - Sağlık kontrolü başarısız oldu (`satisfied: false`, `statusCode: 403`).
   - Otomatik geri alma (rollback) devreye girdi ve `preRestoreSnapshotId` anlık görüntüsü dosya sistemine geri yüklendi.
   - İşlem `status: 'rolled_back'`, `rollbackReason: 'health_check_failed'` ile HTTP 422 döndü.
   - Diskteki makbuza rollback kaydı yazıldı.

## 3. Test Sonucu
Tüm adımlar (1/5'ten 5/5'e) `.28` test sunucusunda sıfır hata ile geçti.
Test tamamlandıktan sonra oluşturulan geçici restic repository ve snapshot'lar diskten temizlendi.
