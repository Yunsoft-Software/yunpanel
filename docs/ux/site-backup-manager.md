# BACKUP-UI — Site Backup Manager kaynak dilimi

2026-09-25 · development · başlangıç `4ff939e36dc84450470c877bae2db6a20cb49568`.
UX-PL-04/06 ve PROD-13 alt dilimi. Mevcut Restic/restore motoru korunur; ikinci backup motoru yazılmaz.

## Tamamlanan kaynak

- [x] **BACKUP-UI-01 site-scope API:** `06bc9fc3`; yeni `GET /api/websites/:websiteId/backups` yalnız doğrulanmış Website sunucusundaki repository kayıtlarını ve yalnız `website:<WebsiteID>` etiketiyle eşleşen snapshotları projekte eder. Repository target/path, raw error, snapshot path/hostname/username ve secret bilgileri site cevabına girmez.
- [x] **BACKUP-UI-01 global sınır:** site_manager genel `/api/backups/...` repository/remote/snapshot envanterine erişemez. Owner'ın mevcut global Backup Repository rotaları değişmedi.
- [x] **BACKUP-UI-02 site ekranı:** `300f813a`; Site → Barındırma ve DNS → **Yedekleme ve Geri Yükleme**. Yedek kapsam sayıları, depo sağlık/retention özeti, son kontrol/snapshot ve yalnız siteye ait snapshot listesi görünür. Genel Bakış ve Barındırma kısayolları eklendi. Files/cron/PHP/SSL rotaları korunur.
- [x] **BACKUP-UI-02 mutation sınırı:** mevcut `executeBackup` ve `executeRestore` senkron host mutation'ları UI'ye bağlanmadı. Kayıp HTTP cevabında backup/restore replay güvenliği kanıtlı değildir.
- [ ] **BACKUP-UI-03 durable mutation:** mevcut Restic/restore servislerini yeniden kullanarak durable job + preview/confirmation + aynı-job takip + restart evidence/recovery hattı kur. Restore pre-snapshot/health rollback sonucu job sonucuyla tutarlı olmalı. Mevcut Owner-only mutation politikası kaynak geçişiyle gevşetilmez.
- [ ] **BACKUP-UI-04 test/kabul:** yeni API/model/wiring testleri yazıldı fakat checkout DNS engeli nedeniyle çalıştırılmış sayılmaz. Node24/npm11 tam test/build, gerçek Restic depo, Owner/Site A/Site B tarayıcı ve restart/unknown-result kabulü açık.

## Güvenlik sınırı

Site manager'a repository target, yerel dosya yolu, rclone hedefi, raw Restic stderr, host adı veya Unix kullanıcı adı verilmez. Snapshot browser 100 kayıtla sınırlıdır. Repository snapshot okuması başarısızsa UI yalnız `Okunamadı` gösterir.

Mevcut backup/restore servisleri preview, pre-restore snapshot, health check ve rollback davranışına sahiptir; fakat HTTP çağrısının kendisi durable job değildir. Senkron Owner endpoint'lerinin varlığı güvenli Backup Manager mutation akışının tamamlandığı anlamına gelmez.

## T-DEV-BACKUP-UI

- [ ] Node >=24.11.1/npm >=11 gerçek checkout: yeni `website-backup-browser.test.js`, `website-backup-scope-source.test.js`, `site-backup-model.test.js`, `site-backup-wiring.test.js` ile mevcut backup/restore/restic/site-resource-boundary regresyonlarını çalıştır; tam lint/test/build.
- [ ] Owner ve iki site_manager: Site A yalnız Site A snapshotları; Site B başka repository/snapshot bilgisi görememeli. Global backup repository/remotes/snapshot listeleri site_manager için 403 olmalı.
- [ ] Repository ready/error/uninitialized, locked/unreachable ve 100+ snapshot. Raw target/path/hostname/username/error cevaba veya UI'ye girmemeli.
- [ ] Chromium/Firefox 320/390/834/1440 px, %200 zoom, klavye, reload/back/forward, site değişimi, stale/403/500. Files/cron/PHP/SSL deep link regresyonları.
- [ ] BACKUP-UI-03 sonrası ağ kopması, API/worker restartı, çift tıklama, aynı Website eşzamanlı backup/restore, pre-restore snapshot ve unhealthy rollback gerçek hostta doğrulansın. `.44` Plesk hostuna dokunma.
