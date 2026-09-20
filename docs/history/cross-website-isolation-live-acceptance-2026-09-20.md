# Cross-Website Isolation Live Acceptance — 2026-09-20

## Özet

Ubuntu 24.04 LTS kurulu YunPanel test sunucusunda (`157.180.11.28` — `.28`, hostname `test`), `T-PROVISIONING` kapsamındaki **İki Website ile çapraz izolasyon (file/env/release/data/log/socket/terminal/database credential)** testi iki gerçek canlı web sitesi ve dedicated Linux kullanıcıları altında uçtan uca doğrulanmıştır.

Test edilen gereksinim:
> İki Website ile çapraz izolasyonu gerçek UID/GID altında test et: file/env/release/data/log/socket/terminal/database credential erişimi reddedilsin.

---

## Test Ortamı & Kimlikler

- **Website A (`webrich.news`)**:
  - Website ID: `2689cb56-55a4-50c0-a3a4-258c7f2d48dd`
  - Application ID: `a5e1f251-4594-5996-b402-47a2ad7f55a0`
  - Unix Kullanıcısı: `yunapp-a404896cf12e` (UID: 994, GID: 994)
  - Home / Data Dizin: `/var/lib/yunpanel/data/a5e1f251-4594-5996-b402-47a2ad7f55a0`
  - Release / App Dizin: `/var/lib/yunpanel/apps/a5e1f251-4594-5996-b402-47a2ad7f55a0`
  - PHP-FPM Soketi: `/run/php/yunpanel-yunapp-a404896cf12e.sock`
  - Database: `site_a_db` (MariaDB user: `ydb_ddc0bc17b03e95ae9d9fe152`)

- **Website B (`mailtest.webrich.news`)**:
  - Website ID: `2c4ba551-df97-58e6-9bff-36a0e79c7b4e`
  - Application ID: `6e7d89a3-f363-5c78-a832-358f8ad0b8d8`
  - Unix Kullanıcısı: `yunapp-71355c1cda8a` (UID: 993, GID: 993)
  - Home / Data Dizin: `/var/lib/yunpanel/data/6e7d89a3-f363-5c78-a832-358f8ad0b8d8`
  - Release / App Dizin: `/var/lib/yunpanel/apps/6e7d89a3-f363-5c78-a832-358f8ad0b8d8`
  - PHP-FPM Soketi: `/run/php/yunpanel-yunapp-71355c1cda8a.sock`
  - Database: `site_b_db` (MariaDB user: `ydb_491ed97edc4f2ce7ad8583a0`)

---

## Doğrulanan İzolasyon Başlıkları & Kanıtlar

### 1. Dosya Sistemi & Kalıcı Veri İzolasyonu (Home, Data, tmp, logs)
- `yunapp-a404896cf12e` kullanıcısı `runuser` altında çalıştırılarak `yunapp-71355c1cda8a` home dizinine (`/var/lib/yunpanel/data/6e7d89a3-...`) erişmeye çalıştığında:
  - `ls -la /var/lib/yunpanel/data/6e7d89a3-...`: **`Permission denied`**
  - `ls -la /var/lib/yunpanel/data/6e7d89a3-.../tmp`: **`Permission denied`**
  - `ls -la /var/lib/yunpanel/data/6e7d89a3-.../logs`: **`Permission denied`**
- `yunapp-71355c1cda8a` kullanıcısı `runuser` altında çalıştırılarak `yunapp-a404896cf12e` home dizinine (`/var/lib/yunpanel/data/a5e1f251-...`) erişmeye çalıştığında:
  - `ls -la /var/lib/yunpanel/data/a5e1f251-...`: **`Permission denied`**
  - `ls -la /var/lib/yunpanel/data/a5e1f251-.../tmp`: **`Permission denied`**
  - `ls -la /var/lib/yunpanel/data/a5e1f251-.../logs`: **`Permission denied`**

### 2. Uygulama Kodu & Release İzolasyonu
- User A'nın User B'nin release ağacına ve yayın dosyalarına erişimi:
  - `ls -la /var/lib/yunpanel/apps/6e7d89a3-.../releases/ddec59b2-...`: **`Permission denied`**
  - `cat /var/lib/yunpanel/apps/6e7d89a3-.../current/public/index.php`: **`Permission denied`**
- User B'nin User A'nın release ağacına ve yayın dosyalarına erişimi:
  - `ls -la /var/lib/yunpanel/apps/a5e1f251-.../releases/7658a928-...`: **`Permission denied`**
  - `cat /var/lib/yunpanel/apps/a5e1f251-.../current/public/index.php`: **`Permission denied`**

### 3. IPC & Unix Domain Soket İzolasyonu (PHP-FPM, elFinder)
- `/run/php/` dizini altındaki PHP-FPM ve elFinder soketleri `0660` modunda ve `www-data:www-data` mülkiyetindedir.
- User A, User B'nin FPM veya elFinder soketine (`/run/php/yunpanel-yunapp-71355c1cda8a.sock`, `/run/php/yunpanel-elfinder-yunapp-71355c1cda8a.sock`) okuma/yazma yapamaz (**`Access Denied`**).
- User B, User A'nın soketlerine okuma/yazma yapamaz (**`Access Denied`**).

### 4. Ortam Değişkenleri & Süreç/Terminal İzolasyonu
- User B, User A'nın aktif PHP-FPM worker sürecinin ortam değişkenlerini `/proc/<PID>/environ` üzerinden okumaya çalıştığında: Linux çekirdek izinleri gereği **`cat: /proc/<PID>/environ: Permission denied`**.
- User B, User A'nın sürecine `kill -0 <PID>` ile sinyal göndermeye çalıştığında: **`Operation not permitted`**.

### 5. Control Plane & Veritabanı Kimlik Bilgisi İzolasyonu
- User A ve User B'nin hiçbir şekilde `/var/lib/yunpanel/control-plane` dizinine erişemediği doğrulandı (**`Permission denied`**).
- `application-environment-registry.json` ve `database-credential-registry.json` dosyalarının site kullanıcıları tarafından okunamadığı doğrulandı (**`Permission denied`**).
- `/var/lib/mysql/site_b_db` raw veritabanı dizininin dosya sistemi seviyesinde site kullanıcısına kapalı olduğu doğrulandı (**`Permission denied`**).
- MariaDB SQL yetki seviyesinde:
  - User A'nın kullanıcısı `ydb_ddc0bc17b03e95ae9d9fe152` yalnız `site_a_db` üzerinde yetkilidir, `site_b_db` erişimi MariaDB tarafından **`ERROR 1045: Access denied`** ile reddedilir.
  - User B'nin kullanıcısı `ydb_491ed97edc4f2ce7ad8583a0` yalnız `site_b_db` üzerinde yetkilidir, `site_a_db` erişimi MariaDB tarafından **`ERROR 1045: Access denied`** ile reddedilir.
- YunPanel API seviyesinde:
  - `GET /api/panel/servers/:serverId/websites/:websiteId/database-resources` endpoint'i yalnız ilgili web sitesine ait veritabanını (`site_a_db` veya `site_b_db`) ve secret içermeyen (parolasız) metadata görünümünü döndürür.
