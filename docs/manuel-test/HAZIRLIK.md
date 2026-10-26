# T100 — Manuel Test Hazırlığı: Tarayıcı Girişi ve Sunucu Durumu

Sonuç: ÇALIŞIYOR
Ajan: AGENT_1 · Tarih: 2026-10-26 19:03 · Panel sürümü: `0.3.0` (`yunpanel 0.3.0-2026101141 amd64`)

## Özet
- **Tarayıcı Girişi:** **BAŞARILI** (`.local/yunpanel-owner-password-only.json` içindeki Owner hesabı ile gerçek Chrome tarayıcısında giriş yapıldı, oturum çubuğu ve çalışma alanı sorunsuz açıldı).
- **Sol Menü Sayfaları:** Sol menüdeki **9 ana sayfanın tamamı** boş ekran, HTTP (`>=400`) hatası veya JS çalışma zamanı hatası (`pageerror`) olmadan açılıyor. Araçlar ve Ayarlar altındaki 13 yardımcı sayfadan 12'si hatasız açılıyor; yalnız `/firewall` sayfasında 4 adet `/api/firewall/*` uç noktası `404` döndürüyor.
- **SSH ve Sunucu Durumu:** `.local/test-server.env` ile doğrulanan `.28` test sunucusuna salt okunur SSH erişimi **BAŞARILI**; disk (`%17` dolu), bellek (`10Gi` kullanılabilir) ve temel servisler (`yunpanel-api`, `yunpanel-web`, `nginx`, `mariadb`, `pdns`, `postfix`, `dovecot`, `rspamd`, `docker`, `php8.3-fpm`, `ufw`) aktif durumda.

---

## 1. Tarayıcı Girişi ve Panel Sürümü

| Kontrol | Durum | Gözlenen | Kanıt |
|---|---|---|---|
| Tarayıcı ile Owner Girişi | **BAŞARILI** | `form.auth-form` üzerinden giriş yapıldı, `.auth-sessionbar` görünür oldu ve `/websites` sayfasına yönlendirildi. | `00-login-success.png` |
| Panel Uygulama Sürümü | **DOĞRULANDI** | `0.3.0` (`package.json`) | `/usr/lib/yunpanel/package.json` |
| Kurulu Sistem Paketi | **DOĞRULANDI** | `yunpanel 0.3.0-2026101141 (amd64)` — `/settings?section=updates` ekranında `APT PACKAGE · YunPanel updates · READY` | `tools-14-settings_section_updates.png` |

---

## 2. Menü Sayfaları Kontrol Tablosu

### 2.1 Sol Menü Sayfaları (`aside a[href]`)

| # | Menü Başlığı | Rota (`href`) | Açılan Başlık (`h1`/`h2`) | Boş Ekran mı? | HTTP Hatası (`>=400`) | JS / Konsol Hatası | Durum | Kanıt |
|---|---|---|---|---|---|---|---|---|
| 1 | Web Siteleri | `/websites` | `Web Siteleri` | Hayır (`1269` krk) | Yok | Yok | **AÇILIYOR** | `sidebar-01-websites.png` |
| 2 | Uygulama Marketi | `/docker` | `Docker & Compose Stack Yönetimi` | Hayır (`3665` krk) | Yok | Yok | **AÇILIYOR** | `sidebar-02-docker.png` |
| 3 | Posta | `/mail` | `Mail` | Hayır (`295` krk) | Yok | Yok | **AÇILIYOR** | `sidebar-03-mail.png` |
| 4 | Dosyalar | `/files` | `Dosyalar` | Hayır (`286` krk) | Yok | Yok | **AÇILIYOR** | `sidebar-04-files.png` |
| 5 | Veritabanları | `/databases` | `Veritabanları` | Hayır (`801` krk) | Yok | Yok | **AÇILIYOR** | `sidebar-05-databases.png` |
| 6 | İstatistikler | `/statistics` | `İstatistikler` | Hayır (`311` krk) | Yok | Yok | **AÇILIYOR** | `sidebar-06-statistics.png` |
| 7 | Müşteriler | `/customers` | `Müşteriler` | Hayır (`214` krk) | Yok | Yok | **AÇILIYOR** | `sidebar-07-customers.png` |
| 8 | Bayiler | `/resellers` | `Bayiler` | Hayır (`218` krk) | Yok | Yok | **AÇILIYOR** | `sidebar-08-resellers.png` |
| 9 | Araçlar ve Ayarlar | `/tools-settings` | `Araçlar ve Ayarlar` | Hayır (`498` krk) | Yok | Yok | **AÇILIYOR** | `sidebar-09-tools_settings.png` |

### 2.2 Araçlar ve Ayarlar Alt Sayfaları

| # | Sayfa Başlığı | Rota (`href`) | Açılan Başlık (`h1`/`h2`) | Boş Ekran mı? | HTTP Hatası (`>=400`) | JS (`pageerror`) | Durum / Not | Kanıt |
|---|---|---|---|---|---|---|---|---|
| 10 | Sunucu ve servis yönetimi | `/servers` | `Sunucu` | Hayır (`603` krk) | Yok | Yok | **AÇILIYOR** | `tools-10-servers.png` |
| 11 | Güvenlik duvarı ve port yönetimi | `/firewall` | `Güvenlik Duvarı ve Port Yönetimi` | Hayır (`2188` krk) | `404 GET /api/firewall/ports`, `/service-profiles`, `/status`, `/bans` | Yok | **KISMİ (API 404)** — Sayfa açılıyor fakat `/api/firewall/*` uçları 404 dönüyor (`SEC-01` kapsamında incelenecek). | `tools-11-firewall.png` |
| 12 | Sunucu genel bakışı | `/dashboard` | `Genel bakış` | Hayır (`1094` krk) | Yok | Yok | **AÇILIYOR** | `tools-12-dashboard.png` |
| 13 | Sunucu DNS ve SSL ayarları | `/settings?section=dns` | `Ayarlar` | Hayır (`2182` krk) | Yok | Yok | **AÇILIYOR** | `tools-13-settings_section_dns.png` |
| 14 | YunPanel güncellemeleri | `/settings?section=updates` | `Ayarlar` | Hayır (`287` krk) | Yok | Yok | **AÇILIYOR** | `tools-14-settings_section_updates.png` |
| 15 | Kullanıcılar, bayiler ve müşteriler | `/settings/users` | `Kullanıcılar` | Hayır (`822` krk) | Yok | Yok | **AÇILIYOR** | `tools-15-settings_users.png` |
| 16 | Hesap ve erişim ayarları | `/settings?section=account` | `Ayarlar` | Hayır (`225` krk) | Yok | Yok | **AÇILIYOR** | `tools-16-settings_section_account.png` |
| 17 | AI sağlayıcıları | `/settings?section=ai` | `Ayarlar` | Hayır (`772` krk) | Yok | Yok | **AÇILIYOR** | `tools-17-settings_section_ai.png` |
| 18 | İşlem geçmişi | `/jobs` | `İşler` | Hayır (`2661` krk) | Yok | Yok | **AÇILIYOR** | `tools-18-jobs.png` |
| 19 | Denetim kayıtları | `/audit` | `Denetim kayıtları` | Hayır (`6487` krk) | Yok | Yok | **AÇILIYOR** | `tools-19-audit.png` |
| 20 | Sistem ve site günlükleri | `/logs` | `Günlükler` | Hayır (`279` krk) | Yok | Yok | **AÇILIYOR** | `tools-20-logs.png` |
| 21 | Uygulama envanteri | `/applications` | `Uygulama envanteri` | Hayır (`990` krk) | Yok | Yok | **AÇILIYOR** | `tools-21-applications.png` |
| 22 | Gelişmiş alan adı araçları | `/domains` | `Gelişmiş alan adı araçları` | Hayır (`2625` krk) | Yok | Yok | **AÇILIYOR** | `tools-22-domains.png` |

> **Konsol Notu:** SPA içi menü tıklamalarında (`#1–#9`) konsol hatası yoktur. Doğrudan URL ile tam sayfa yenilemelerinde (`page.goto`) tarayıcı konsolunda bir adet inline script CSP uyarısı (`Content Security Policy directive 'default-src 'self''`) kaydedilmektedir; sayfa render'ını engellememektedir.

---

## 3. SSH Erişimi ve Sunucu Durumu (Salt Okuma)

- **SSH Bağlantısı:** **BAŞARILI** (`.local/test-server.env` ile `.28` hedefi doğrulandı, `ssh -o BatchMode=yes yunpanel-test` üzerinden salt okunur kontrol yapıldı).
- **İşletim Sistemi:** `Ubuntu 24.04.5 LTS` · Çekirdek: `6.8.0-146-generic`
- **Çalışma Zamanı:** Node.js `v24.21.0` · npm `11.19.0`
- **Uptime ve Yük:** `up 15 days, 12:20, 1 user, load average: 0.01, 0.03, 0.00`
- **Disk Durumu (`df -h /`):** `/dev/sda2` — Boyut: `79G`, Kullanılan: `13G` (`%17`), Boş: `62G`
- **Bellek Durumu (`free -h`):** RAM Toplam: `11Gi`, Kullanılan: `1.3Gi`, Boş: `5.0Gi`, Önbellek: `5.8Gi`, Kullanılabilir: `10Gi` · Swap: `4.0Gi` (`0B` kullanılan)

### Servis Durumları (`systemctl is-active`)

| Servis / Birim | Durum | Açıklama |
|---|---|---|
| `yunpanel-api` | `active` | Panel arka uç API servisi (`/usr/lib/yunpanel`) |
| `yunpanel-web` | `active` | Panel web arayüzü servisi |
| `nginx` | `active` | Web sunucusu ve reverse proxy |
| `mariadb` / `mysql` | `active` | MariaDB `10.11.14-MariaDB-0ubuntu0.24.04.1` |
| `pdns` | `active` | PowerDNS yetkili DNS sunucusu |
| `postfix` (`postfix@-`) | `active` | SMTP posta aktarım servisi |
| `dovecot` | `active` | IMAP/POP3 posta teslim servisi |
| `rspamd` | `active` | İstenmeyen posta ve DKIM filtreleme servisi |
| `docker` / `containerd` | `active` | Konteyner çalışma zamanı |
| `php8.3-fpm` | `active` | PHP 8.3 FastCGI süreç yöneticisi |
| `ufw` | `active` | Güvenlik duvarı |
| `yunpanel-terminal` | `inactive` | İsteğe bağlı terminal birimi |
| `postgresql` | `inactive` (`not-found`) | Kurulu değil |
| `redis-server` | `inactive` (`not-found`) | Ana sistemde kurulu değil |
| `fail2ban` | `inactive` (`not-found`) | Kurulu değil |
| `opendkim` / `spamassassin` | `inactive` (`not-found`) | Yerine `rspamd` aktif |

---

## 4. Dokunulmayacak Mevcut Kaynaklar Listesi

> **KESİN KURAL:** Manuel test yapan ajanlar aşağıdaki mevcut kaynakları **silmez, değiştirmez ve askıya almaz**. Her ajan kendi test kaynaklarını `t<id-küçük>-a<n>` önekiyle (ör. `tweb01-a2.webrich.news`) oluşturur ve test sonunda temizler.

### 4.1 Mevcut Web Siteleri (`/websites` — 5 kayıt)
- `webrich.news`
- `yp-node.webrich.news`
- `yp-wp.webrich.news`
- `yp-form.webrich.news`
- `yp-staging.webrich.news`

### 4.2 Mevcut Alan Adları ve Alt Alan Adları (`/domains` — 7 kayıt)
- `webrich.news` (`domain`)
- `yp-node.webrich.news` (`subdomain`)
- `yp-wp.webrich.news` (`subdomain`)
- `yp-form.webrich.news` (`subdomain`)
- `yp-staging.webrich.news` (`subdomain`)
- `mail.webrich.news` (`subdomain`)
- `git-route.yp-node.webrich.news` (`subdomain`)

### 4.3 Mevcut Uygulamalar (`/applications` — 5 kayıt)
- `webrich.news` (`static`)
- `yp-node.webrich.news` (`node`)
- `yp-wp.webrich.news` (`php`)
- `yp-form.webrich.news` (`php`)
- `yp-staging.webrich.news` (`php`)

### 4.4 Mevcut Kullanıcılar ve Hesaplar
- **Panel Kullanıcıları (`/settings/users`):**
  - `yunsoft-owner` (Rol: `owner`, Durum: aktif)
- **Bayi (`reseller`) ve Müşteri (`customer`) Profilleri (`/resellers`, `/customers`):**
  - Mevcut kayıt yok (`0` bayi, `0` müşteri)
- **Sistem / Unix Kullanıcıları (`/etc/passwd`):**
  - `yunpanel-admin`
  - `yunpanel`
  - `yunpanel-roundcube`
  - `yunpanel-phpmyadmin`
  - `yunpanel-elfinder`

### 4.5 Mevcut Veritabanları (`/databases` — MariaDB — 3 kayıt)
- `phpmyadmin`
- `ypaccept_staging_20261011`
- `ypaccept_wp_20261011`

### 4.6 Mevcut DNS Bölgeleri (PowerDNS — 5 kayıt)
- `webrich.news`
- `yp-wp.webrich.news`
- `yp-form.webrich.news`
- `yp-staging.webrich.news`
- `yp-node.webrich.news`

### 4.7 Mevcut Posta Alan Adları (`/mail` — 1 kayıt)
- `yp-form.webrich.news`

### 4.8 Mevcut Docker Konteynerleri / Stack'leri ve Kayıtlı Sunucu
- **Docker Konteynerleri (`docker ps -a`):** Mevcut konteyner yok (`0` kayıt)
- **Kayıtlı Sunucu (`/servers`):** `YunPanel Test` (`hostname: test`)
