# phpMyAdmin managed-package baseline — 2026-09-17

Bu dilim shared phpMyAdmin ürün akışının yalnız kurulum ve bounded health temelini tamamlar; protected web endpoint, signon handoff veya Website-scope browser oturumu hazır değildir.

- Managed-service allowlist'i Ubuntu `phpmyadmin`, `php-fpm` ve `php-mysql` paketlerini exact sırayla kurar.
- Health inspection yalnız `/usr/share/phpmyadmin/index.php`, `/etc/phpmyadmin/config.inc.php` ve sabit PHP syntax kontrolünü çalıştırır; komut çıktısını job/public state'e taşımaz.
- phpMyAdmin daemon gibi modellenmez: `active=false`, `units=[]`, `health.status=installed` döner ve systemd control operation'ı queue edilmeden reddedilir.
- Durable result sanitization, mutation receipt ve restart recovery unitless uygulama davranışını sabit servis politikasından türetir; Roundcube adına bağlı özel recovery kuralı kullanılmaz.
- Deterministic PHP 8.3 FPM template'i `yunpanel-phpmyadmin` identity'sini, ayrı socket'i, private temp/session dizinlerini, strict/secure/HttpOnly/SameSite session ayarlarını ve bounded upload limitini sabitler.
- Nginx template'i public TCP listener üretmez; yalnız `/run/yunpanel/phpmyadmin-http.sock` Unix socket'ini ve gelecekteki gateway için `root:yunpanel-web 0660` metadata kontratını yayınlar. `setup`, `test`, `libraries`, `templates` ve hidden path erişimleri reddedilir.
- Host staging manager yalnız exact preview shape/digest/byte sözleşmesine uyan FPM ve Nginx içeriklerini digest-scoped `0700` dizinlere `0640` olarak atomik yazar; content/mode/symlink veya runtime/socket identity metadata drift'ini fail-closed raporlar.
- Bu package/config ve template state endpoint readiness değildir. Dedicated runtime identity/dizin apply'i, FPM/Nginx stage/validate/activate/rollback, Unix socket metadata/health, short-lived signon ve cross-Website isolation plan/TODO'da açık kalır.

Kaynak testleri protocol katalog/validation, host install/inspect, API result policy, HTTP queue boundary, receipt-backed restart recovery ve FPM/Nginx template determinism/fail-closed path kurallarını kapsar. Güvenlik direktifleri phpMyAdmin'ın resmi installation/security rehberindeki ayrı session storage, production PHP, auxiliary path engeli ve authentication proxy önerileriyle uyumludur. Gerçek Ubuntu package/debconf/FPM/Nginx kabulü `todo.md` içindedir.
