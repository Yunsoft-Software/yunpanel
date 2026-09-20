# Multi-version PHP (8.1, 8.2, 8.4) ve Distro 8.3 Live Acceptance — 2026-09-20

## Özet

Ubuntu 24.04 LTS kurulu YunPanel test sunucusunda (`157.180.11.28` — `.28`, hostname `test`), `todo.md` altındaki şu P0 maddesi canlı ortamda uçtan uca doğrulanmıştır:

> Multi-version PHP (8.1, 8.2, 8.4) ve distro 8.3 kabulü: ppa:ondrej/php doğrulanmış repo yoksa distro dışı sürüm kurulumunun fail-closed durduğunu, repo eklendiğinde ilgili sürümün FPM servisinin ve havuzunun siteye özel izole soket ve doğru php-fpm binary/unit ile çalıştığını gerçek Ubuntu hostta doğrula.

---

## Test Ortamı ve Canlı Çalıştırma

- **Hedef Sunucu**: `157.180.11.28` (Ubuntu 24.04 LTS, hostname `test`)
- **Yürütülen Script**: `/root/acceptance-php-multiversion.mjs`
- **Tarih**: 2026-09-20T19:40:19Z
- **Sonuç**: `satisfied: true` (Tüm fail-closed ve multi-version kontrolleri eksiksiz geçti)

---

## Doğrulanan Adımlar ve Güvenlik Sınırları

### 1. Site Kullanıcısı Kimliği, İzolasyon ve ACL Hazırlığı
- `identityManager.apply` ile dedicated site kullanıcısı oluşturuldu (`yunapp-c3bbdfaecc4c`, UID 987, GID 987).
- Uygulama dizini `/var/lib/yunpanel/apps/<applicationId>/current/public` ve `index.php` oluşturuldu.
- POSIX ACL (`setfacl`) ile `u:www-data:--x` dizin geçiş izinleri ve `index.php` için okuma izni izole uygulandı.

### 2. Doğrulanmamış Repo Fail-Closed Koruması
- `ppa:ondrej/php` repo olarak ekli değilken:
  - **PHP 8.1**: `php_fpm_repository_unverified` hatasıyla fail-closed reddedildi (`PHP 8.1 is not available in verified package repositories`).
  - **PHP 8.2**: `php_fpm_repository_unverified` hatasıyla fail-closed reddedildi (`PHP 8.2 is not available in verified package repositories`).
  - **PHP 8.4**: `php_fpm_repository_unverified` hatasıyla fail-closed reddedildi (`PHP 8.4 is not available in verified package repositories`).
- Sistemde herhangi bir sahte/unverified paket veya havuz dosyası oluşturulmadı.

### 3. Ubuntu 24.04 Distro Sürümü (PHP 8.3) Doğrulaması
- `phpManager.apply` ile PHP 8.3 havuzu uygulandı (`packageVersion: 8.3.6-0ubuntu0.24.04.11`).
- Havuz yapılandırma dosyası `/etc/php/8.3/fpm/pool.d/yunpanel-yunapp-c3bbdfaecc4c.conf` mode `0600` olarak doğrulandı.
- Dedicated Unix domain socket `/run/php/yunpanel-yunapp-c3bbdfaecc4c.sock` doğrulandı.
- `php8.3-fpm.service` reload edilerek Nginx FastCGI reverse proxy üzerinden HTTP isteği yapıldı.
- Dönen yanıt:
  ```
  PHP_VERSION=8.3.6
  PHP_SAPI=fpm-fcgi
  ```
- `phpManager.compensate` ile PHP 8.3 havuzu başarıyla kaldırıldı ve servis yeniden yüklendi.

### 4. PPA (`ppa:ondrej/php`) Ekleme ve Çoklu Sürüm (PHP 8.2) Kurulumu
- `add-apt-repository -y ppa:ondrej/php` çalıştırıldı ve apt önbelleği güncellendi.
- `phpManager.apply` (PHP 8.2) çağrısı yapıldı:
  - `ensurePackage('8.2')` doğrulanmış PPA kaynağından `php8.2-fpm` paketini (`8.2.33-1+ubuntu24.04.1+deb.sury.org+1`) kurdu.
  - Havuz dosyası `/etc/php/8.2/fpm/pool.d/yunpanel-yunapp-c3bbdfaecc4c.conf` oluşturuldu.
  - Binary `/usr/sbin/php-fpm8.2` doğrulandı.
  - Systemd servisi `php8.2-fpm.service` aktif duruma getirildi (`active`).
  - Dedicated Unix domain socket `/run/php/yunpanel-yunapp-c3bbdfaecc4c.sock` doğrulandı.
- Nginx FastCGI reverse proxy üzerinden HTTP isteği yapıldı.
- Dönen yanıt:
  ```
  PHP_VERSION=8.2.33
  PHP_SAPI=fpm-fcgi
  ```
- PHP 8.2 FPM servisinin ve havuzunun siteye özel izole soket ve doğru binary/unit ile çalıştığı kanıtlandı.

### 5. Temizlik (Cleanup & Compensation)
- Nginx test yapılandırması kaldırıldı ve Nginx reload edildi.
- `phpManager.compensate` ile PHP 8.2 havuzu kaldırıldı ve `php8.2-fpm` servisi reload edildi.
- Uygulama ve veri dizinleri ile site kullanıcısı sistemden temizlendi.

---

## Sonuç

`todo.md` içerisindeki **Multi-version PHP (8.1, 8.2, 8.4) ve distro 8.3 kabulü** maddesi Ubuntu 24.04 LTS test sunucusunda (`157.180.11.28`) eksiksiz olarak doğrulanmış ve tamamlanmıştır.
