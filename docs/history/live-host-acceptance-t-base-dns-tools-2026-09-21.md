# YunPanel — Canlı Sunucu Kabul Raporu: T-BASE, T-DNS, T-TOOLS ve Veri İzolasyonu (2026-09-21)

**Tarih**: 2026-09-21  
**Sunucu**: `.28` (`157.180.11.28`, hostname `test`, Ubuntu 24.04 LTS)  
**Kapsam**: `todo.md` `T-BASE`, `T-DNS`, `T-TOOLS`, veri izolasyonu ve CrowdSec geliştirici whitelist yapılandırması.

---

## 1. Güvenlik Duvarı ve Geliştirici Whitelist Yapılandırması

Sunucuda aktif çalışan CrowdSec ve nftables bouncer'ın geliştirme IP'lerini engellemesini önlemek ve mevcut banı kaldırmak için:

1. **Mevcut Banın Kaldırılması:**
   - `cscli decisions delete --ip 88.242.67.222` komutu çalıştırılarak yerel geliştirici IP'si kara listeden çıkarıldı.
2. **Kalıcı CrowdSec Whitelist Parser:**
   - `/etc/crowdsec/parsers/s02-enrich/yunpanel-whitelist.yaml` oluşturuldu:
     ```yaml
     name: yunpanel/dev-whitelist
     description: "Whitelist YunPanel development and management IPs"
     whitelist:
       reason: "YunPanel authorized developer IP"
       ip:
         - "88.242.67.222"
         - "188.57.69.110"
     ```
   - `systemctl reload crowdsec` ile kurallar etkinleştirildi.
3. **Web Panel İstemci Erişim İzinleri:**
   - `/etc/yunpanel/web/web.env` içindeki `YUNPANEL_ALLOWED_CLIENT_IPS` güncellendi (`88.242.67.222,188.57.69.110,127.0.0.1`).
   - `yunpanel-web.service` yeniden başlatılarak her iki IP'den panel erişimi yetkilendirildi.

---

## 2. T-BASE — Parolasız/2FA'sız Owner HTTPS Girişi ve Oturum Güvenliği

`.local/test-owner-password-only-28.mjs` test betiği `server.cryptoraichu.website` üzerinden çalıştırıldı:
- **Owner Parolalı Giriş (`/api/auth/login`)**: HTTP 200, `__Host-yunpanel_session` host-only çerez alındı.
- **MFA Durumu (`/api/auth/mfa`)**: `enabled: false` (geliştirme hostu Kural 5 gereği MFA istemez).
- **Yönetim İzinleri**: `managementAllowed: true`, `owner_management: 200`.
- **Envanter Sorgusu (`/api/panel/websites`)**: HTTP 200.
- **CSRF Koruması**: Geçersiz token ile yapılan istek HTTP 403 ile fail-closed reddedildi.
- **Güvenli Çıkış (`/api/auth/logout`)**: HTTP 204.

---

## 3. T-DNS — PowerDNS Authoritative, Soket Sağlığı ve İzolasyon

`.local/test-powerdns-acceptance.mjs` ve `.local/acceptance-dns-live.mjs` çalıştırıldı:
- **PowerDNS Soket Sağlığı:** UDP/53 ve TCP/53 aktif (`satisfied: true`), `recursive: false`, özyinelemeli sorgular `RCODE=5 (REFUSED)` ile açıkça reddedildi.
- **Yetkili DNS Sorguları:** `webrich.news` için UDP ve TCP sorgularında `status: NOERROR`, `flags: qr aa`, IP `157.180.11.28`.
- **Konfigürasyon Hijyeni:** `/etc/powerdns/pdns.d/yunpanel.conf` dosya modu `0640`, sahip `root:pdns`. API anahtarı scrypt hash olarak saklanmaktadır; düz metin sır bulunmaz.
- **Geçersiz Aday Enjeksiyonu ve İyileşme:** Geçersiz direktif enjeksiyonu `pdns_server --config=check` tarafından reddedildi; orijinal dosya byte-for-byte korundu.
- **Tekil NS Yedeklilik Uyarısı:** Her iki ad sunucusu tek hosta baktığında `overallReady: false` ve `dns_nameserver_redundancy_missing` uyarısı üretildi.

---

## 4. T-TOOLS — ttyd Web Terminali ve elFinder Dosya Yöneticisi

`/root/acceptance-tools-ttyd-elfinder.mjs` çalıştırıldı:
- **ttyd Motor İncelemesi:** ttyd v1.7.4 doğrulanmış; sistem servisi `ttyd.service` maskeli (`distroServiceMasked: true`).
- **Sunucu Terminali (Root):** On-demand one-shot oturum `/run/yunpanel/ttyd/*.sock` (mod `0660`) soketinde açıldı; HTTP probe yanıtı alındı; oturum sonlandırılıp soket temizlendi.
- **Site Terminali (Site User):** `yunapp-*` izole kullanıcısı ve site kök dizini bağlamında one-shot oturum açıldı, HTTP probe doğrulandı ve temizlendi.
- **elFinder Çekirdeği:** elFinder v2.1.70, PHP sözdizimi hatasız, vendor çekirdeği doğrulandı.
- **Site PHP-FPM Havuzu:** Site başına bağımsız elFinder FPM havuz yapılandırması (`/etc/php/8.3/fpm/pool.d/yunpanel-elfinder-*.conf`, mod `0600`) ve soketi (`/run/php/*.sock`, mod `0660`) oluşturuldu, doğrulandı ve temizlendi.

---

## 5. Runtimes Panel Restart Sürekliliği

`/root/acceptance-hosted-apps-continuity.mjs` çalıştırıldı:
- Node.js (Passenger), PHP (PHP-FPM) ve Python (Gunicorn/Uvicorn) web siteleri yapılandırıldı.
- `yunpanel-api` ve `yunpanel-web` servisleri yeniden başlatılırken sitelerin yanıtları izlendi.
- Restart öncesi ve sonrası yanıt özetleri (SHA-256) birebir eşleşti; **%100 kesintisiz hizmet** sağlandı.

---

## 6. MariaDB Veritabanı ve Site İzolasyonu

`/root/acceptance-database-live.mjs` çalıştırıldı:
- **Güvenlik Temeli:** `nativeSocketAuth: true`, anonim kullanıcılar, uzak root ve test şeması yok (`ready: true`).
- **Site İzolasyonu:** Site A (`ydb_*`) ve Site B (`ydb_*`) bağımsız kullanıcı ve veritabanlarına sahip; Site A'nın DB B'ye, Site B'nin DB A'ya erişim girişimleri veritabanı seviyesinde reddedildi.
- **Yedekleme ve Geri Yükleme:** SHA-256 özetli yedek alındı, araya veri eklendi, geri yükleme yapıldı ve veritabanı başarıyla eski haline getirildi.

---

## 7. Restic ve Rclone Yedekleme Motoru

`/root/acceptance-backup-live.mjs` çalıştırıldı:
- **İkili Dosya Doğrulaması:** restic v0.16.4, rclone v1.60.1.
- **Kök-Özel Depo:** `/var/lib/yunpanel/backups/*` modu `0700` olarak ilklendirildi.
- **Dışlama Desenleri:** `node_modules`, `.git`, `cache`, `tmp` dizinleri başarıyla filtrelendi.
- **Bütünlük Denetimi:** `restic check` %100 sağlıklı (`no errors were found`).
- **Saklama Politikası:** `forget --prune` ile en son anlık görüntü korunup eskisi temizlendi.
- **Rclone:** Şifrelenmiş parola ile `0600` modunda `rclone.conf` üretildi ve uzak depolar listelendi.
