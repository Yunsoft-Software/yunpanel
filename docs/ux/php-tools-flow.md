# PHP-UI — Site PHP / WordPress / Composer görünümü

2026-09-25 · development · başlangıç `695319c9459ef621d75ee54c0c70c29cedb3f05b`.
UX-PL-04/06/07 ve PROD-14 alt dilimi; mevcut Ember dili ve Files girişleri korunur.

## İnceleme ve sıra

Mevcut `website-php-tools-service.js`, `website-php-tools-http.js` ve `php-cli-tool-manager.js` kullanılır. HTTP durum yolları ham JSON döndürüyor; panel istemcisi `data` bekliyor. Composer durum kontrolü kökteki composer.json dosyasını önce seçerken çalıştırma public altını önce seçiyor. Listeleme/komut hataları boş liste veya kurulu değil diye gösterilmemeli.

- [ ] PHP-UI-01: mevcut durum cevaplarına Website/sunucu/uygulama/Unix bağı ve geriye uyumlu `data` zarfı; kayıp bilgi için unknown ayrımı; Composer durum/çalıştırma için aynı proje seçimi.
- [ ] PHP-UI-02: site içinden PHP araçları durumu, WordPress sürümü/eklenti/tema listeleri ve Composer proje/kilit/doğrulama bilgisi. Bağımsız hata/yenileme, geç yanıt/oturum/site değişimi koruması, mevcut Dosyalar ve site terminali bağlantıları.
- [ ] PHP-UI-03: çalıştırılan seçili servis/istemci/bağlantı testleri ve kaynak kontrollerinin kanıtı; gerçek kabul ayrı.

Bu dilim PHP sürümü/FPM ayar formu veya tam WordPress Toolkit değildir. Yeni Composer install/update ve WP-CLI mutation düğmeleri eklenmez: mevcut doğrudan komut yollarının durable job/onay/kilit/yeniden yetkilendirme sınırları ayrı kaynak işidir. CLI motoru yeniden yazılmaz, yetki açılmaz.

## T-DEV-PHP-UI — Codex / gerçek kabul

- [ ] Node >=24.11.1/npm >=11 tam checkout ve npm ci/check/build; gerçek React/Vite ve bütün eski PHP araç testleri.
- [ ] Owner ve Site A/Site B: gerçek session/CSRF/tenant yolları, yabancı Website/application/Unix bağı, 401/403, uzun kontrol sırasında erişim iptali.
- [ ] Yalnız `.local/test-server.env` ile izinli test hedefinde gerçek WP-CLI/Composer: eksik binary, kurulu/bozuk WordPress, eklenti/tema JSON hatası, composer.json/lock yokluğu ve erişim hatası, kök ve public altında iki proje. `.44` Plesk hostuna dokunma.
- [ ] Üretim tarayıcısı: mobil/masaüstü, uzun envanter, klavye, eski Files ve cron rotaları, bağımsız hata/yenileme ve geç gelen cevap. Kaynak testi gerçek host kabulü değildir.
- [ ] Aynı Unix kimliğinde release değişimi, süreçler arası kaynak kilidi ve uzun CLI sırasında canlı yetki iptali; bu dilim bunları tamamlandı saymaz.

Üst UX/PROD/RS ve Website silme/askı/backup/istatistik işleri açık kalır.
