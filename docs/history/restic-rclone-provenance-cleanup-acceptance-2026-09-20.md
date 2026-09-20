# Restic & Rclone Provenance, Temizlik ve Kilit Kabul Raporu (2026-09-20)

## 1. Kapsam ve Amaç
Bu rapor, `plan.md` (P1.2 Restic/rclone minimum sürüm ve paket/binary provenance politikası, private geçici password-file artıklarının temizliği) ve `todo.md` (T-SITE-FEATURES-SETTINGS altındaki restic lock contention, process kill/restart password-file temizliği ve binary health kabulü) gereksinimlerinin Ubuntu 24.04 LTS `.28` test sunucusu (`157.180.11.28`) üzerindeki canlı doğrulamasını belgeler.

## 2. Doğrulanan Yetenekler ve Güvenlik Sınırları

1. **Restic Binary Provenance ve Sürüm Politikası:**
   - İzinli dizin kontrolü: `/usr/bin/restic`, `/usr/local/bin/restic`, `/bin/restic`.
   - Dosya güvenliği doğrulaması: `stat` ile dosyanın normal dosya olduğu, dünya tarafından yazılamadığı (`mode & 0o002 === 0`), UID'nin 0 (root) olduğu doğrulandı.
   - Sürüm politikası: Minimum sürüm `0.16.0`. Sunucuda `0.16.4` tespit edildi ve kabul edildi.

2. **Rclone Binary Provenance ve Sürüm Politikası:**
   - İzinli dizin kontrolü: `/usr/bin/rclone`, `/usr/local/bin/rclone`, `/bin/rclone`.
   - Dosya güvenliği doğrulaması: `stat` ile `mode 100755`, UID 0 (root) doğrulandı.
   - Sürüm politikası: Minimum sürüm `1.60.0`. Sunucuda `v1.60.1-DEV` tespit edildi ve kabul edildi.

3. **Geçici Parola Dosyalarının Temizliği (Process Kill / Restart):**
   - Restic çalıştırma sırasında oluşturulan geçici `0700` dizin ve `0600` `password` dosyaları modül düzeyinde `activeSecretDirs` Set'i ile izlenir.
   - `exit`, `SIGINT`, `SIGTERM` sinyal dinleyicileri ile beklenmedik kapanmada aktif dizinlerin senkron olarak silinmesi sağlandı.
   - `cleanOrphanedPasswordFiles({ baseDir, maxAgeMs })` fonksiyonu ile 5 dakikadan eski artık `/tmp/yunpanel-restic-*` dizinleri başarıyla tespit edilip silindi; yeni olanlara dokunulmadı.
   - `apps/api/src/app.js` başlangıcında bu temizlik otomatik olarak devreye alındı.

4. **Kilit Çekişmesi (Lock Contention) Fail-Closed Güvencesi:**
   - Restic repository'sinde kilit mevcutken işlem yapıldığında operasyonun fail-closed kaldığı ve tipli HTTP 409 `restic_repo_locked` hatası döndürdüğü canlı olarak kanıtlandı.

## 3. Test Sonucu
Tüm kontroller (1/4'ten 4/4'e) `.28` test sunucusunda sıfır hata ile geçti.
Test tamamlandıktan sonra oluşturulan geçici restic repository'si ve kilit dosyaları diskten temizlendi.
