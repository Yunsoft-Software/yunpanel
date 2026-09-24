# PHP-UI — Site PHP / WordPress / Composer görünümü

2026-09-25 · development · başlangıç `695319c9459ef621d75ee54c0c70c29cedb3f05b`.
UX-PL-04/06/07 ve PROD-14 alt dilimi; mevcut Ember dili ve Files girişleri korunur.

## Tamamlanan kaynak dilimi

- [x] **PHP-UI-01 kaynak:** `6c212843`; mevcut PHP durum servisinde Website/sunucu/uygulama/Unix bağı, kontrol öncesi/sonrası ilişkiyi tekrar okuma, kopyalanmış bağ snapshot'ı. İki GET durum endpoint'i eski üst seviye alanlarını koruyup panel istemcisi için `data` zarfı ekler. `schemaVersion: 1`, `checks` ve `inspectedAt` ile kayıp bilgi ayrışır. Bilinmeyen `installed`/`valid` değeri artık `null`; başarısız CLI kontrolü kesin kurulu değil/geçersiz sonucu sayılmaz. Eski istemciler bu bilinmeyen değeri desteklemelidir.
- [x] **PHP-UI-01 Composer düzeltmesi:** durum kontrolü ve mevcut çalıştırma aynı proje seçicisini kullanır. Kök ve public altında iki composer.json varsa ikisi de kök projeyi seçer. Yalnız ENOENT yokluk kabul edilir; erişim hatası, symlink veya dizin şeklindeki proje dosyası başka projeye sessiz fallback üretmez. composer.lock okunamazsa yok sayılmaz.
- [x] **PHP-UI-02 istemci:** `c1fa3725`; bağımsız WordPress/Composer GET kanalları, hedef ve yanıt doğrulaması, son yanıt sırası, istek iptali, 401/403 sonrası iki kanalı temizleme. Bir araçtaki hata diğerinin başarılı sonucunu silmez. Ham CLI çıktısı veya bilinmeyen JSON alanları arayüze taşınmaz.
- [x] **PHP-UI-02 ekran:** `1e287437`; mevcut Site → Genel Bakış → Uygulama sekmesi PHP sitelerinde **PHP / WordPress** olarak etiketlenir. Aynı `/websites/:domainId/node` adresi korunur; yeni görev grubu veya paralel dashboard yoktur. WordPress/WP-CLI sürümü, eklenti/tema listeleri, bildirilen güncellemeler, Composer proje/kilit/doğrulama ve proje konumu görünür. Eklenti/tema listeleri 20 kayıtlık sayfalıdır. Ayrı Durumu kontrol et, son kontrol zamanı, eski veri/hata ve mevcut Dosyalar/terminal dönüşleri vardır. ApplicationOperations, EnvironmentPanel, Files, SSL ve cron bağlantıları korunur; global tema/CSS değiştirilmedi.
- [x] **PHP-UI-03 seçili kontrol:** aşağıdaki aynı koşuda 83 geçti / 0 başarısız / 0 atlandı. Gerçek build/browser/host kabulü açık.

## Çalıştırılan kontroller ve kanıt sınırı

Node **22.16.0** / npm **10.9.2**. Beş test dosyasında **83 test**: 29 yeni servis davranışı + 5 mevcut PHP servis regresyonu + 5 gerçek servis→UI veri sözleşmesi + 37 istemci/model davranışı + 7 kaynak bağlantısı. Önceki cron turunun 83 testi bu tur yeniden koşulmadı ve bu toplama eklenmedi.

Tam checkout GitHub DNS çözümleme hatası nedeniyle alınamadı. Servis testleri gerçek kaynak modülünü yükledi; `@yunpanel/host-runtime` importu yerel, repo dışı bir loader ile yalnız hata sınıfı/default-factory kabuğuna çözüldü. **Bütün CLI/registry/lstat davranışları testte açıkça verilen fixture'lardır.** Bu kontroller gerçek WP-CLI, Composer, Express/auth veya host çalıştırması değildir. Native bağımlılık çalıştı iddiası yoktur. Depoya sahte runtime paketi veya loader eklenmedi.

Tam checkout'ta çalıştırılacak aynı test grubu:

```sh
node --test apps/api/test/website-php-tools-service.test.js apps/api/test/website-php-tools-status.test.js apps/api/test/website-php-tools-contract.test.js apps/web/test/php-tools-client.test.js apps/web/test/php-tools-wiring.test.js
```

İki JSX (`SitePhpToolsPanel`, `SiteDetailPage`) sözdizimi/dönüşüm kontrolü ve dört kaynak JS (`website-php-tools-service/http`, `php-tools-model/client`) için `node --check` geçti. JSX kontrolünde ortamın TypeScript transpiler'ı kullanıldı; uygulamaya TypeScript eklenmedi ve React render/Vite build yapılmış sayılmadı. **Altı değişmiş/yeni kaynak dosyasının Git blob'ları `1e287437` ile birebir eşleşti.**

## Ürün ve güvenlik sınırı

Bu dilim salt durum/görünüm ve mevcut servis düzeltmesidir; PHP sürümü/FPM ayar formu veya tam WordPress Toolkit değildir. Yeni Composer install/update, WordPress kur/güncelle veya genel komut çalıştırma düğmesi eklenmedi. Mevcut doğrudan run endpoint'leri yeniden uygulanmadı; durable job/onay/kilit/yeniden yetkilendirme işleri ayrı kaynak dilimidir. Çağrı sonucunun bilinmemesi otomatik komut tekrarına gerekçe değildir.

Durum GET'leri de mevcut CLI üzerinden site kodu yükleyebilir; bunlar dosya yazmayacağı garanti edilen pasif filesystem okumaları değildir. Arayüz periyodik polling yapmaz. İstek iptali hosttaki CLI sürecinin durduğunu kanıtlamaz. CLI manager'ın binary keşif içi davranışı değiştirilmedi; araç tespit edilmesi çalışan site veya sağlıklı runtime kanıtı değildir.

Komut öncesi/sonrası bağ denetimi süreçler arası kilit değildir. Aynı kimlikle release/symlink değişimi ve uzun komut sırasında canlı oturum iptali ayrı kabul ister. Backend auth/CSRF ve site-resource-boundary kaldırılmadı, yeni reseller erişimi açılmadı. Veri/Unix kullanıcı/sertifika yeniden atanmadı. Bu tur test veya production sunucusuna, özellikle `.44` Plesk hostuna dokunulmadı; GitHub Actions/deploy yoktur.

## T-DEV-PHP-UI — Codex / gerçek kabul

- [ ] Node >=24.11.1/npm >=11 tam checkout ve npm ci/check/build; yukarıdaki grubu gerçek paket importlarıyla çalıştır. Bütün eski PHP HTTP/runtime/CLI ve site-route testlerini de çalıştır.
- [ ] Owner ve Site A/Site B: gerçek session/CSRF/tenant yolları, yabancı Website/application/Unix bağı, 401/403, uzun kontrol sırasında erişim iptali. Gerçek GET cevaplarının proxy ve panelRequest `data` sözleşmesi; eski ham istemcilerin nullable bilinmeyen alanlarla uyumu.
- [ ] Yalnız `.local/test-server.env` ile izinli test hedefinde WP-CLI/Composer: eksik/erişilemeyen binary, kurulu/bozuk WordPress, eklenti/tema JSON hatası, composer.json/lock yokluğu ve erişim hatası, kök ve public altında iki proje. Gerçek dedicated site kullanıcısı ve working directory doğrulansın. `.44` Plesk hostuna dokunma.
- [ ] Üretim React/Chromium/Firefox: mobil/masaüstü, 200% zoom, uzun envanter, 20+ kayıt sayfalama, klavye, eski Files/cron/SSL/node rotaları, bağımsız hata/yenileme ve geç gelen cevap. Kaynak testi browser render kabulü değildir.
- [ ] Aynı Unix kimliğinde release değişimi, süreçler arası kaynak kilidi ve uzun CLI sırasında canlı yetki iptali. Otomatik/manuel tekrar ve terminalden eşzamanlı işlem davranışını ayrıca sınayarak mutating UI için güvenli iş sözleşmesini tasarla.

Üst UX/PROD/RS ve Website silme/askı/backup/istatistik işleri açık kalır. Kök `plan.md` üst PHP/PROD-14 maddeleri tamamlandı sayılmadı; bu alt dilim `ui-plan.md` içinde işaretlidir. Ayrıntılı PHP sürüm/FPM düzenleme ve güvenli WordPress/Composer mutation akışları hâlâ kaynak işidir.
