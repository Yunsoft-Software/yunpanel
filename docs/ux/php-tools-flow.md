# PHP-UI — Site PHP / WordPress / Composer görünümü

2026-09-25 · development · başlangıç `695319c9459ef621d75ee54c0c70c29cedb3f05b`.
UX-PL-04/06/07 ve PROD-14 alt dilimi; mevcut Ember dili ve Files girişleri korunur.

## Tamamlanan kaynak dilimi

- [x] **PHP-UI-01 kaynak:** `6c212843`; mevcut PHP durum servisinde Website/sunucu/uygulama/Unix bağı, kontrol öncesi/sonrası ilişkiyi tekrar okuma, kopyalanmış bağ snapshot'ı. İki GET durum endpoint'i eski üst seviye alanlarını koruyup panel istemcisi için `data` zarfı ekler. `schemaVersion: 1`, `checks` ve `inspectedAt` ile kayıp bilgi ayrışır. Bilinmeyen `installed`/`valid` değeri artık `null`; başarısız CLI kontrolü kesin kurulu değil/geçersiz sonucu sayılmaz. Eski istemciler bu bilinmeyen değeri desteklemelidir.
- [x] **PHP-UI-01 Composer düzeltmesi:** durum kontrolü ve mevcut çalıştırma aynı proje seçicisini kullanır. Kök ve public altında iki composer.json varsa ikisi de kök projeyi seçer. Yalnız ENOENT yokluk kabul edilir; erişim hatası, symlink veya dizin şeklindeki proje dosyası başka projeye sessiz fallback üretmez. composer.lock okunamazsa yok sayılmaz.
- [x] **PHP-UI-02 istemci:** `c1fa3725`; bağımsız WordPress/Composer GET kanalları, hedef ve yanıt doğrulaması, son yanıt sırası, istek iptali, 401/403 sonrası iki kanalı temizleme. Bir araçtaki hata diğerinin başarılı sonucunu silmez. Ham CLI çıktısı veya bilinmeyen JSON alanları arayüze taşınmaz.
- [x] **PHP-UI-02 ekran:** `1e287437`; mevcut Site → Genel Bakış → Uygulama sekmesi PHP sitelerinde **PHP / WordPress** olarak etiketlenir. Aynı `/websites/:domainId/node` adresi korunur; yeni görev grubu veya paralel dashboard yoktur. WordPress/WP-CLI sürümü, eklenti/tema listeleri, bildirilen güncellemeler, Composer proje/kilit/doğrulama ve proje konumu görünür. Eklenti/tema listeleri 20 kayıtlık sayfalıdır. Ayrı Durumu kontrol et, son kontrol zamanı, eski veri/hata ve mevcut Dosyalar/terminal dönüşleri vardır. ApplicationOperations, EnvironmentPanel, Files, SSL ve cron bağlantıları korunur; global tema/CSS değiştirilmedi.
- [x] **PHP-UI-03 seçili kontrol:** aşağıdaki aynı koşuda 83 geçti / 0 başarısız / 0 atlandı. Gerçek build/browser/host kabulü açık.

## PHP-ACTION-01 — güvenli mutation sözleşmesi hazırlığı

- [x] **Sabit eylem kataloğu kaynağı:** `405d3cee`, `6a14d501`; raw komut/argüman taşımayan üç dar eylem tanımlandı: WordPress cache flush, transient temizleme ve Composer optimized dump-autoload. Önizleme Website/sunucu/application/Unix kullanıcısı + Website revizyonu + action kimliğine bağlı SHA-256 digest ve açık confirmation üretir. Önizleme nesnesinin komut/argüman/etiket/etki dahil bütün alanları yeniden hesaplanıp doğrulanmadan çalıştırma parametresi üretilemez.
- [x] **HTTP ve kapsam sertleştirmesi:** `47053dfc`, `6a02d83f`; `POST /api/websites/:websiteId/actions/preview` yalnız `actionId` kabul eder ve mevcut PHP Website bağını/revizyonunu iki kez doğrular. Eski ham `/wp-cli/run` ve `/composer/run` endpoint'leri site_manager için kapatıldı; Owner yönetim oturumu dışında 403 döner. Yeni reviewed action execution endpoint'i **bilerek eklenmedi**.
- [x] **PHP-ACTION-02a durable kaynak:** `2c9c3df8`, `130b17d1`; `website.php.action` protokol operation'ı, yalnız sabit reviewed payload, Application-scope JobRegistry kuyruğu, mevcut local executor bağlantısı ve dar terminal result sanitizer. Komut/argüman job payload'ına taşınmaz; local executor çalıştırmadan hemen önce aynı Website/application/Unix/revizyon/digest/confirmation önizlemesini yeniden okur. stdout/stderr terminal job sonucuna yazılmaz.
- [x] **PHP-ACTION-02b receipt/recovery kaynağı:** `b8ca6443`, `26962a8a`, `aa48a67d`; başarılı host sonucu completion'dan önce dar 0600 recovery receipt olarak kaydedilir. Packaged `job-recovery.mjs recover-php-tool ... --confirm` yalnız API/agent durmuşken, durable running context ile receipt birebir eşleşirse aynı job'ı succeeded olarak tamamlar. Receipt yoksa veya kimlik eşleşmezse job unresolved kalır; komut otomatik tekrar edilmez.
- [x] **PHP-ACTION-02c.1 canlı yetki ve UI kaynağı:** `8b4a1892`, `ad06f2be`, `3575d533`, `82b016a4`, `263f865c`; queue isteği gerçek panel session/user/role kimliğine bağlanır. Enqueue öncesi iki kez ve worker komutu çalıştırmadan hemen önce auth SQLite'daki canlı session + site grant yeniden okunur; oturum/rol/site üyeliği değişirse job çalışmaz. Application başına host-process lock queue hazırlığını serileştirir. Queue cevabı `jobPublicView` ile payload/actor session bilgisini tarayıcıya çıkarmaz.
- [x] **PHP-ACTION-02c.2 site akışı kaynağı:** PHP/WordPress ekranında yalnız güncel ve doğrulanmış araç için sabit eylemler görünür; preview → etkisini gör → eylem adını yazarak açık onay → durable queue → aynı job ID'yi salt GET ile takip → başarılı terminal sonuçta WordPress/Composer durumunu yenile. Başka job ID veya yabancı Application cevabı kabul edilmez. Raw `wp-cli/run` / `composer/run` site UI'sinde kullanılmaz.
- [ ] **PHP-ACTION-02c kalan çok-süreç/kabul:** kısa ömürlü Application lock iki API sürecinin eşzamanlı enqueue hazırlığını seri hale getirir; ancak mevcut JSON JobRegistry'nin bağımsız iki API sürecinde stale in-memory state davranışı tam süreçler-arası transaction değildir. Production topolojisinde tek-yazıcı varsayımını doğrula veya job deposuna gerçek ortak process lock/reload sınırı ekle. Gerçek auth/CSRF, session revoke, restart/receipt recovery, browser/host ve audit kabulü açık. Eski Owner raw endpoint'i güvenli site kullanıcı akışı sayılmaz.
- [ ] **Kaynak testi:** action/protocol/actor/lock/UI/recovery testleri ve mevcut PHP regresyonlarını Node24/npm11 tam checkout'ta çalıştır. 2026-09-25 bu turda gerçek `git clone` tekrar denendi ve `Could not resolve host: github.com` ile başarısız oldu; yeni testler yazıldı ama çalıştırıldı sayılmaz.

## Çalıştırılan kontroller ve kanıt sınırı

Node **22.16.0** / npm **10.9.2**. Beş test dosyasında **83 test**: 29 yeni servis davranışı + 5 mevcut PHP servis regresyonu + 5 gerçek servis→UI veri sözleşmesi + 37 istemci/model davranışı + 7 kaynak bağlantısı. Önceki cron turunun 83 testi bu tur yeniden koşulmadı ve bu toplama eklenmedi.

Tam checkout GitHub DNS çözümleme hatası nedeniyle alınamadı. Servis testleri gerçek kaynak modülünü yükledi; `@yunpanel/host-runtime` importu yerel, repo dışı bir loader ile yalnız hata sınıfı/default-factory kabuğuna çözüldü. **Bütün CLI/registry/lstat davranışları testte açıkça verilen fixture'lardır.** Bu kontroller gerçek WP-CLI, Composer, Express/auth veya host çalıştırması değildir. Native bağımlılık çalıştı iddiası yoktur. Depoya sahte runtime paketi veya loader eklenmedi.

Tam checkout'ta çalıştırılacak aynı test grubu:

```sh
node --test apps/api/test/website-php-tools-service.test.js apps/api/test/website-php-tools-status.test.js apps/api/test/website-php-tools-contract.test.js apps/web/test/php-tools-client.test.js apps/web/test/php-tools-wiring.test.js
```

İki JSX (`SitePhpToolsPanel`, `SiteDetailPage`) sözdizimi/dönüşüm kontrolü ve dört kaynak JS (`website-php-tools-service/http`, `php-tools-model/client`) için `node --check` geçti. JSX kontrolünde ortamın TypeScript transpiler'ı kullanıldı; uygulamaya TypeScript eklenmedi ve React render/Vite build yapılmış sayılmadı. **Altı değişmiş/yeni kaynak dosyasının Git blob'ları `1e287437` ile birebir eşleşti.**

## Ürün ve güvenlik sınırı

Bu dilim salt durum/görünüm ve mevcut servis düzeltmesidir; PHP sürümü/FPM ayar formu veya tam WordPress Toolkit değildir. Yeni Composer install/update, WordPress kur/güncelle veya genel komut çalıştırma düğmesi eklenmedi. Mevcut doğrudan run endpoint'leri Owner-only olacak şekilde daraltıldı; site hesabına açılmadı. Reviewed action önizleme/onay sözleşmesi kaynakta hazırlandı ancak durable job/kilit/restart recovery bağlanmadığı için çalıştırma endpoint'i ve UI düğmesi eklenmedi. Çağrı sonucunun bilinmemesi otomatik komut tekrarına gerekçe değildir.

Durum GET'leri de mevcut CLI üzerinden site kodu yükleyebilir; bunlar dosya yazmayacağı garanti edilen pasif filesystem okumaları değildir. Arayüz periyodik polling yapmaz. İstek iptali hosttaki CLI sürecinin durduğunu kanıtlamaz. CLI manager'ın binary keşif içi davranışı değiştirilmedi; araç tespit edilmesi çalışan site veya sağlıklı runtime kanıtı değildir.

Komut öncesi/sonrası bağ denetimi süreçler arası kilit değildir. Aynı kimlikle release/symlink değişimi ve uzun komut sırasında canlı oturum iptali ayrı kabul ister. Backend auth/CSRF ve site-resource-boundary kaldırılmadı, yeni reseller erişimi açılmadı. Veri/Unix kullanıcı/sertifika yeniden atanmadı. Bu tur test veya production sunucusuna, özellikle `.44` Plesk hostuna dokunulmadı; GitHub Actions/deploy yoktur.

## T-DEV-PHP-UI — Codex / gerçek kabul

- [ ] Node >=24.11.1/npm >=11 tam checkout ve npm ci/check/build; yukarıdaki grubu gerçek paket importlarıyla çalıştır. Bütün eski PHP HTTP/runtime/CLI ve site-route testlerini de çalıştır.
- [ ] Owner ve Site A/Site B: gerçek session/CSRF/tenant yolları, yabancı Website/application/Unix bağı, 401/403, uzun kontrol sırasında erişim iptali. Gerçek GET cevaplarının proxy ve panelRequest `data` sözleşmesi; eski ham istemcilerin nullable bilinmeyen alanlarla uyumu.
- [ ] Yalnız `.local/test-server.env` ile izinli test hedefinde WP-CLI/Composer: eksik/erişilemeyen binary, kurulu/bozuk WordPress, eklenti/tema JSON hatası, composer.json/lock yokluğu ve erişim hatası, kök ve public altında iki proje. Gerçek dedicated site kullanıcısı ve working directory doğrulansın. `.44` Plesk hostuna dokunma.
- [ ] Üretim React/Chromium/Firefox: mobil/masaüstü, 200% zoom, uzun envanter, 20+ kayıt sayfalama, klavye, eski Files/cron/SSL/node rotaları, bağımsız hata/yenileme ve geç gelen cevap. Kaynak testi browser render kabulü değildir.
- [ ] Aynı Unix kimliğinde release değişimi, süreçler arası kaynak kilidi ve uzun CLI sırasında canlı yetki iptali. Otomatik/manuel tekrar ve terminalden eşzamanlı işlem davranışını ayrıca sınayarak mutating UI için güvenli iş sözleşmesini tasarla.

Üst UX/PROD/RS ve Website silme/askı/backup/istatistik işleri açık kalır. Kök `plan.md` üst PHP/PROD-14 maddeleri tamamlandı sayılmadı; bu alt dilim `ui-plan.md` içinde işaretlidir. Ayrıntılı PHP sürüm/FPM düzenleme ve güvenli WordPress/Composer mutation akışları hâlâ kaynak işidir.
