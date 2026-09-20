# Website PHP-FPM Pool Isolation Migration & Rollback Live Acceptance — 2026-09-20

## Özet

Ubuntu 24.04 LTS kurulu YunPanel test sunucusunda (`157.180.11.28` — `.28`, hostname `test`), `T-PROVISIONING` kapsamındaki aşağıdaki madde canlı ortamda uçtan uca doğrulanmıştır:

> Legacy PHP Website'te canonical container ownership/path, distro PHP-FPM package + aktif shared service ve `UMask=0027` zaten sağlıklıyken yalnız site-specific FPM pool/socket eksik fixture ile isolation migration'ı doğrula. Audit yalnız exact `safeCreateCandidate` preview için apply açsın; typed-confirmation apply durable isolation journal + PHP-FPM receipt yazıp yalnız site pool'u oluştursun, package install/service enable/container chown-chmod çalıştırmasın. API mutation/evidence sınırında restart edilince completed receipt inspection ile kapanmalı ve pool create kör replay edilmemeli. Existing pool, package/service/UMask/container drift fail-closed kalsın. Typed rollback yalnız operation-created pool'u kaldırıp shared PHP-FPM service/package, UMask, release/container ownership ve başka Website pool'larını korusun.

---

## Test Ortamı ve Hedef Kimlikler

- **Test Edilen Web Sitesi**: `provtest.webrich.news`
  - Website ID: `01944d99-9289-5b83-90f7-cec1402e6722`
  - Application ID: `392d53e7-a6f5-5f12-85cb-828a3f4211cf`
  - Canonical Unix User: `yunapp-d4c467173909` (UID 990, GID 990)
  - PHP Versiyonu: `8.3` (`php8.3-fpm`)
  - Container Root: `/var/lib/yunpanel/apps/392d53e7-a6f5-5f12-85cb-828a3f4211cf` (mode `0755`, `root:root`)
  - Site-Specific Pool: `/etc/php/8.3/fpm/pool.d/yunpanel-yunapp-d4c467173909.conf` (mode `0644`, `root:root`)
  - Site Listen Socket: `/run/php/yunpanel-yunapp-d4c467173909.sock`
  - Shared Service: `systemctl is-active php8.3-fpm` -> `active`
  - Diğer Korunan Havuzlar: `/etc/php/8.3/fpm/pool.d/yunpanel-elfinder-yunapp-d4c467173909.conf`, `/etc/php/8.3/fpm/pool.d/www.conf`
  - Staging Receipts: `/var/lib/yunpanel/staging/php-fpm-sites/*.json` (mode `0600`, `root:root`)

---

## Doğrulanan Yaşam Döngüsü ve Güvenlik Adımları

### 1. Preconditions ve All-Missing Site Pool Durumu
- Canonical container ownership/path (`/var/lib/yunpanel/apps/392d53e7-a6f5-5f12-85cb-828a3f4211cf`, root:root 0755) doğrulandı.
- Dağıtım paketi `php8.3-fpm` kurulu ve paylaşılan servis `php8.3-fpm`'in `active` durumda olduğu teyit edildi.
- Sistem UMask'ı (`0027`), diğer havuzlar (`www.conf`, `yunpanel-elfinder-*.conf`) ve Unix kimliği (`yunapp-d4c467173909`) doğrulandı.
- Yalnız site-specific PHP-FPM havuzu (`yunpanel-yunapp-d4c467173909.conf`) ve soketi kaldırılarak eksik havuz senaryosu simüle edildi.
- Host doğrulaması: Site havuz dosyası ve soketi yok; paylaşılan servis ve diğer havuzlar aktif.

### 2. Isolation Audit & Exact `safeCreateCandidate` Preview
- `GET /api/panel/websites/:id/isolation-audit` çağrıldı:
  - `status: "migration_required"`, `migrationRequired: true`.
  - `changes.length: 1`.
  - `action: "create_php_fpm_pool"`.
  - `applyState: "requires_explicit_apply"`.
  - `ownership: "operation_receipt_planned"`.
  - `current.phpMigrationPreview.safeCreateCandidate: true`.
  - `migration.applyAvailable: true`.
  - `previewDigest`: `36af5eac7604e4814db582972e35fd8d445e63a4feaf675767f5f58408cee284`.
  - `confirmation`: `migrate-isolation:01944d99-9289-5b83-90f7-cec1402e6722:1:36af5eac7604e4814db582972e35fd8d445e63a4feaf675767f5f58408cee284`.

### 3. Fail-Closed Drift ve Güvenlik Sınırları
- **Foreign / Pre-existing Pool Dosyası**: `/etc/php/8.3/fpm/pool.d/yunpanel-yunapp-d4c467173909.conf` dosyasına harici içerik yazıldığında audit anında `applyAvailable: false` durumuna kilitlendi; apply isteği `409 Conflict` ile reddedildi.
- **Paylaşılan Servis İnaktif Drifti**: `systemctl stop php8.3-fpm` yapıldığında audit `applyAvailable: false` oldu; apply isteği `409 Conflict` ile reddedildi. Servis tekrar başlatıldı.
- **Tahrif Edilmiş Digest / Onay**: Yanlış digest ile onay denemesi `409 Conflict` ile reddedildi.
- **Malformed Body**: Beklenmeyen veya geçersiz gövde alanları içeren istekler `400 Bad Request` ile reddedildi.
- **Geçersiz / Bulunamayan Website**: Var olmayan website UUID'si `404 Not Found` ile fail-closed kaldı.

### 4. Typed-Confirmation Apply & Host Kaynaklarının Materyalizasyonu
- Temiz eksik havuz durumunda geçerli confirmation ile migrasyon başlatıldı (`POST /api/panel/websites/:id/isolation-migrations`):
  - Operasyon başarıyla tamamlandı (`operationId: 7b2ea0ae-1acd-40ee-949f-23ef2ebc2985`, durum `succeeded`).
  - Evidence: `phpFpmReceiptVersion: 1`, `createdPhpFpmPool: true`.
- **Host Seviyesinde Doğrulama**:
  - Havuz dosyası `/etc/php/8.3/fpm/pool.d/yunpanel-yunapp-d4c467173909.conf` doğru user (`yunapp-d4c467173909`), group (`yunapp-d4c467173909`) ve soket ayarlarıyla oluşturuldu.
  - Durable Receipt: `/var/lib/yunpanel/staging/php-fpm-sites/7b2ea0ae-1acd-40ee-949f-23ef2ebc2985.json`, mode `0600`, state `active`, `mutated: true`.
  - Gereksiz paket kurulumu, servis enable veya container chown/chmod işlemleri çalıştırılmadı.

### 5. API Restart Sınırı & Receipt Inspection
- `systemctl restart yunpanel-api` ile API servisi yeniden başlatıldı.
- `GET /api/panel/websites/:id/isolation-migrations/:opId` sorgulandı:
  - Durum `succeeded` olarak korundu; tamamlanmış makbuz inspect edilerek kapatıldı, kör havuz oluşturma replay'i yapılmadı.

### 6. Typed Rollback & Veri/Servis Koruma
- Geçersiz rollback onayları `400 Bad Request` ile reddedildi.
- Geçerli onay (`rollback-isolation-migration:7b2ea0ae-...:<digest>`) ile rollback çalıştırıldı:
  - Durum: `compensated`.
  - Kanıt: `satisfied: true`, `restoredPrevious: false`, `preservedExisting: false`.
- **Host Doğrulaması**:
  - Site havuz dosyası (`yunpanel-yunapp-d4c467173909.conf`) kaldırıldı.
  - Paylaşılan `php8.3-fpm` servisi `active` durumda kaldı, paket korundu.
  - Diğer havuzlar (`yunpanel-elfinder-*.conf` ve `www.conf`) tamamen sağlam ve çalışır kaldı.
  - Container sahipliği (`root:root 0755`) bozulmadan korundu.
  - Durable receipt `state: "compensated"` olarak güncellendi.

### 7. Sağlıklı Baseline Duruma Dönüş
- Web sitesi için PHP-FPM havuzu tekrar uygulandı ve baseline operasyon makbuzu geri yüklendi.
- `GET /api/panel/websites/:id/isolation-audit` sorgulandı:
  - `status: "isolated"`, `migrationRequired: false`.
  - Tüm izolasyon boyutları sağlıklı ve izole durumda.
