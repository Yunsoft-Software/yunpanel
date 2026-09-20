# Website Backup, Restore, Restic Repositories, and Rclone Remotes Live Acceptance Report

**Tarih**: 2026-09-21  
**Hedef Sunucu**: `157.180.11.28` (hostname: `test`, Ubuntu 24.04 LTS)  
**Server ID**: `99bc760a-d508-4ae6-92be-efdedee9658d`  
**Test Edilen Web Sitesi**: `webrich.news` (Website ID: `2689cb56-55a4-50c0-a3a4-258c7f2d48dd`)  
**Kapsam**: `T-BACKUP` lines 53-56 — Rclone Remotes CRUD and test API, Restic Repositories CRUD / init / check / unlock / retention prune API, Website Backup Set inspection, Website Backup preview with failure injection, Website Backup execution with MariaDB vendor dump hook, staged root cleanup, repository snapshot listing, Website Restore preview with failure injection, and Website Restore execution with automatic pre-restore snapshot and health check verification.

---

## 1. Özet ve Kabul Sonuçları

`todo.md` dosyasındaki `T-BACKUP` maddeleri uyarınca, canlı test sunucusu (`.28`) üzerinde tam yedekleme ve geri yükleme döngüsü uçtan uca test edilmiş ve eksiksiz doğrulanmıştır.

### Başarıyla Doğrulanan Aşamalar:

1. **Rclone Remote Yönetimi API (`/api/backups/remotes`)**:
   - Uzak depolar listelendi (`GET /api/backups/remotes`).
   - S3-compatible uzak depo oluşturuldu (`POST /api/backups/remotes`). Kimlik bilgileri (`access_key_id`, `secret_access_key`) AES-256-GCM ile şifrelendi, yanıtta gizlendi (`credentials` alanı dışarı sızmadı).
   - Uzak depo detayları sorgulandı (`GET /api/backups/remotes/:remoteId`).
   - Uzak depo bağlantı testi çalıştırıldı (`POST /api/backups/remotes/:remoteId/test`).
   - Uzak depo silindi (`DELETE /api/backups/remotes/:remoteId`).

2. **Restic Repository Yönetimi API (`/api/backups/repositories`)**:
   - Yerel kök-özel (`0700`) Restic deposu oluşturuldu ve başlatıldı (`POST /api/backups/repositories`). Depo şifresi AES-256-GCM ile şifrelenerek registry'de saklandı.
   - Depo durumu sorgulandı (`GET /api/backups/repositories/:repositoryId`), `status: 'ready'` olduğu doğrulandı.
   - Depo bütünlük denetimi çalıştırıldı (`POST /api/backups/repositories/:repositoryId/check`), `healthy: true` kanıtı alındı.
   - Depo kilidi kaldırıldı (`POST /api/backups/repositories/:repositoryId/unlock`).

3. **Website Backup Preview ve Hata Enjeksiyonu**:
   - `webrich.news` web sitesine ait yedekleme seti alındı (`GET /api/websites/:websiteId/backup-set`). Sitede tanımlı olan `site_a_db` MariaDB veritabanı hook'unun, ortam değişkenlerinin ve Nginx konfigürasyonunun dahil olduğu doğrulandı.
   - Yedekleme önizlemesi alındı (`POST /api/websites/:websiteId/backup/preview`). Deterministik `backupSetDigest` ve `backup:<websiteId>:<repositoryId>:<digest>` biçiminde `confirmation` tokenı üretildi.
   - Hata Enjeksiyonu (Bayat Özet): Geçersiz/eski özetle yedekleme isteği 409 `backup_preview_stale` ile reddedildi.
   - Hata Enjeksiyonu (Geçersiz Onay): Hatalı confirmation değeri 409 `backup_confirmation_invalid` ile reddedildi.

4. **Website Backup Yürütümü**:
   - Geçerli önizleme ve onay ile `POST /api/websites/:websiteId/backup` çağrıldı.
   - Pre-hooklar çalıştırıldı:
     - `mariadb-dump --single-transaction site_a_db` komutu çalıştırılarak veritabanı dökümü geçici staging dizinine (`backupSet.stagedRoot`) yazıldı.
     - Ortam değişkenleri metadata dosyası staged dizine yazıldı.
     - Nginx vhost konfigürasyonu staged dizine kopyalandı.
     - DNS zon kayıtları staged dizine snapshot alındı.
   - Restic anlık görüntüsü (`createSnapshot`) başarıyla alındı (`filesNew: 7`, `filesChanged: 0`).
   - `finally` bloğunda geçici staging dizininin sunucudan tamamen temizlendiği doğrulandı.

5. **Depo Anlık Görüntü Doğrulaması**:
   - `GET /api/backups/repositories/:repositoryId/snapshots` ile anlık görüntüler sorgulandı.
   - Üretilen anlık görüntünün (`snapshotId: 1ec519d08e7e...`) depoda yer aldığı, etiketlerinin (`website:...`, `runtime:php`, `live-acceptance`, `node24`) eksiksiz korunduğu doğrulandı.

6. **Website Restore Preview ve Hata Enjeksiyonu**:
   - Anlık görüntü için geri yükleme önizlemesi alındı (`POST /api/websites/:websiteId/restore/preview`).
   - Deterministik `previewDigest` ve `restore:<websiteId>:<snapshotId>:<digest>` onay tokenı üretildi.
   - Hata Enjeksiyonu (Bayat Özet): 409 `restore_preview_stale` ile reddedildi.
   - Hata Enjeksiyonu (Geçersiz Onay): 409 `restore_confirmation_invalid` ile reddedildi.

7. **Pre-Restore Anlık Görüntülü ve Sağlık Denetimli Restore**:
   - Geçerli onay ile `POST /api/websites/:websiteId/restore` yürütüldü.
   - Geri yükleme öncesinde otomatik güvenlik snapshot'ı oluşturuldu (`preRestoreSnapshotId: 9e34de5c6f1e...`).
   - Dosyalar geri yüklendi ve HTTP sağlık denetimi başarıyla tamamlandı (`status: 'succeeded'`).

8. **Saklama Politikası ve Prune (Retention Prune)**:
   - Depo üzerinde dry-run saklama politikası işletildi (`POST /api/backups/repositories/:repositoryId/prune` with `dryRun: true`).
   - Gerçek saklama ve temizlik işletildi (`dryRun: false`).
   - Test deposu kaydı ve diskteki geçici dosyalar temizlendi (`DELETE /api/backups/repositories/:repositoryId`).
