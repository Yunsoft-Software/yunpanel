# GoAccess Canlı Kabulü ve Site İzolasyonu — 2026-09-20

## Kapsam

GoAccess per-site Nginx log izleme, statik HTML/JSON raporlama, aynı kökten (same-origin) WebSocket proxy'si, gerçek zamanlı (real-time) arka plan servisi (daemon), servis yeniden başlatma (restart), log rotasyonu (logrotate) ve site bazlı izolasyon doğrulaması yapıldı. Canlı kabul yalnız repo dışı `.local/test-server.env` dosyasında tanımlı `157.180.11.28` hostunda gerçekleştirildi. `.44` ile biten Plesk sunucusuna hiçbir bağlantı kurulmadı ve işlem yapılmadı.

## Uygulanan ve Doğrulanan Bileşenler

1. **Paket ve Dağıtım Uyumluluğu:**
   - Ubuntu 24.04 LTS üzerinde `goaccess` v1.8.1 (`1:1.8.1-1build3`) doğrulandı ve kuruldu.
   - RFC 6455 uyumlu WebSocket desteği ve yerel Unix domain socket (`--unix-socket`) yeteneği teyit edildi.

2. **Per-Site Nginx Log İzolasyonu (`packages/config-templates`):**
   - Nginx sanal sunucu şablonları güncellendi; her Website için birincil alan adına bağlı izole `access_log /var/log/nginx/<primaryDomain>.access.log;` ve `error_log /var/log/nginx/<primaryDomain>.error.log;` yapılandırması tanımlandı.
   - Test sunucusunda `webrich.news` ve `mailtest.webrich.news` sanal sunucuları güncellendi. Farklı yollara gönderilen isteklerle (`/webrich-specific-test-path` ve `/mailtest-specific-test-path`), `webrich.news.access.log` ve `mailtest.webrich.news.access.log` dosyalarının kesin olarak izole kaldığı doğrulandı.

3. **GoAccess Yönetim Katmanı (`packages/host-runtime`):**
   - `createGoAccessManager` modülü ile `inspectGoAccess()`, `generateStaticReport()`, `startRealtimeDaemon()`, `stopRealtimeDaemon()`, `restartRealtimeDaemon()`, `inspectDaemon()` ve `readReport()` yöntemleri geliştirildi.
   - `UMask=0077` kısıtlaması altında dahi web dashboard'un (`yunpanel` kullanıcısı) raporları okuyabilmesi ve Unix soketine bağlanabilmesi için `/var/lib/yunpanel/reports/goaccess` dizini `0755`, statik rapor dosyaları `0644`, `/run/yunpanel/goaccess` soket dizini `0755` ve soket dosyası `0666` izinleriyle yönetildi.

4. **API Yüzeyi (`apps/api`):**
   - `GET /api/panel/websites/:websiteId/analytics/report`: JSON veya `?format=html` biçiminde statik rapor üretimi ve sunumu.
   - `GET /api/panel/websites/:websiteId/analytics/status`: Gerçek zamanlı daemon'ın PID, soket ve WebSocket URL durum denetimi.
   - `POST /api/panel/websites/:websiteId/analytics/realtime/start`: Arka planda daemonize edilen GoAccess sürecini başlatma.
   - `POST /api/panel/websites/:websiteId/analytics/realtime/stop`: Çalışan GoAccess sürecini durdurma ve soket/PID dosyalarını temizleme.
   - `POST /api/panel/websites/:websiteId/analytics/realtime/restart`: Süreci kapatıp taze log dosyası üzerinde yeniden başlatma.

5. **Ağ Geçidi ve WebSocket Proxy (`apps/web`):**
   - `IntegratedToolGateway` sözleşmesine `goaccess` eklendi (`publicPrefix: '/tools/goaccess'`, `accessPath: '/api/goaccess-gateway-access'`, `accessMode: 'owner'`, `socketRoot: '/run/yunpanel/goaccess'`).
   - `GET /tools/goaccess/:websiteId/`: Yetkili Owner oturumu doğrulandıktan sonra HTML raporunu okur; rapordaki `var connection = {...}` WebSocket bağlantı nesnesini panelin aynı kök (same-origin) `wss://.../tools/goaccess/:websiteId/ws` adresine dinamik olarak yeniden yazar.
   - `GET /tools/goaccess/:websiteId/ws` (Upgrade): Yetkili Owner oturumu ve Origin (`YUNPANEL_PUBLIC_ORIGIN`) doğrulandıktan sonra WebSocket bağlantısını doğrudan `/run/yunpanel/goaccess/:websiteId.sock` Unix etki alanı soketine proxy eder.

## Canlı Kanıt ve Test Sonuçları (.28)

1. **Log İzolasyonu:**
   - `curl -k -H "Host: webrich.news" https://127.0.0.1/webrich-specific-test-path`
   - `curl -k -H "Host: mailtest.webrich.news" https://127.0.0.1/mailtest-specific-test-path`
   - `webrich.news.access.log` yalnız `webrich-specific-test-path` içerdi.
   - `mailtest.webrich.news.access.log` yalnız `mailtest-specific-test-path` içerdi.

2. **Statik Rapor İzolasyonu:**
   - `webrich.news` raporunda `webrich-specific-test-path` bulundu; `mailtest-specific-test-path` bulunmadı.
   - `mailtest.webrich.news` raporunda `mailtest-specific-test-path` bulundu; `webrich-specific-test-path` bulunmadı.

3. **Ağ Geçidi Güvenlik Sınırları:**
   - Yetkisiz istek `GET /tools/goaccess/:websiteId/` -> `401 Unauthorized` ile reddedildi.
   - Yetkili Owner isteği -> `200 OK`, `Content-Type: text/html; charset=utf-8`, CSP ve `no-store` başlıklarıyla raporu sundu.
   - Yetkisiz WebSocket bağlantısı -> `401 Unauthorized` ile reddedildi.
   - Farklı kök (`Origin: https://evil.com`) WebSocket bağlantısı -> `403 Forbidden` ile reddedildi.
   - Geçerli Owner oturumu ve doğru kök ile WebSocket bağlantısı -> `101 Switching Protocols` ile başarıyla bağlandı (`GATEWAY_WS_CONNECTED_SUCCESSFULLY`).

4. **Daemon Yaşam Döngüsü ve Yeniden Başlatma:**
   - `POST .../analytics/realtime/start` -> PID 918026 ile daemon başlatıldı, soket `0666` ile oluşturuldu.
   - `POST .../analytics/realtime/restart` -> PID 918828 / 919107 ile temiz yeniden başlatma gerçekleşti.
   - `POST .../analytics/realtime/stop` -> Süreç sonlandırıldı, PID ve soket dosyaları silindi; durdurulmuş sokete gelen WebSocket isteği `502 Bad Gateway` ile güvenli biçimde sonlandırıldı.

5. **Log Rotasyonu:**
   - `logrotate -f /etc/logrotate.d/nginx` çalıştırıldı.
   - `webrich.news.access.log` dosyası `webrich.news.access.log.1` olarak arşivlendi ve `0640 www-data adm` izinleriyle yeni boş dosya oluşturuldu.
