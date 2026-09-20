# Özel Yedekleme Arşiv (Custom Backup Archive) Yollarının Kaldırılması

**Tarih**: 2026-09-21  
**Kapsam**: `plan.md` P2 — "restic acceptance sonrası custom backup archive yollarını kaldır."

---

## 1. Amaç ve Mimari Karar

`AGENTS.md` ve `docs/architecture.md` uyarınca:
- "Backup veri düzlemi restic, remote transport gerektiğinde rclone'dur. YunPanel repository policy, hook, evidence, retention ve restore orchestration yapar; yeni özel archive formatı üretmez."
- `docs/architecture.md` satır 200: "büyütülmekte olan özel aggregate archive/remote backup motoru, restic+rclone adapter'ı hazır olduğunda [kaldırılacak]".
- `docs/history/website-backup-restore-rclone-live-acceptance-2026-09-21.md` ile canlı test sunucusunda (`.28`) Restic (0.16.4) ve Rclone tabanlı depo yönetimi, anlık görüntü alımı (snapshot), satıcı dökümü kancaları (MariaDB vendor dump), geri yükleme (restore), otomatik pre-restore snapshot ve saklama politikası budaması (retention prune) uçtan uca kabul edilmiştir.

Bu kabul sonrasında, Restic öncesi döneme ait özel tar arşivleme motoru ve buna bağlı yerel yürütücüler kod tabanından temizlenmiştir.

---

## 2. Kaldırılan ve Güncellenen Bileşenler

### A. Kaldırılan Dosyalar (`git rm`)
1. **`packages/host-runtime/src/local-backup-artifact-manager.js`**:
   - `/usr/bin/tar` komutunu doğrudan çağırarak `/var/lib/yunpanel/backups/resources` altında özel `.tar` ve `.json` makbuzu üreten eski arşiv yöneticisi tamamen kaldırıldı.
2. **`packages/host-runtime/test/local-backup-artifact-manager.test.js`**:
   - İlgili birim testleri kaldırıldı.
3. **`apps/api/src/backup-application-local-executor.js`**:
   - Statik ve Node uygulamaları için `localBackupArtifactManager` üzerinden özel `.tar` arşivi oluşturan `application_snapshot` yerel yürütücüsü kaldırıldı.
4. **`apps/api/test/backup-application-local-executor.test.js`**:
   - İlgili birim testleri kaldırıldı.
5. **`apps/api/src/backup-docker-local-executor.js`**:
   - Docker Compose depolama alanları ve birimleri için `localBackupArtifactManager` üzerinden özel `.tar` arşivi oluşturan `docker_storage_backup` yerel yürütücüsü kaldırıldı.
6. **`apps/api/test/backup-docker-local-executor.test.js`**:
   - İlgili birim testleri kaldırıldı.

### B. Güncellenen Dosyalar
1. **`packages/host-runtime/src/index.js`**:
   - `createLocalBackupArtifactManager`, `LocalBackupArtifactError`, `localBackupArtifactInternals` dışa aktarımı kaldırıldı.
2. **`apps/api/src/backup-production-runtime.js`**:
   - Emekliye ayrılan özel tar arşiv yerel yürütücülerine ait bağımlılıklar (`createLocalBackupArtifactManager`, `createBackupApplicationLocalExecutor`, `createBackupDockerLocalExecutor`) kaldırıldı.
   - `localExecutors` varsayılan olarak boş nesneye (`{}`) çekildi.
   - Eski orkestratör çağrılarında `application_snapshot` veya `docker_storage_backup` gibi özel tar yürütücüsü adımları gelirse orkestratörün `assertExecutors` mekanizması `backup_executor_unavailable` (503) ile fail-closed kalmaya devam eder.
3. **`apps/api/test/backup-production-runtime.test.js`**:
   - Üretim çalışma ortamının emekliye ayrılan özel tar yürütücülerini barındırmadığını ve varsayılan olarak boş `localExecutors` sunduğunu doğrulayan testler güncellendi.

---

## 3. Doğrulama ve Test Sonuçları

- Node 24 (`v24.21.0`) ortamında tüm paketlerde `npm run check` eksiksiz çalıştırıldı.
- Sonuç: **Tüm test paketleri (host-runtime 723 test, shared 40 test, protocol 77 test, api ve web testleri) %100 başarıyla geçti, Vite frontend derlemesi hatasız tamamlandı.**
