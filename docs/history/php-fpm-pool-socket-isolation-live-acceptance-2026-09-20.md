# PHP-FPM Pool & Socket Isolation Live Acceptance — 2026-09-20

## Özet

Ubuntu 24.04 LTS kurulu YunPanel test sunucusunda (`157.180.11.28` — `.28`, hostname `test`), `todo.md` altındaki şu P0 maddesi canlı ortamda uçtan uca doğrulanmıştır:

> Site başına PHP-FPM pool/socket gerçek UID/GID, private tmp/session path, bounded ini/resource policy ile çalışsın; başka site socket/document root erişimi reddedilsin.

---

## Test Ortamı ve Canlı Çalıştırma

- **Hedef Sunucu**: `157.180.11.28` (Ubuntu 24.04 LTS, hostname `test`)
- **Yürütülen Script**: `/root/acceptance-php-fpm-isolation.mjs`
- **Tarih**: 2026-09-20T19:41:11Z
- **Sonuç**: `satisfied: true` (Tüm izolasyon ve cross-site rejection kontrolleri eksiksiz geçti)

---

## Doğrulanan Adımlar ve Güvenlik Sınırları

### 1. İki Bağımsız Site Kurulumu ve Havuz Yapılandırması
- **Site A**:
  - Site kullanıcısı: `yunapp-6780e3176de6` (UID 987, GID 987)
  - Home: `/var/lib/yunpanel/data/087bc5e8-e1ad-41a2-a3da-23dbdc40e820`
  - Workspace Tmp: `/var/lib/yunpanel/data/087bc5e8-e1ad-41a2-a3da-23dbdc40e820/tmp` (mode `0700`)
  - PHP-FPM havuzu: `/etc/php/8.3/fpm/pool.d/yunpanel-yunapp-6780e3176de6.conf`
  - Unix domain socket: `/run/php/yunpanel-yunapp-6780e3176de6.sock` (mode `0660`, `www-data:www-data`)
  - Home secret dosyası: `secret.txt` (`SITE_A_HOME_SECRET_12345`, mode `0600`)
  - Document root secret dosyası: `secret.txt` (`SITE_A_DOC_SECRET_67890`, mode `0640`)
- **Site B**:
  - Site kullanıcısı: `yunapp-9b538ffdf0d0` (UID 986, GID 986)
  - Home: `/var/lib/yunpanel/data/aa242859-425b-4506-b57f-782da81f2bad`
  - Workspace Tmp: `/var/lib/yunpanel/data/aa242859-425b-4506-b57f-782da81f2bad/tmp` (mode `0700`)
  - PHP-FPM havuzu: `/etc/php/8.3/fpm/pool.d/yunpanel-yunapp-9b538ffdf0d0.conf`
  - Unix domain socket: `/run/php/yunpanel-yunapp-9b538ffdf0d0.sock` (mode `0660`, `www-data:www-data`)

### 2. Site A İçi Çalışma Politikası ve İzolasyon Doğrulaması
Site A'ya yapılan HTTP isteği sonucunda:
- `uid` ve `gid`: 987 / 987 (tam site kullanıcısı UID/GID eşleşmesi).
- `sys_temp_dir`: `/var/lib/yunpanel/data/087bc5e8-e1ad-41a2-a3da-23dbdc40e820/tmp` (izole tmp dizini).
- `session_save_path`: `/var/lib/yunpanel/data/087bc5e8-e1ad-41a2-a3da-23dbdc40e820/tmp`.
- `memory_limit`: `256M` (sınırlandırılmış kaynak politikası).
- `max_execution_time`: `60` saniye (sınırlandırılmış zaman aşımı).
- `open_basedir`: `/var/lib/yunpanel/apps/087bc5e8-.../current:/var/lib/yunpanel/data/087bc5e8-...` (yalnızca sitenin kendi uygulama kökü ve home dizini).
- **Oturum Dosyası Güvenliği**: `session_start()` ile oluşturulan oturum dosyası (`sess_*`), Site A'nın izole tmp dizininde mode `0600` ve UID 987, GID 987 sahipliğiyle oluşturuldu.

### 3. Çapraz Site (Site B -> Site A) Erişim Engelleme Doğrulaması
Site B üzerinden Site A kaynaklarına erişim denemeleri yapıldı:
- **Site A Home Secret Okuma Denemesi**: `open_basedir` sınırlaması ve OS dosya izinleri nedeniyle `Operation not permitted` ile engellendi (`home_secret_read: false`).
- **Site A Document Root Secret Okuma Denemesi**: `open_basedir` sınırlaması ve OS izinleri nedeniyle `Operation not permitted` ile engellendi (`doc_secret_read: false`).
- **Site A PHP Soketine Bağlanma Denemesi (`fsockopen`)**: Soket modu `0660 www-data:www-data` olduğundan ve Site B kullanıcısı `www-data` grubunda olmadığından `Permission denied` ile engellendi (`socket_connect: false`).
- **Site A Tmp / Oturum Dizinini Tarama Denemesi (`scandir`)**: `open_basedir` sınırlaması ve OS izinleri nedeniyle `Operation not permitted` ile engellendi (`tmp_dir_scan: false`).

### 4. Temizlik (Cleanup)
- Nginx yapılandırmaları kaldırılıp Nginx yeniden yüklendi.
- `phpManager.compensate` ile her iki havuz dosyası temizlendi ve PHP-FPM servisi yeniden yüklendi.
- Sitelere ait uygulama ve veri dizinleri ile sistem kullanıcıları silindi.

---

## Sonuç

`todo.md` içerisindeki **Site başına PHP-FPM pool/socket gerçek UID/GID, private tmp/session path, bounded ini/resource policy ile çalışsın; başka site socket/document root erişimi reddedilsin** maddesi Ubuntu 24.04 LTS test sunucusunda (`157.180.11.28`) eksiksiz olarak doğrulanmış ve tamamlanmıştır.
