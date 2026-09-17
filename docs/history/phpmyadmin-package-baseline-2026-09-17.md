# phpMyAdmin managed-package baseline — 2026-09-17

Bu dilim shared phpMyAdmin ürün akışının yalnız kurulum ve bounded health temelini tamamlar; protected web endpoint, signon handoff veya Website-scope browser oturumu hazır değildir.

- Managed-service allowlist'i Ubuntu `phpmyadmin`, `php-fpm` ve `php-mysql` paketlerini exact sırayla kurar.
- Health inspection yalnız `/usr/share/phpmyadmin/index.php`, `/etc/phpmyadmin/config.inc.php` ve sabit PHP syntax kontrolünü çalıştırır; komut çıktısını job/public state'e taşımaz.
- phpMyAdmin daemon gibi modellenmez: `active=false`, `units=[]`, `health.status=installed` döner ve systemd control operation'ı queue edilmeden reddedilir.
- Durable result sanitization, mutation receipt ve restart recovery unitless uygulama davranışını sabit servis politikasından türetir; Roundcube adına bağlı özel recovery kuralı kullanılmaz.
- Bu package/config state endpoint readiness değildir. Dedicated runtime identity, FPM pool/socket, protected Nginx/gateway config, short-lived signon ve cross-Website isolation plan/TODO'da açık kalır.

Kaynak testleri protocol katalog/validation, host install/inspect, API result policy, HTTP queue boundary ve receipt-backed restart recovery yollarını kapsar. Gerçek Ubuntu package/debconf/FPM/Nginx kabulü `todo.md` içindedir.
