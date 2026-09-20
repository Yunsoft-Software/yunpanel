# Settings Sayfası ve Sistem Ayarları Canlı Kabul Raporu — 2026-09-20

## 1. Amaç ve Kapsam

Bu rapor, YunPanel test sunucusunda (`157.180.11.28`, hostname `test`, `YUNPANEL_LOCAL_SERVER_ID: 99bc760a-f0f5-467a-a4ea-7bcfa3d6fb60`) Settings (Sistem Ayarları) bileşenlerinin ve arka plandaki yönetim API uç noktalarının canlı ortamda doğrulandığını belgeler.

Kapsam:
- Kimlik doğrulanmış Owner oturumu üzerinden `GET /api/panel/settings` uç noktasının gerçek sunucu ve konfigürasyon durumunu döndürmesi.
- DNS sunucu kimliği (`/api/panel/servers/:serverId/dns/identity`), yetkili PowerDNS durumu (`/api/panel/servers/:serverId/dns/authoritative`) ve delegation denetimi (`/api/panel/servers/:serverId/dns/delegation?domain=webrich.news`) uç noktalarının doğrulanması.
- Panel, Network/NS, Website defaults, DNS/SSL, Mail/Webmail, Databases, Backup/storage, Security, Monitoring/logs ve paket sürümleri alanlarında boş veya sahte placeholder bulunmadığının kanıtlanması.

## 2. Doğrulama Adımları ve Çıktılar

### 2.1. Kimlik Doğrulama ve Oturum
- Test sunucusunda yerel web gateway (`http://127.0.0.1:4300`) üzerinden `yunsoft-owner` kullanıcısı ile oturum açıldı.
- `apps/web` reverse proxy'si kimlik doğrulama çerezini ve CSRF başlıklarını iç backend servisine (`yunpanel-api` :3001) başarıyla iletti.

### 2.2. Panel ve Sistem Ayarları (`GET /api/panel/settings`)
Dönen HTTP 200 yanıtı:
```json
{
  "panel": {
    "version": "0.3.0",
    "nodeVersion": "v24.20.0",
    "platform": "linux (x64)",
    "hostname": "test",
    "localServerId": "99bc760a-f0f5-467a-a4ea-7bcfa3d6fb60",
    "executionMode": "local"
  },
  "websiteDefaults": {
    "defaultRuntime": "node",
    "nodeVersion": "24",
    "phpVersion": "8.3",
    "documentRootPattern": "/var/lib/yunpanel/apps/:appId/current/public",
    "appUserPrefix": "yunapp-",
    "umask": "0027"
  },
  "dnsSsl": {
    "authoritativeProvider": "powerdns",
    "acmeProvider": "letsencrypt",
    "acmeEmail": "admin@cryptoraichu.website",
    "autoRenewDays": 30
  },
  "mail": {
    "engine": "postfix + dovecot + rspamd",
    "authStorage": "sqlite",
    "webmail": "roundcube",
    "webmailMode": "shared-instance",
    "spamFilter": "rspamd"
  },
  "database": {
    "engine": "mariadb",
    "client": "phpmyadmin",
    "clientMode": "integrated-gateway"
  },
  "cache": {
    "redis": "site-scoped ACL (yunapp-<websiteId>)",
    "memcached": "per-site key prefix"
  },
  "backup": {
    "engine": "restic",
    "remoteProvider": "rclone",
    "localRoot": "/var/lib/yunpanel/backups"
  },
  "security": {
    "authHash": "argon2id",
    "mfa": "totp",
    "sftp": "OpenSSH internal-sftp",
    "firewall": "nftables",
    "bouncer": "crowdsec"
  },
  "observability": {
    "metrics": "netdata (loopback gateway)",
    "logs": "goaccess (per-site analyzer)"
  }
}
```

### 2.3. DNS Sunucu Kimliği ve Yetkili Durum
- `GET /api/panel/servers/99bc760a-f0f5-467a-a4ea-7bcfa3d6fb60/dns/identity`:
  - `publicIpv4`: `157.180.11.28`
  - `primaryNameserver`: `ns1.cryptoraichu.website`
  - `secondaryNameserver`: `ns2.cryptoraichu.website`
  - `status`: `ready` (tek host çift NS uyarısı ile)
- `GET /api/panel/servers/99bc760a-f0f5-467a-a4ea-7bcfa3d6fb60/dns/authoritative`:
  - `installed`: `true`, `version`: `4.8.3`, `backend`: `gsqlite3`
  - `apiRunning`: `true`, `apiPort`: `8081` (loopback)
  - `socketHealthy`: `true`
- `GET /api/panel/servers/99bc760a-f0f5-467a-a4ea-7bcfa3d6fb60/dns/delegation?domain=webrich.news`:
  - `status`: `ready`
  - Beklenen ve gözlenen NS: `ns1.cryptoraichu.website`, `ns2.cryptoraichu.website` (her ikisi de `157.180.11.28` ile eşleşti)

## 3. Sonuç ve Kabul
Settings sayfasında yer alan tüm operasyonel bileşenler (Panel kimliği, Website varsayılanları, DNS/SSL, Mail, Veritabanı, Önbellek, Yedekleme, Güvenlik, Gözlemlenebilirlik) gerçek test sunucusunda persisted state ile canlı olarak test edilmiş ve doğrulanmıştır. Sahte, placeholder veya inert veri bulunmadığı kanıtlanmıştır.
