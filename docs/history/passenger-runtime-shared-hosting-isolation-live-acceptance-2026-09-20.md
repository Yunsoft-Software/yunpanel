# Passenger Nginx Runtime & Shared-Hosting Isolation Live Acceptance — 2026-09-20

## Özet

Ubuntu 24.04 LTS kurulu YunPanel test sunucusunda (`157.180.11.28` — `.28`, hostname `test`), `todo.md` altındaki şu iki P0 maddesi canlı ortamda uçtan uca doğrulanmıştır:

> 1. Ubuntu 24.04 paketinde Nginx Passenger kurulumu/version/configtest/health çalışsın. Yeni Node Website explicit `passenger_user/group`, startup file, Node binary ve env ile site UID/GID altında başlasın.
> 2. Passenger shared-hosting izolasyonunu iki gerçek Node app ile doğrula; başka site startup file/user seçimi veya raw Passenger/Nginx directive privilege escalation üretemesin.

---

## Test Ortamı ve Canlı Çalıştırma

- **Hedef Sunucu**: `157.180.11.28` (Ubuntu 24.04 LTS, hostname `test`)
- **Yürütülen Script**: `/root/acceptance-passenger-isolation.mjs`
- **Tarih**: 2026-09-20T19:43:02Z
- **Sonuç**: `satisfied: true` (Tüm çalışma, izolasyon ve privilege escalation engelleme kontrolleri eksiksiz geçti)

---

## Doğrulanan Adımlar ve Güvenlik Sınırları

### 1. Nginx Passenger Motoru ve Sağlık Denetimi
- `passengerInspector.inspect()` ile sistem durumu denetlendi:
  - `installed: true` (`libnginx-mod-http-passenger`, sürüm `1:6.2.0-1~noble1build3`).
  - `passengerRoot: /usr/lib/ruby/vendor_ruby/phusion_passenger/locations.ini`.
  - `moduleLoaded: true` (`ngx_http_passenger_module.so` yüklü).
  - `installValid: true` (`passenger-config validate-install` başarılı).
  - `healthy: true` (`nginx -t` ve root uyumu tam).

### 2. Site 1 Yapılandırması ve Çalışma Doğrulaması
- **Site 1 Kimliği**: `yunapp-a154735a55e3` (UID 987, GID 987).
- **Yönetilen Node.js**: `/opt/yunpanel/node-runtimes/v24/bin/node` (`v24.21.0`).
- **Giriş Dosyası**: `server.js` (HTTP sunucusu).
- **Ortam Değişkenleri**: `/etc/yunpanel/passenger-env/<app1>.conf` (`passenger_env_var CUSTOM_TEST_VAR "passenger_env_ok";`, mode `0600`).
- **Nginx Direktifleri**: `passenger_enabled on;`, `passenger_app_type node;`, `passenger_user yunapp-a154735a55e3;`, `passenger_group yunapp-a154735a55e3;`, `passenger_nodejs /opt/yunpanel/node-runtimes/v24/bin/node;`.
- **HTTP Yanıtı**:
  ```json
  {"uid":987,"gid":987,"nodeVersion":"v24.21.0","customEnv":"passenger_env_ok"}
  ```
  - Site 1'in tam olarak kendi UID/GID (987/987) altında çalıştığı, yönetilen Node v24 ikilisini kullandığı ve ortam değişkenini aldığı doğrulandı.

### 3. Site 2 ve Shared-Hosting İzolasyonu
- **Site 2 Kimliği**: `yunapp-53a5c1bc2561` (UID 986, GID 986).
- Site 1'in private ev dizinine gizli bir dosya yerleştirildi (`/var/lib/yunpanel/data/<app1>/secret.txt`, mode `0600`).
- Site 2 (`server.js`), Site 1'in bu gizli dosyasını okumaya çalıştı.
- **HTTP Yanıtı**:
  ```json
  {"uid":986,"gid":986,"nodeVersion":"v24.21.0","site1Secret":null,"site1Error":"EACCES"}
  ```
  - Site 2'nin Site 1'in verilerine erişimi işletim sistemi düzeyinde `EACCES` (Permission denied) ile engellendi.

### 4. Privilege Escalation ve Güvensiz Yapılandırma Engelleme Kontratları
Şu yetki yükseltme ve enjeksiyon girişimleri doğrulanarak fail-closed reddedildi:
1. **`user: 'root'` Tanımlama Denemesi**: `passenger_identity_invalid` ile reddedildi.
2. **`user: 'www-data'` Tanımlama Denemesi**: `passenger_identity_invalid` ile reddedildi.
3. **`startupFile: '../etc/passwd'` (Path Traversal) Denemesi**: `passenger_startup_file_invalid` ile reddedildi.
4. **`startupFile: '/bin/sh'` (Mutlak Yol) Denemesi**: `passenger_startup_file_invalid` ile reddedildi.
5. **`environmentInclude: '/etc/shadow'` Denemesi**: `passenger_environment_include_invalid` ile reddedildi.
6. **Mismatched `unixUser` (Site 1 için Site 2 kullanıcısı belirtme)**: `passenger_site_identity_mismatch` ile reddedildi.
7. **Yetkisiz Node İkilisi (`nodeCandidates: ['/bin/bash']`)**: `passenger_site_node_candidates_invalid` ile reddedildi.
8. **Geçersiz Startup Uzantısı (`startupFile: 'server.sh'`)**: `passenger_site_startup_extension_invalid` ile reddedildi.

### 5. Temizlik (Cleanup)
- Test Nginx yapılandırmaları kaldırıldı ve Nginx reload edildi.
- Ortam değişkenleri dosyası silindi.
- Uygulama ve veri dizinleri ile test site kullanıcıları sistemden temizlendi.

---

## Sonuç

`todo.md` içerisindeki **Nginx Passenger kurulumu/version/configtest/health ve explicit passenger_user/group** ile **Passenger shared-hosting izolasyonu ve privilege escalation engelleme** maddeleri Ubuntu 24.04 LTS test sunucusunda (`157.180.11.28`) eksiksiz olarak doğrulanmış ve tamamlanmıştır.
