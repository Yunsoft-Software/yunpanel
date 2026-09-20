# Website Restore Yaşam Döngüsü: Preview, Pre-Restore Snapshot ve Health Rollback (2026-09-20)

## 1. Kapsam ve Ürün Hedefi

`AGENTS.md` ve `docs/architecture.md` ilkelerine uygun olarak, geri yükleme (restore) işlemleri güvenli, yıkıcı olmayan önizlemeye dayalı, mutasyon öncesi otomatik pre-restore anlık görüntüsü ile korunan ve geri yükleme sonrası sağlık denetimi (health check) başarısız olduğunda otomatik geri alma (health rollback) mekanizmasına sahip olmalıdır.

`plan.md` P1.2 (Backup/restore) kapsamındaki dördüncü ve son alt madde tamamlandı:
- **Restore preview + pre-restore snapshot + health rollback**:
  - `apps/api/src/website-restore-service.js`:
    - `previewRestore`:
      - Hedef site (`websiteId`), restic deposu (`repositoryId`) ve anlık görüntü (`snapshotId`) doğrulanır.
      - Sitenin deposundaki anlık görüntüler `website:<websiteId>` etiketiyle listelenir ve hedef anlık görüntü bulunur.
      - Sağlık denetimi spesifikasyonu (`primaryDomain`, `healthPath`, `timeoutSeconds`) oluşturulur.
      - Deterministik SHA-256 `previewDigest` ve tipli onay dizgisi (`restore:<websiteId>:<snapshotId>:<previewDigest>`) üretilir.
    - `executeRestore`:
      - Güncel önizleme yeniden alınarak `expectedPreviewDigest` ve `confirmation` doğrulanır (uyumsuzlukta 409 `restore_preview_stale` / `restore_confirmation_invalid` fırlatılır).
      - **Adım 1 — Pre-Restore Snapshot**:
        - `websiteBackupSetProvider.getWebsiteBackupSet` ile sitenin canlı durumu derlenir.
        - Canlı durum `pre-restore` ve `restore-of:<snapshotId>` etiketleriyle restic anlık görüntüsüne aktarılır.
        - Pre-restore anlık görüntüsü alınamazsa işlem derhal durdurulur (`pre_restore_snapshot_failed`, 500); canlı sisteme hiçbir geri yükleme mutasyonu uygulanmaz (fail-closed).
      - **Adım 2 — Restore Yürütümü**:
        - `resticManager.restore` ile hedef anlık görüntü dosya sistemine geri yüklenir.
        - Geri yükleme sürecinde hata oluşursa derhal `preRestoreSnapshotId`'ye geri dönülür (`restore_execution_failed`, 500).
      - **Adım 3 — Sağlık Denetimi (Health Check)**:
        - `healthInspector.inspect` ile sitenin HTTP uç noktası denetlenir.
        - Sağlıklı ise `succeeded` durumu, anlık görüntü kimlikleri ve sağlık denetimi kanıtı dönülür.
      - **Adım 4 — Health Rollback**:
        - Sağlık denetimi başarısız olursa (`satisfied !== true`), sistem otomatik olarak `preRestoreSnapshotId` anlık görüntüsünü geri yükler.
        - `rolled_back` durumu, `rollbackReason: 'health_check_failed'`, pre-restore anlık görüntü kimliği ve başarısızlık ayrıntıları kaydedilip dönülür.
  - `apps/api/src/website-restore-http.js`:
    - `POST /api/websites/:websiteId/restore/preview`: Panel oturumuyla korunur, önizleme döner.
    - `POST /api/websites/:websiteId/restore`: Owner rolüyle korunur (`requireOwner`), geri yüklemeyi yürütür (başarıda 200, rollback durumunda 422 döner).
    - `isWebsiteRestoreHttpError` hata haritalama yardımcısı.
  - `apps/api/src/app.js`:
    - `websiteRestoreService` ve `mountWebsiteRestoreRoutes` entegrasyonu, hata middleware'i bağlantısı.

## 2. Doğrulama
- `node --test apps/api/test/website-restore-service.test.js`: 6 test geçti (önizleme üretimi, başarılı geri yükleme, sağlık denetimi başarısızlığında otomatik rollback, pre-restore hatasında fail-closed iptal, bayat özet ve geçersiz onay denetimleri).
- `node --test apps/api/test/website-restore-http.test.js`: 4 test geçti (200 önizleme, 200 başarılı restore, 403 yetkisiz erişim, 409 bayat önizleme).
- Tüm yedekleme ve geri yükleme testleri (46 test) hatasız geçti.
