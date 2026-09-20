# Mail ClamAV İsteğe Bağlı Profil ve Sağlık Denetimi (2026-09-20)

## 1. Bağlam ve Ürün Hedefi

`AGENTS.md` ve `docs/architecture.md` uyarınca:
- **Mail Antivirus**: ClamAV opsiyoneldir (`ClamAV, opsiyonel`). Yüksek bellek tüketimi (~1GB+) nedeniyle her sunucuda varsayılan açık tutulmaz.
- **Sağlık Denetimi Kontratı**: "Kaynak yeterliliği/health; eksikse mail hazırmış gibi gösterme" ve "ClamAV optional profile; health yoksa aktif gösterme."
- **Kural**: Antivirüs profili `disabled` ise veya `clamav` seçili olmasına rağmen servis, soket, paket ya da bellek gereksinimleri karşılanmıyorsa (`healthy === false`), arayüzde ve API'de antivirüs **asla aktif gösterilmez** (`active: false`). Eksikse teşhis/uyarı (`mail_antivirus_unhealthy`) üretilir.

## 2. Gerçekleştirilen Değişiklikler

### 2.1 `packages/config-templates`
- `packages/config-templates/src/mail-antivirus.js`:
  - `mailAntivirusTemplatePolicy`:
    - `profiles`: `['disabled', 'clamav']`
    - `defaultProfile`: `'disabled'`
    - `requirement`: `'clamav'`
    - `rspamdAntivirusConfigPath`: `'/etc/rspamd/local.d/antivirus.inc'`
    - `clamavSocketPath`: `'/run/clamav/clamd.ctl'`
    - `clamavFallbackSocketPath`: `'/var/run/clamav/clamd.ctl'`
    - `serviceUnit`: `'clamav-daemon.service'`
    - `packageName`: `'clamav-daemon'`
    - `minMemoryBytes`: `1024 * 1024 * 1024` (1 GiB)
  - `renderRspamdAntivirusConfig`: ClamAV seçildiğinde Rspamd için `/etc/rspamd/local.d/antivirus.inc` konfigürasyonunu üretir (`servers = "/run/clamav/clamd.ctl"; action = "reject"; scan_mime_parts = true;`).
  - `enableManagedMailAntivirus`: Preview nesnesine ClamAV dosya ve gereksinimlerini (`clamav`) ekler veya devre dışı bırakıldığında kaldırır.
- `packages/config-templates/src/index.js`:
  - Yeni şablon modülü sembolleri dışa aktarıldı.

### 2.2 `packages/host-runtime`
- `packages/host-runtime/src/mail-antivirus-health-inspector.js`:
  - `createMailAntivirusHealthInspector`:
    - Paket kontrolü (`dpkg-query` / `/usr/sbin/clamd` / `/usr/bin/clamdscan`),
    - Systemd servis durumu (`systemctl is-active clamav-daemon.service`),
    - Unix domain socket mevcudiyeti (`/run/clamav/clamd.ctl` / `/var/run/clamav/clamd.ctl`),
    - Sistem bellek yeterliliği (`totalMem >= 1 GiB`).
    - Profil `disabled` ise: `{ profile: 'disabled', enabled: false, active: false, healthy: false, status: 'disabled' }`.
    - Profil `clamav` ise: Tüm kontroller geçerse `{ profile: 'clamav', enabled: true, active: true, healthy: true, status: 'ready' }`. Herhangi biri başarısızsa `{ profile: 'clamav', enabled: true, active: false, healthy: false, status: 'unhealthy', blockers: [...] }` döner.
- `packages/host-runtime/src/mail-readiness-inspector.js`:
  - Kanonik gereksinim kümelerine `clamav` kombinasyonları eklendi (`CLAMAV_BASE_REQUIREMENTS`, `CLAMAV_SQL_SRS_SIEVE_REQUIREMENTS` vb.).
  - `requiresClamav` durumunda servis, soket ve bellek kontrolleri yapılarak başarısızlık halinde `ready: false` ve `blockers: ['clamav']` döndürülmesi sağlandı ("eksikse mail hazırmış gibi gösterme").

### 2.3 `apps/api`
- `apps/api/src/panel-settings-registry.js`:
  - `DEFAULT_SETTINGS` içine `mailSecurity: { antivirusProfile: 'disabled' }` eklendi.
  - `updateSettings` içinde `antivirusProfile` doğrulandı (`'disabled' | 'clamav'`).
- `apps/api/src/panel-settings-service.js`:
  - `getSystemSettings` çıktısındaki `mail.security.antivirus` alanı `mailAntivirusHealthInspector` ile bağlandı.
  - ClamAV seçili olsa dahi sağlık denetimi başarısızsa `active: false` döner.
- `apps/api/src/mail-configuration.js`:
  - `materializeConfiguration` panel ayarlarındaki `mailSecurity.antivirusProfile` değerini okuyup ClamAV profilini preview'e uygular.
- `apps/api/src/mail-diagnostics-http.js`:
  - `appendAntivirusDiagnostic` ile alan adı teşhis uç noktasına (`/api/mail-domains/:mailDomainId/diagnostics`) antivirüs durumu eklendi. Antivirüs açık ancak sağlıksız ise `mail_antivirus_unhealthy` sorunu raporlanır.
- `apps/api/src/app.js` ve `apps/api/src/index.js`:
  - Antivirüs sağlık denetleyicisi üretim rotalarına ve servislerine bağlandı.

## 3. Doğrulama ve Testler
- `packages/config-templates/test/mail-antivirus.test.js`: 6 test (100% pass)
- `packages/host-runtime/test/mail-antivirus-health-inspector.test.js`: 7 test (100% pass)
- `packages/host-runtime/test/mail-readiness-inspector.test.js`: 11 test (100% pass)
- `apps/api/test/panel-settings-service.test.js`: 5 test (100% pass)
- `apps/api/test/mail-diagnostics-http.test.js`: 9 test (100% pass)
- `apps/api/test/mail-diagnostics-production-wiring.test.js`: 1 test (100% pass)
