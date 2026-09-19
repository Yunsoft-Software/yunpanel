# Panel ve Sistem Ayarları Ekranlarının Gerçek Backend State'iyle Tamamlanması (2026-09-19)

Bu doküman P1.4 kapsamındaki `Settings ekranlarını gerçek backend state'iyle tamamla` görevinin mimarisini, uygulanan servisleri ve test doğrulama sonuçlarını özetler.

## 1. Mimari ve Kapsam

`todo.md` kabul kriteri:
> `Settings Panel, Network/NS, Website defaults, DNS/SSL, Mail/Webmail, Databases, Backup/storage, Security, Monitoring/logs, Users/audit ve package versions alanlarını gerçek persisted state/health ile göstersin; boş placeholder kalmasın.`

Bu doğrultuda sistemin tüm katmanlarındaki gerçek yapılandırma ve durum tek birleşik endpoint ve registry altında toplandı:
- **Panel & Host**: Versiyon, Node.js sürümü, platform, hostname, localServerId, uptime, local execution mode.
- **Website Defaults & İzolasyon**: Varsayılan runtime (Node/Passenger, PHP-FPM, Statik), Node/PHP varsayılan sürümleri, document root şablonu, UMask (`0027`), `yunapp-*` dedicated Unix identity izolasyonu.
- **DNS & SSL Politikası**: PowerDNS yetkili DNS motoru, Let's Encrypt ACME sağlayıcısı, `YUNPANEL_ACME_EMAIL`, 30 günlük otomatik yenileme döngüsü, özel sertifika deposu.
- **Mail & Webmail Mimarisi**: Postfix + Dovecot + Rspamd, SQLite virtual-mail auth veritabanı, `/var/lib/yunpanel/mail` depolama yolu, Roundcube paylaşımlı instance ve `webmail.<domain>` adresi.
- **Veritabanı & Cache İzolasyonu**: MariaDB, phpMyAdmin session handoff gateway, Redis site-scoped ACL (`yunapp-<websiteId>`, `~<websiteId>:*`, tehlikeli komut kısıtlaması), Memcached per-site prefix (`yunapp_<websiteId>:`).
- **Yedekleme & Depolama**: restic snapshot motoru, rclone remote desteği, `/var/lib/yunpanel/backups`, saklama (retention) varsayılanları (7G / 4H / 12A).
- **Güvenlik & Güvenlik Duvarı**: Argon2id parola hashleme, TOTP MFA, OpenSSH internal-sftp chroot, nftables + CrowdSec güvenlik duvarı.
- **İzleme & Log Analizi**: Netdata loopback gateway metrikleri, GoAccess site bazlı erişim log analizörü.
- **Yönetilen Servisler (Managed Services)**: Nginx, PHP, Passenger, MariaDB, PowerDNS, Postfix, Dovecot, Rspamd, Roundcube, Redis, Memcached servislerinin anlık kurulum ve aktiflik durumu.

## 2. Uygulanan Bileşenler

1. **Panel Settings Registry (`apps/api/src/panel-settings-registry.js`)**:
   - Root-private `panel-settings.json` (`0700` dizin, `0600` dosya, atomic temp+rename).
   - `websiteDefaults`, `dnsSsl`, `backupDefaults` alanları için validasyon ve kalıcı saklama.
   - `getSettings()` ve `updateSettings(patch)` metotları.

2. **Panel Settings Service (`apps/api/src/panel-settings-service.js`)**:
   - `createPanelSettingsService`:
     - `getSystemSettings()`: Persisted panel ayarlarını, sunucu kaydını, DNS kimlik ayarlarını ve `jobRegistry` üzerinden yönetilen servislerin en son anlık görüntüsünü (snapshot) birleştirir.
     - `updateSystemSettings(patch)`: Ayarları günceller ve güncel durumu döner.

3. **Panel Settings HTTP API (`apps/api/src/panel-settings-http.js`)**:
   - `GET /api/panel/settings`: Tüm sistem ayarlarını ve durumunu döner (`requirePanelRouteAccess`).
   - `PATCH /api/panel/settings`: Ayarları günceller (`requirePanelRouteAccess`, yalnız `owner` rolü).
   - `panel-access.js` içinde `read_only` rolü için `GET /api/panel/settings` izni tanımlandı.

4. **API Entegrasyonu (`apps/api/src/app.js` & `apps/api/src/index.js`)**:
   - `panelSettingsRegistry` ve `panelSettingsService` üretim ortamı başlatmasına bağlandı.
   - `mountPanelSettingsRoutes` monte edildi ve hata yönetimi eklendi.

5. **Frontend Bileşenleri (`apps/web`)**:
   - `apps/web/src/workspace/system-settings-client.js`: `getPanelSettings` ve `updatePanelSettings` API istemcileri.
   - `apps/web/src/workspace/SystemSettingsPanels.jsx`: Panel & Sunucu, Site Varsayılanları, DNS/SSL, Mail/Webmail, Veritabanı/Cache, Yedekleme, Güvenlik, İzleme ve Yönetilen Servisler bölümlerini gerçek backend verileriyle sunan bileşen.
   - `apps/web/src/workspace/OperationsPages.jsx`: `SettingsPage` bileşeni güncellenerek `SystemSettingsPanels` entegre edildi.

## 3. Test ve Doğrulama

- Node 24 (`nvm use 24`) altında birim testler:
  - `apps/api/test/panel-settings-service.test.js`: PASS (3/3)
  - `apps/api/test/panel-settings-http.test.js`: PASS (5/5)
- `npm run check`: Tamamı başarıyla geçti (0 exit code, 72 protocol + 32 shared + API/host-runtime tests + web build).
