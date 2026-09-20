# Website PHP Container Metadata Repair & Rollback Live Acceptance — 2026-09-20

## Özet

Ubuntu 24.04 LTS kurulu YunPanel test sunucusunda (`157.180.11.28` — `.28`, hostname `test`), `T-PROVISIONING` kapsamındaki aşağıdaki madde canlı ortamda uçtan uca doğrulanmıştır:

> Legacy PHP Website'te active release tree ve site-owned release/public (`0750`) canonical kalırken yalnız control-plane `applicationRoot`, `releasesDirectory` ve `current` symlink UID/GID/mode metadata'sı legacy drift taşıyan fixture ile `repair_php_container_metadata` acceptance yap. FPM pool/package/service/socket ve shared `UMask=0027` gerçekten sağlıklı olsun; audit exact source provisioning/release operation ID'sini yeni isolation migration operation ID'sinden ayrı pinlesin ve yalnız bu dar candidate için typed apply açsın. Receipt host mutation'dan önce previous UID/GID/mode'u root-private kaydetsin; apply yalnız üç exact path'e non-recursive `chown/chmod` uygulasın, release directory/public içeriğine dokunmasın. Mutation/evidence sınırlarında API restartında completed receipt inspection ile kapansın, incomplete state kör replay edilmesin. Typed rollback previous metadata'yı exact geri yüklesin; arada path symlink/type replacement veya foreign UID/GID/mode drift oluşursa destructive rollback fail-closed kalsın. Shared PHP-FPM package/service/pool/UMask, başka Website state'i ve release content hiçbir aşamada mutate edilmesin.

---

## Test Ortamı ve Hedef Kimlikler

- **Test Edilen Web Sitesi**: `provtest.webrich.news`
  - Website ID: `01944d99-9289-5b83-90f7-cec1402e6722`
  - Application ID: `392d53e7-a6f5-5f12-85cb-828a3f4211cf`
  - Canonical Unix User: `yunapp-d4c467173909` (UID 990, GID 990)
  - Source Provisioning/Release Operation ID: `861088e0-84f4-40ec-8df1-4edb5c77def9`
  - Control-Plane Yolları:
    - `applicationRoot`: `/var/lib/yunpanel/apps/392d53e7-a6f5-5f12-85cb-828a3f4211cf` (hedef `root:root 0755`)
    - `releasesDirectory`: `/var/lib/yunpanel/apps/392d53e7-a6f5-5f12-85cb-828a3f4211cf/releases` (hedef `root:root 0755`)
    - `currentRelease`: `/var/lib/yunpanel/apps/392d53e7-a6f5-5f12-85cb-828a3f4211cf/current` (hedef symlink `root:root`)
  - Dokunulmayan Release Ağacı:
    - `releaseDirectory`: `/var/lib/yunpanel/apps/392d53e7-a6f5-5f12-85cb-828a3f4211cf/releases/861088e0-84f4-40ec-8df1-4edb5c77def9` (`0750`, `yunapp-d4c467173909:yunapp-d4c467173909`)
    - `releaseDocumentRoot`: `.../public` (`0750`, `yunapp-d4c467173909:yunapp-d4c467173909`)
    - `index.php`: `.../public/index.php` (`0640`, `yunapp-d4c467173909:yunapp-d4c467173909`)
  - PHP-FPM Durumu:
    - Dağıtım Paketi: `php8.3-fpm` (Ubuntu 24.04, `8.3.6-0ubuntu0.24.04.11`)
    - Servis: `systemctl is-active php8.3-fpm` -> `active`
    - Sistem UMask: `systemctl show php8.3-fpm --property=UMask` -> `UMask=0027`
    - Site Havuzu: `/etc/php/8.3/fpm/pool.d/yunpanel-yunapp-d4c467173909.conf` (mode `0600`, `root:root`)
    - Dinleme Soketi: `/run/php/yunpanel-yunapp-d4c467173909.sock` (mode `0660`, `www-data:www-data`)
  - Staging Receipts: `/var/lib/yunpanel/staging/php-container-migrations/*.json` (mode `0600`, `root:root`)

---

## Doğrulanan Yaşam Döngüsü ve Güvenlik Adımları

### 1. Preconditions ve Canonical Baseline Doğrulaması
- Dağıtım paketi `php8.3-fpm` kurulu ve servisin `active` durumda olduğu, `UMask=0027` taşıdığı doğrulandı.
- Siteye özel PHP-FPM havuzu ve soketinin mevcut, doğru izinlerde ve aktif olduğu teyit edildi.
- Release içeriği (`releaseDirectory`, `public`, `index.php`) canonical site kullanıcısı mülkiyetinde (`yunapp-d4c467173909:yunapp-d4c467173909`, mode `0750`/`0640`) doğrulandı.

### 2. Legacy Control-Plane Metadata Drift Fixture Simülasyonu
- Yalnız control-plane metadata'sında legacy drift oluşturuldu:
  - `applicationRoot`: `yunapp-d4c467173909:yunapp-d4c467173909`, mode `0750`
  - `releasesDirectory`: `yunapp-d4c467173909:yunapp-d4c467173909`, mode `0750`
  - `current` symlink: `yunapp-d4c467173909:yunapp-d4c467173909` (`chown -h`)
- Release directory (`861088e0-...`) ve public içeriği canonical site user mülkiyetinde (`0750`) korundu.

### 3. Isolation Audit & Exact `repair_php_container_metadata` Preview
- `GET /api/panel/websites/:id/isolation-audit` çağrıldı:
  - `status: "migration_required"`, `migrationRequired: true`.
  - `changes.length: 1`.
  - `action: "repair_php_container_metadata"`.
  - `ownership: "operation_receipt_planned"`.
  - `applyState: "requires_explicit_apply"`.
  - `current.operationId: "861088e0-84f4-40ec-8df1-4edb5c77def9"` (exact source provisioning/release operation ID pinlendi).
  - `current.phpRuntimeMigrationPreview.safeContainerMigrationCandidate: true`.
  - `current.phpRuntimeMigrationPreview.current.container.safeMigrationCandidate: true`.
  - `migration.applyAvailable: true`.
  - `previewDigest`: `9fe84f982e4a57284b7608c9a140438aa60ef7261bf87a47a739abb154444fed`.
  - `confirmation`: `migrate-isolation:01944d99-9289-5b83-90f7-cec1402e6722:1:9fe84f982e4a57284b7608c9a140438aa60ef7261bf87a47a739abb154444fed`.
  - Uyarı: *“Apply changes only applicationRoot, releasesDirectory and current symlink control-plane UID/GID/mode under a durable receipt; release content stays site-owned and no recursive chown, chmod or remove is performed.”*

### 4. Fail-Closed Drift ve Hata Yönetimi
- **Foreign Release Drifti**: Release dizininin modu `0777` yapıldığında audit `applyAvailable: false` oldu; apply isteği `409 Conflict` ile reddedildi. Mod `0750`'ye geri alındı.
- **Current Symlink Target Drifti**: `current` symlink hedefi geçici olarak `/tmp` dizinine bağlandığında audit `applyAvailable: false` oldu; apply isteği `409 Conflict` ile reddedildi. Orijinal hedefe geri bağlandı.
- **PHP-FPM Servis İnaktif Drifti**: `systemctl stop php8.3-fpm` yapıldığında audit `applyAvailable: false` oldu; apply isteği `409 Conflict` ile reddedildi. Servis tekrar başlatıldı.
- **Tahrif Edilmiş Digest / Onay**: Yanlış digest ile onay denemesi `409 Conflict` ile reddedildi.
- **Malformed Body**: Beklenmeyen ek alanlar içeren istek `400 Bad Request` ile reddedildi.
- **Geçersiz Website UUID**: Regex dışı UUID `400 Bad Request` (`invalid_website_id`) ile reddedildi.
- **Bulunamayan Website**: Var olmayan geçerli v4 UUID `404 Not Found` (`website_not_found`) ile fail-closed kaldı.

### 5. Typed-Confirmation Apply & Non-Recursive Mutation
- Temiz drift durumunda geçerli confirmation ile migrasyon çalıştırıldı (`POST /api/panel/websites/:id/isolation-migrations`):
  - Operasyon başarıyla tamamlandı (`status: "succeeded"`).
  - Operasyon ID'si (`0bfdc801-ad8f-409d-8d78-8c39da59f803`), kaynak operasyon ID'sinden (`861088e0-...`) ayrı, bağımsız bir migration ID olarak üretildi.
  - Result Evidence: `phpContainerReceiptVersion: 1`, `migratedPhpContainer: true`, `satisfied: true`.
- **Host Seviyesinde Makbuz ve Dosya Sistemi Doğrulaması**:
  - Root-private Makbuz: `/var/lib/yunpanel/staging/php-container-migrations/0bfdc801-ad8f-409d-8d78-8c39da59f803.json`:
    - Mode `0600`, UID 0 (root), GID 0 (root).
    - `state: "active"`.
    - `previous` metadata: `applicationRoot` (uid 990, gid 990, mode 0750), `releasesDirectory` (uid 990, gid 990, mode 0750), `currentRelease` (uid 990, gid 990).
  - Inode Doğrulamaları:
    - `applicationRoot`: `root:root`, mode `0755` (düzeltildi).
    - `releasesDirectory`: `root:root`, mode `0755` (düzeltildi).
    - `current`: `root:root` symlink (düzeltildi).
    - `releaseDirectory`: `yunapp-d4c467173909:yunapp-d4c467173909`, mode `0750` (kesinlikle dokunulmadı).
    - `releaseDocumentRoot`: `yunapp-d4c467173909:yunapp-d4c467173909`, mode `0750` (kesinlikle dokunulmadı).
    - `index.php`: `yunapp-d4c467173909:yunapp-d4c467173909`, mode `0640` (kesinlikle dokunulmadı).
    - Paylaşılan PHP-FPM servisi, havuzu ve soketi bozulmadan aktif kaldı.

### 6. API Restart Sınırı & Receipt Inspection
- `systemctl restart yunpanel-api` ile backend servisi yeniden başlatıldı.
- `GET /api/panel/websites/:id/isolation-migrations/:migrationOpId` sorgulandı:
  - Durum `succeeded` olarak korundu.
  - Makbuz ve dosya sistemi inspect edilerek doğrulandı, kör replay veya mükerrer host mutation yapılmadı.

### 7. Typed Rollback & Destructive Rollback Koruması
- Geçersiz rollback onayı `400 Bad Request` ile reddedildi.
- **Destructive Rollback Koruması (Foreign Drift)**: `current` symlink'e yabancı UID (`1234:1234`) verildiğinde rollback denemesi yıkıcı işlem yapmadı, `compensation_failed` döndü; `applicationRoot` ve `releasesDirectory` korundu.
- Yabancı drift temizlendikten sonra geçerli onay (`rollback-isolation-migration:<opId>:<digest>`) ile rollback çalıştırıldı:
  - Durum: `compensated`.
  - Compensation Evidence: `restoredPhpContainerMetadata: true`.
- **Host Doğrulaması**:
  - `applicationRoot`: `yunapp-d4c467173909:yunapp-d4c467173909`, mode `0750` olarak exact geri yüklendi.
  - `releasesDirectory`: `yunapp-d4c467173909:yunapp-d4c467173909`, mode `0750` olarak exact geri yüklendi.
  - `current` symlink: `yunapp-d4c467173909:yunapp-d4c467173909` olarak exact geri yüklendi.
  - `releaseDirectory` ve `public` içeriği yine `yunapp-d4c467173909:yunapp-d4c467173909 0750` olarak sağlam kaldı.
  - Makbuz dosyası `state: "compensated"` olarak güncellendi.
  - Paylaşılan PHP-FPM havuzu/servisi/UMask'ı hiçbir aşamada bozulmadı.

### 8. Sağlıklı Canonical Duruma Dönüş
- Rollback sonrası audit tekrar çağrıldı: `migration_required`, `safeContainerMigrationCandidate: true`.
- Yeni apply migrasyonu çalıştırıldı:
  - Durum `succeeded`.
  - Host control-plane mülkiyeti tekrar canonical `root:root 0755` oldu.
- Nihai audit çağrıldı:
  - `status: "isolated"`.
  - `migrationRequired: false`.
  - `findings: []`.
  - Tüm adımlar (`unix_identity`, `php_runtime`, `sftp`) `satisfied: true`.
