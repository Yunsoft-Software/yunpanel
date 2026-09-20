# Website Static Control Metadata Repair & Rollback Live Acceptance — 2026-09-20

## Özet

Ubuntu 24.04 LTS kurulu YunPanel test sunucusunda (`157.180.11.28` — `.28`, hostname `test`), `T-PROVISIONING` kapsamındaki aşağıdaki madde canlı ortamda uçtan uca doğrulanmıştır:

> Legacy static Website'te managed release dosyaları/dizinleri site UID/GID + `0750/0640` ve `www-data` read ACL açısından zaten sağlıklıyken yalnız `publishRoot`, `releasesRoot` ve `current` symlink control-plane metadata drift fixture'ı ile `repair_static_control_metadata` acceptance yap. Typed apply mutation öncesi root-private receipt'e previous UID/GID/mode + current target yazsın; yalnız bu üç exact path'i non-recursive düzeltsin, release dosyaları veya ACL'lerde `-R` mutation çalıştırmasın. API restart completed receipt'i inspect ile kapatsın, incomplete state'i kör replay etmesin. Typed rollback previous metadata'yı exact geri yüklesin; current target değişmişse, path type/symlink replacement veya foreign metadata drift varsa fail-closed kalsın. Başka Website static tree'sine dokunulmadığını doğrula.

---

## Test Ortamı ve Hedef Kimlikler

- **Hedef Sunucu**: `157.180.11.28` (Ubuntu 24.04 LTS, hostname `test`)
- **Test Edilen Web Sitesi**: `yunpanel-static-deploy.test`
  - Website ID: `ed6dbfee-b769-5704-8216-32c4258b56d2`
  - Application ID: `6e7cf4c6-85c4-49c5-a635-6ddcf068d163`
  - Runtime Türü: `static`
  - Canonical Unix User: `yunapp-264d0ba10e07` (UID 996, GID 996)
  - Home / Workspace Dizini: `/var/lib/yunpanel/data/6e7cf4c6-85c4-49c5-a635-6ddcf068d163` (mode `0750`, `tmp` `0700`, `logs` `0750`)
- **Control-Plane Yolları**:
  - `publishRoot`: `/var/www/yunpanel/apps/6e7cf4c6-85c4-49c5-a635-6ddcf068d163` (hedef `root:root 0711`)
  - `releasesRoot`: `/var/www/yunpanel/apps/6e7cf4c6-85c4-49c5-a635-6ddcf068d163/releases` (hedef `root:root 0711`)
  - `current`: `/var/www/yunpanel/apps/6e7cf4c6-85c4-49c5-a635-6ddcf068d163/current` (hedef symlink `root:root` -> `releases/b0ed679c-44a1-4960-984d-858c63eb4e37`)
- **Dokunulmayan Release Ağacı**:
  - `releases/b0ed679c-44a1-4960-984d-858c63eb4e37`: dizinler `0750`, dosyalar `0640`, mülkiyet `yunapp-264d0ba10e07:yunapp-264d0ba10e07`, POSIX ACL `user:www-data:r-x` ve `user:www-data:r--`
  - `releases/f1e4f36f-7b8a-46c9-9071-911ff6fc7ee4`: dizinler `0750`, dosyalar `0640`, mülkiyet `yunapp-264d0ba10e07:yunapp-264d0ba10e07`, POSIX ACL `user:www-data:r-x` ve `user:www-data:r--`
- **Başka Website Static Tree İzolasyon Denetimi**:
  - `/var/www/yunpanel/apps/other-static-canary-fixture` (UID 1000, mode `0755`/`0644`) ile başka siteye ait dosya ağacı oluşturuldu ve operasyonlar boyunca zerre kadar etkilenmediği kanıtlandı.
- **Staging Receipts**: `/var/lib/yunpanel/staging/static-control-migrations/*.json` (mode `0600`, `root:root`)

---

## Doğrulanan Yaşam Döngüsü ve Güvenlik Adımları

### 1. Preconditions ve Canonical Baseline Doğrulaması
- Site kullanıcısı `yunapp-264d0ba10e07` (UID 996, GID 996) ve home dizini `/var/lib/yunpanel/data/6e7cf4c6-85c4-49c5-a635-6ddcf068d163` doğrulandı.
- `current` symlink'inin `releases/b0ed679c-44a1-4960-984d-858c63eb4e37` hedefine baktığı teyit edildi.
- Release içerikleri (`index.html`, `assets`) ve dizinleri canonical site kullanıcısı mülkiyetinde (`0750`/`0640`) ve Nginx POSIX ACL (`user:www-data:r-x`/`r--`) ile doğrulandı.
- Başka web sitelerinin statik ağaçlarını temsil eden bağımsız fixture (`other-static-canary-fixture`, UID 1000) oluşturuldu.

### 2. Legacy Control-Plane Metadata Drift Fixture Simülasyonu
- Sadece üç control-plane yolunda legacy drift enjekte edildi:
  - `publishRoot`: `yunapp-264d0ba10e07:yunapp-264d0ba10e07`, mode `0750`
  - `releasesRoot`: `yunapp-264d0ba10e07:yunapp-264d0ba10e07`, mode `0750`
  - `current` symlink: `yunapp-264d0ba10e07:yunapp-264d0ba10e07` (`chown -h`)
- Release dizinleri ve içerikleri site user mülkiyetinde ve ACL korumasında bırakıldı; canary fixture'a dokunulmadı.

### 3. Isolation Audit & Exact `repair_static_control_metadata` Preview
- `GET /api/panel/websites/:id/isolation-audit` çağrıldı:
  - `status: "migration_required"`, `migrationRequired: true`.
  - `changes.length: 1`.
  - `action: "repair_static_control_metadata"`.
  - `ownership: "operation_receipt_planned"`.
  - `applyState: "requires_explicit_apply"`.
  - `current.staticRuntimeMigrationPreview.safeControlMigrationCandidate: true`.
  - `current.staticRuntimeMigrationPreview.differences: ["static_publish_container_drift", "static_publish_current_drift"]`.
  - `migration.applyAvailable: true`.
  - `previewDigest`: `5864dccc036032cfd03b22f97d3b800d2c8494707521e5a65ae9701293c0fde8`.
  - `confirmation`: `migrate-isolation:ed6dbfee-b769-5704-8216-32c4258b56d2:1:5864dccc...`.
  - Uyarı metni kontratla tam eşleşti: *“Apply changes only static publishRoot, releasesRoot and current symlink control-plane UID/GID/mode under a durable receipt; release files and Nginx ACLs must already be healthy and are never recursively repaired by this migration.”*

### 4. Fail-Closed Drift ve Hata Yönetimi
- **Foreign Release İzin Drifti**: Release dizininin modu `0777` yapıldığında `repair_static_control_metadata` adaylığı düştü (`action !== 'repair_static_control_metadata'`); önceki confirmation ile apply denemesi `409 Conflict` ile reddedildi. Mod `0750`'ye geri alındı.
- **Yönetilmeyen Release Girişi Drifti (Symlink)**: Release içine yönetilmeyen symlink eklendiğinde audit doğrudan `applyAvailable: false` ve `action: "reconcile_isolation_step"` üretti; apply denemesi `409 Conflict` ile fail-closed kaldı. Symlink kaldırıldı.
- **Current Symlink Hedef Drifti**: `current` symlink hedefi `/tmp` yapıldığında audit `applyAvailable: false` oldu; apply isteği `409 Conflict` ile reddedildi. Orijinal hedefe geri bağlandı.
- **Tahrif Edilmiş Digest / Onay**: Yanlış digest ile onay denemesi `409 Conflict` ile reddedildi.
- **Malformed Body**: Beklenmeyen ek alanlar içeren istek `400 Bad Request` ile reddedildi.
- **Geçersiz Website UUID**: Regex dışı UUID `400 Bad Request` ile reddedildi.
- **Bulunamayan Website**: Var olmayan v4 UUID `404 Not Found` ile fail-closed kaldı.

### 5. Typed-Confirmation Apply & Non-Recursive Mutation
- Temiz drift durumunda geçerli confirmation ile migrasyon çalıştırıldı (`POST /api/panel/websites/:id/isolation-migrations`):
  - Operasyon başarıyla tamamlandı (`status: "succeeded"`).
  - Operasyon ID: `87bc944d-d24a-4986-8736-b5381f5b1d0d`.
  - Result Evidence: `staticControlReceiptVersion: 1`, `migratedStaticControlMetadata: true`, `satisfied: true`.
- **Host Seviyesinde Makbuz ve Dosya Sistemi Doğrulaması**:
  - Root-private Makbuz: `/var/lib/yunpanel/staging/static-control-migrations/87bc944d-d24a-4986-8736-b5381f5b1d0d.json`:
    - Mode `0600`, UID 0 (root), GID 0 (root).
    - `state: "active"`.
    - `previous` metadata: `publishRoot` (uid 996, gid 996, mode 488/0750), `releasesRoot` (uid 996, gid 996, mode 488/0750), `current` (uid 996, gid 996).
    - `currentTarget: "releases/b0ed679c-44a1-4960-984d-858c63eb4e37"`.
  - Inode Doğrulamaları:
    - `publishRoot`: `root:root`, mode `0711` (düzeltildi).
    - `releasesRoot`: `root:root`, mode `0711` (düzeltildi).
    - `current`: `root:root` symlink (düzeltildi).
    - `releases/b0ed679c...` dizini: `yunapp-264d0ba10e07:yunapp-264d0ba10e07`, mode `0750` (kesinlikle dokunulmadı).
    - `index.html`: `yunapp-264d0ba10e07:yunapp-264d0ba10e07`, mode `0640` (kesinlikle dokunulmadı).
    - Başka web sitesinin statik ağacı (`other-static-canary-fixture`): UID 1000 olarak korundu, hiçbir işlem yapılmadı.

### 6. API Restart Sınırı & Receipt Inspection
- `systemctl restart yunpanel-api` ile backend servisi yeniden başlatıldı.
- `GET /api/panel/websites/:id/isolation-migrations/:operationId` sorgulandı:
  - Durum `succeeded` olarak korundu.
  - Makbuz ve dosya sistemi inspect edilerek doğrulandı, kör replay veya mükerrer host mutation yapılmadı.

### 7. Typed Rollback & Destructive Rollback Koruması
- **Geçersiz Rollback Onayı**: Yanlış format `400 Bad Request` ile reddedildi.
- **Current Target Drift Koruması**: `current` symlink'i `releases/f1e4f36f-...` hedefine bağlandığında rollback `status: "compensation_failed"` ve `error: "static_publish_migration_compensation_drift"` döndü; `publishRoot` ve `releasesRoot`'un yıkıcı şekilde geri alınması engellendi.
- **Path Type Drift Koruması**: `current` symlink silinip normal dosya (`touch`) yapıldığında rollback `status: "compensation_failed"` ve `error: "static_publish_migration_path_type_drift"` döndü; yıkıcı rollback engellendi.
- **Foreign Metadata Drift Koruması**: `current` symlink'inin mülkiyeti `1000:1000` (yabancı kullanıcı) yapıldığında rollback `status: "compensation_failed"` ve `error: "static_publish_migration_compensation_drift"` döndü; yıkıcı rollback engellendi.
- **Geçerli Rollback Uygulaması**:
  - `POST /api/panel/websites/:id/isolation-migrations/:operationId/rollback` çağrıldı.
  - HTTP 200, `status: "compensated"`, `compensation.restoredStaticControlMetadata: true`.
  - Inode doğrulaması: `publishRoot` (`996:996 0750`), `releasesRoot` (`996:996 0750`), `current` (`996:996`).
  - Makbuz durumu: `state: "compensated"`.
  - Başka sitenin canary ağacı yine tamamen dokunulmamış kaldı.

### 8. Baseline Canonical Durumuna Geri Dönüş ve Nihai Audit
- `publishRoot` ve `releasesRoot` canonical `root:root 0711`'e, `current` symlink `root:root`'a getirildi.
- Canary test fixture'ı (`other-static-canary-fixture`) temizlendi.
- `GET /api/panel/websites/:id/isolation-audit` çağrıldı:
  - `status: "isolated"`
  - `migrationRequired: false`
  - `findings: []`
  - Statik web sitesinin tam izolasyon sağladığı canlı olarak kanıtlandı.

---

## Sonuç

`T-PROVISIONING` kapsamındaki `repair_static_control_metadata` acceptance maddesi, Ubuntu 24.04 LTS test sunucusunda (`157.180.11.28`) tüm güvenlik, makbuz, non-recursive izin düzeltme, API restart inspection, destructive rollback koruması ve çapraz-site ağaç izolasyonu sınırlarıyla eksiksiz doğrulanmıştır.
