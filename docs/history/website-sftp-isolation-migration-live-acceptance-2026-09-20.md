# Website SFTP Isolation Migration & Rollback Live Acceptance — 2026-09-20

## Özet

Ubuntu 24.04 LTS kurulu YunPanel test sunucusunda (`157.180.11.28` — `.28`, hostname `test`), `T-PROVISIONING` kapsamındaki aşağıdaki madde canlı ortamda uçtan uca doğrulanmıştır:

> Legacy Website'te canonical Unix identity hazır fakat site-specific SFTP chroot/mount/config/unit state tamamen eksikken isolation audit yalnız exact `safeCreateCandidate` preview için SFTP migration apply açsın. Typed-confirmation apply durable isolation journal + SFTP receipt ile chroot/mount/config/unit ve current authorized-key desired state'i oluştursun; mutation/evidence sınırında API restart tamamlanmış receipt/key materialization'ı inspect ile kapatsın ve incomplete state'i kör replay etmesin. Foreign SSH drop-in, mount unit, chroot/mount directory veya owner/mode drift varsa apply fail-closed kalsın. Typed rollback yalnız receipt-owned SSH config/unit ve operation-created boş chroot/mount dizinlerini kaldırsın; veri içeren dizinleri ve SFTP key registry desired state'ini korusun.

---

## Test Ortamı ve Hedef Kimlikler

- **Test Edilen Web Sitesi**: `provtest.webrich.news`
  - Website ID: `01944d99-9289-5b83-90f7-cec1402e6722`
  - Application ID: `392d53e7-a6f5-5f12-85cb-828a3f4211cf`
  - Canonical Unix User: `yunapp-d4c467173909` (UID 990, GID 990)
  - Chroot Directory: `/var/lib/yunpanel/sftp-chroots/392d53e7-a6f5-5f12-85cb-828a3f4211cf` (mode `0755`, root:root)
  - Mount Directory: `/var/lib/yunpanel/sftp-chroots/392d53e7-a6f5-5f12-85cb-828a3f4211cf/site` (bind mount -> `/var/lib/yunpanel/data/392d53e7-a6f5-5f12-85cb-828a3f4211cf`, mode `0750`)
  - Mount Unit: `var-lib-yunpanel-sftp\x2dchroots-392d53e7\x2da6f5\x2d5f12\x2d85cb\x2d828a3f4211cf-site.mount`
  - SSH Drop-in: `/etc/ssh/sshd_config.d/90-yunpanel-sftp-yunapp-d4c467173909.conf` (mode `0600`, root:root)
  - Staging Receipts: `/var/lib/yunpanel/staging/sftp-sites/*.json` (mode `0600`, root:root)

---

## Doğrulanan Yaşam Döngüsü ve Güvenlik Adımları

### 1. Preconditions ve All-Missing SFTP Durumu
- Canonical Unix identity (`yunapp-d4c467173909`, mode 0750 HOME) ve PHP runtime'ın (`php8.3-fpm` pool/socket) hazır ve sağlıklı olduğu doğrulandı.
- Host üzerindeki tüm SFTP izolasyon kaynakları (`mount` birimi durdurulup disable edildi, drop-in conf silindi, mount ve chroot dizinleri kaldırıldı, eski receipt temizlendi) tamamen kaldırılarak all-missing senaryosu simüle edildi.
- Host doğrulaması: mount unit inaktif, chroot/mount dizinleri ve drop-in config yok.

### 2. Isolation Audit & Exact `safeCreateCandidate` Preview
- `GET /api/panel/websites/:id/isolation-audit` çağrıldı:
  - `status: "migration_required"`, `migrationRequired: true`.
  - `changes.length: 1`.
  - `action: "create_sftp_isolation"`.
  - `applyState: "requires_explicit_apply"`.
  - `ownership: "operation_receipt_planned"`.
  - `current.sftpMigrationPreview.safeCreateCandidate: true`.
  - `migration.applyAvailable: true`.
  - `previewDigest`: `6a8ab0c7c5b329cad13070dff2e55033ec238d1674e886247d6fcfd516465180`.
  - `confirmation`: `migrate-isolation:01944d99-9289-5b83-90f7-cec1402e6722:1:6a8ab0c7c5b329cad13070dff2e55033ec238d1674e886247d6fcfd516465180`.
  - Uyarı: *“Apply creates only the all-missing site-specific SFTP chroot/mount/config/unit state under a durable receipt; foreign artifacts stay blocked and rollback preserves chroot/mount directories.”*

### 3. Fail-Closed Drift ve Güvenlik Sınırları
- **Foreign SSH drop-in**: `/etc/ssh/sshd_config.d/90-yunpanel-sftp-yunapp-d4c467173909.conf` dosyasına harici içerik yazıldığında audit anında `applyAvailable: false` durumuna kilitlendi; apply isteği `409 Conflict` ile reddedildi.
- **Foreign Mount unit**: `/etc/systemd/system/var-lib-yunpanel-sftp\x2dchroots-*-site.mount` dosyasına harici birim yazıldığında audit `applyAvailable: false` oldu; apply isteği `409 Conflict` ile reddedildi.
- **Pre-existing / Yanlış İzinli Chroot Dizini**: `/var/lib/yunpanel/sftp-chroots/392d53e7-a6f5-5f12-85cb-828a3f4211cf` dizini önceden oluşturulduğunda audit `applyAvailable: false` oldu; apply isteği `409 Conflict` ile reddedildi.
- **Tahrif Edilmiş Digest / Onay**: Yanlış digest ile onay denemesi `409 Conflict` ile reddedildi.
- **Malformed Body**: Beklenmeyen gövde alanları içeren istekler `400 Bad Request` ile reddedildi.
- **Geçersiz / Bulunamayan Website**: Var olmayan website UUID'si `404 Not Found` ile fail-closed kaldı.

### 4. Typed-Confirmation Apply & Host Kaynaklarının Materyalizasyonu
- Temiz all-missing durumda geçerli confirmation ile migrasyon başlatıldı (`POST /api/panel/websites/:id/isolation-migrations`):
  - Operasyon başarıyla tamamlandı (`operationId: bf211fd7-2728-4af3-8585-027970d9fed0`, durum `succeeded`).
  - Evidence: `sftpReceiptVersion: 1`, `activatedSftpIsolation: true`.
- **Host Seviyesinde Doğrulama**:
  - Chroot dizini: `/var/lib/yunpanel/sftp-chroots/392d53e7-a6f5-5f12-85cb-828a3f4211cf`, mode `0755`, UID 0 (root), GID 0 (root).
  - Mount dizini: `/var/lib/yunpanel/sftp-chroots/392d53e7-a6f5-5f12-85cb-828a3f4211cf/site` mevcut ve site HOME dizinine bind mount edilmiş (`mode 0750`, `yunapp-d4c467173909`).
  - Mount birimi: `systemctl is-active` çıktısı `active`.
  - SSH drop-in: `/etc/ssh/sshd_config.d/90-yunpanel-sftp-yunapp-d4c467173909.conf`, mode `0600`, root:root.
  - Durable Receipt: `/var/lib/yunpanel/staging/sftp-sites/bf211fd7-2728-4af3-8585-027970d9fed0.json`, mode `0600`, state `active`, `createdDirectories` listesi tam.
  - SFTP Key Registry: `GET /api/panel/websites/:id/sftp/keys` üzerinden authorized keys desired state reconcilation ve materialization'ının korunduğu (`satisfied: true`) doğrulandı.

### 5. API Restart Sınırı & Receipt Inspection
- `systemctl restart yunpanel-api` ile servis yeniden başlatıldı.
- `GET /api/panel/websites/:id/isolation-migrations/:opId` sorgulandı:
  - Durum `succeeded` olarak korundu, tamamlanmış makbuz inspect edilerek kapatıldı, kör mutation replay yapılmadı.

### 6. Boş Chroot / Mount için Typed Rollback
- Geçersiz rollback onayları `400 Bad Request` ile reddedildi.
- Geçerli onay (`rollback-isolation-migration:bf211fd7-...:<digest>`) ile rollback çalıştırıldı:
  - Durum: `compensated`.
  - Kanıt: `removedSftpIsolation: true`.
- **Host Doğrulaması**:
  - SSH drop-in kaldırıldı (`rm -f`, ssh reload edildi).
  - Mount birimi durduruldu, disable edildi, birim dosyası kaldırıldı.
  - Boş chroot ve mount dizinleri `rmdir` ile temizlendi.
  - Receipt `state: "compensated"` olarak güncellendi.
  - SFTP key registry desired state'i bozulmadan korundu.

### 7. Veri İçeren Chroot Dizini için Rollback & Veri Koruma
- SFTP migrasyonu tekrar uygulandı (`operationId: 6f2d73e4-294a-42dd-bb76-e4757455abe2`).
- Chroot dizini içine kullanıcıya ait kritik bir test dosyası oluşturuldu: `/var/lib/yunpanel/sftp-chroots/392d53e7-a6f5-5f12-85cb-828a3f4211cf/important_user_sftp_document.txt`.
- Rollback çalıştırıldı (`rollback-isolation-migration:6f2d73e4-...:<digest>`):
  - API yanıtı: `satisfied: true`, `removedSftpIsolation: true`.
- **Host Doğrulaması**:
  - Mount birimi durduruldu ve kaldırıldı, SSH drop-in kaldırıldı.
  - Chroot dizini ve içindeki `important_user_sftp_document.txt` dosyası **tamamen korundu ve silinmedi** (`rmdir` dosya olduğu için `ENOTEMPTY` ile dizini bıraktı, recursive `rm -rf` kesinlikle çalıştırılmadı).
  - Test dosyası kontrol edilerek içeriğin eksiksiz olduğu teyit edildi.
  - Test dosyası temizlendi.

### 8. Sağlıklı Baseline Duruma Dönüş
- Web sitesi için SFTP izolasyonu tekrar uygulandı ve baseline operasyon makbuzu geri yüklendi.
- `GET /api/panel/websites/:id/isolation-audit` sorgulandı:
  - `status: "isolated"`, `migrationRequired: false`.
  - `unix_identity`, `php_runtime` ve `sftp` adımlarının tümü `satisfied: true`.
