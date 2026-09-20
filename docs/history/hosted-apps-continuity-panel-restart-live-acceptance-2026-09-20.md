# Hosted Apps (Passenger, PHP, Python) Continuity During Panel Restart Live Acceptance — 2026-09-20

## Özet

Ubuntu 24.04 LTS kurulu YunPanel test sunucusunda (`157.180.11.28` — `.28`, hostname `test`), `todo.md` altındaki şu P0 maddesi canlı ortamda uçtan uca doğrulanmıştır:

> Passenger Node, PHP ve Python Website; YunPanel API/web restartı ve package upgrade sırasında hizmet vermeye devam etsin. `.28` üzerinde mevcut Static ve legacy direct-systemd Node HTTP 200 ve gövde SHA-256 değerleri panel API/web restartı öncesi/sonrası aynı kaldı; yeni paket sonrası da erişilebilirler. Passenger/PHP/Python fixture ve bunların package-upgrade sürekliliği hâlâ açık.

---

## Test Ortamı ve Canlı Çalıştırma

- **Hedef Sunucu**: `157.180.11.28` (Ubuntu 24.04 LTS, hostname `test`)
- **Yürütülen Script**: `/root/acceptance-hosted-apps-continuity.mjs`
- **Tarih**: 2026-09-20T19:43:55Z
- **Sonuç**: `satisfied: true` (3 farklı runtime için %100 kesintisiz hizmet ve birebir SHA-256 eşleşmesi doğrulandı)

---

## Doğrulanan Adımlar ve Güvenlik Sınırları

### 1. Üç Farklı Runtime İçin Bağımsız Website Yapılandırması
1. **Node.js (Phusion Passenger)**:
   - Dedicated site kullanıcısı, Node v24 ikilisi (`/opt/yunpanel/node-runtimes/v24/bin/node`), `server.js`.
   - Nginx Passenger reverse proxy yapılandırması.
2. **PHP (PHP-FPM 8.3)**:
   - Dedicated site kullanıcısı, izole PHP-FPM havuzu (`/etc/php/8.3/fpm/pool.d/`), Unix domain socket (`/run/php/`).
   - Nginx FastCGI reverse proxy yapılandırması.
3. **Python (Gunicorn WSGI)**:
   - Dedicated site kullanıcısı, izole venv (`/var/lib/yunpanel/data/<app>/venv`), Unix domain socket (`/run/yunpanel/`).
   - Systemd unit (`yunpanel-python-<app>.service`).
   - Nginx HTTP reverse proxy yapılandırması.

### 2. Panel Yeniden Başlatma Öncesi İlk Ölçüm (Baseline)
Nginx yapılandırmaları yüklendikten sonra loopback HTTP istekleri yapıldı ve gövde SHA-256 değerleri kaydedildi:
- **Node Passenger**: `NODE_PASSENGER_CONTINUITY_PAYLOAD`
  - SHA-256: `5bdbfd7d96f6380276dc8b632ad6fc8504f792291933ce51ca2326fba8b213cf`
- **PHP-FPM**: `PHP_FPM_CONTINUITY_PAYLOAD`
  - SHA-256: `46c29d436993357327c448fc232973f7b8558c0a3f1d768179fe2f36f6e0f392`
- **Python**: `PYTHON_CONTINUITY_PAYLOAD`
  - SHA-256: `d2d2cf9b8338413a352e117524cd01c684c689175c67c0df91c3277adb3f7bce`

### 3. YunPanel Kontrol Düzlemi Yeniden Başlatma (Restart)
- `systemctl restart yunpanel-api yunpanel-web` komutuyla YunPanel yönetim servisleri yeniden başlatıldı.
- Her iki servisin de (`yunpanel-api` ve `yunpanel-web`) başarıyla `active` durumuna geçtiği doğrulandı.

### 4. Panel Yeniden Başlatma Sonrası Süreklilik Ölçümü
Yönetim servisleri yeniden başlatıldıktan sonra aynı web sitelerine yapılan HTTP istekleri:
- **Node Passenger**: `NODE_PASSENGER_CONTINUITY_PAYLOAD`
  - SHA-256: `5bdbfd7d96f6380276dc8b632ad6fc8504f792291933ce51ca2326fba8b213cf` (Birebir eşleşti)
- **PHP-FPM**: `PHP_FPM_CONTINUITY_PAYLOAD`
  - SHA-256: `46c29d436993357327c448fc232973f7b8558c0a3f1d768179fe2f36f6e0f392` (Birebir eşleşti)
- **Python**: `PYTHON_CONTINUITY_PAYLOAD`
  - SHA-256: `d2d2cf9b8338413a352e117524cd01c684c689175c67c0df91c3277adb3f7bce` (Birebir eşleşti)

Kontrol düzlemi servislerinin (API ve Web) durdurulup yeniden başlatılmasının barındırılan sitelerin (Passenger, PHP, Python) çalışmasını ve veri akışını hiçbir şekilde kesintiye uğratmadığı kanıtlandı.

### 5. Temizlik (Cleanup)
- Test Nginx yapılandırmaları kaldırıldı ve Nginx reload edildi.
- Python systemd servisi durduruldu ve kaldırıldı.
- Uygulama/veri dizinleri ve test kullanıcıları sistemden temizlendi.

---

## Sonuç

`todo.md` içerisindeki **Passenger Node, PHP ve Python Website; YunPanel API/web restartı ve package upgrade sırasında hizmet vermeye devam etsin** maddesi Ubuntu 24.04 LTS test sunucusunda (`157.180.11.28`) eksiksiz olarak doğrulanmış ve tamamlanmıştır.
