# AI-HISTORY — Sohbet geçmişi ve bağımsız kaydırma

2026-09-24; başlangıç `development@f6df0401`. BUG-20260923-08 / UX-PL-08. Kapsam önce `6751f730` ile yazıldı. Mevcut AI sağlayıcı/tool/policy motorları, dış auth katmanı ve Ember görsel dili korunur.

## Tamamlanan kaynak

- [x] **AH-01 — `b7e9ed51`, `c1d8a2e7`, `aba5c50a`:** Liste, detay, silme ve mesaj/stream erişimi oturumun actorId'sine bağlıdır. Site hesabı ayrıca request auth içindeki Website yetkileriyle süzülür. İstemcinin actorId göndermesi kabul edilmez. Başka kullanıcıya veya kaldırılmış Website yetkisine ait konuşma bulunamadı olarak döner; provider çağrısı başlamaz. Yeni dış rol veya site-manager AI yetkisi açılmadı.
- [x] **AH-02:** Mevcut liste endpoint'i `limit`/`cursor` ile sayfa döndürür; arayüz 20 kayıt ister, API üst sınırı 50'dir. HMAC cursor kullanıcı, site filtresi ve yetki kapsamına bağlıdır. Oluşturulma zamanı + kimlik sırası kararlıdır; mesaj gelmesi eski sayfada kayıt atlatmaz. Yeni kayıtlar üsttedir. Eski limit/cursor içermeyen HTTP çağrısı kullanıcı kapsamlı dizi cevabını korur.
- [x] **AH-03 — `e2bb7949`, `6cff6023`, `f71d4068`, `058f27a6`:** Geçmiş ve aktif sohbet ayrı istemcilerdir. Kaydırma sınırında veya klavyeyle erişilen Daha eski sohbetler düğmesinde yeni sayfa eklenir. Aynı sayfa için paralel istek, yinelenen kimlik, eski yanıt, silinmiş kaydın geri gelmesi ve başarısız sayfa sonrası liste kaybı korunur. Aktif sohbet ve açık pencere içindeki konuşmaya özgü yazma taslağı sayfalama sırasında değişmez. Domain URL kimliği gerçek aynı-sunucu Website bağı üzerinden çözülür; hata genel bağlama sessiz geçiş yapmaz.
- [x] **AH-03 yerleşim:** Yalnız AI alanındaki CSS, geçmiş ve mesajlar için bağımsız sınırlandırılmış kaydırma alanları ve sabit kalan yazma alanı sağlar. Üst araçlar dar ekranda listeyi sıfır yüksekliğe indirmesin diye tek satırda toplandı. Eski scrollIntoView yerine yalnız mesaj alanının scrollTop değeri değişir. Mevcut mesaj/araç sonucu/eylem onayı kartları korunur; tema tokenları değişmedi.
- [x] **AH-04 — `52410a65`, `d3a450b8`, `562a566c`, `c8f4d22c`:** Son aynı seçili Node22 koşusu **41 geçti / 0 başarısız / 0 atlandı**. 9 backend sayfalama/kapsam, 26 frontend davranışı, 2 gerçek servis/dosya/route-modülü test grubu, 1 gerçek istemci modülü testi ve 3 kaynak bağlantısı testi. Eski `ai-conversation.test.js` dört regresyonu `39bac22f` ile auth ve gerçek UUID/Website fixture'ına uyarlandı; assert'ler korunur, bu eski grup yeniden çalıştırılmış sayılmaz.

## Veri koruma ve sürüm geçişi

Yeni konuşmalar actorId ile sürüm 2 dosyasında saklanır. Sürüm 1 okunurken sahibi bilinmeyen kayıtlar tüm mevcut alanlarıyla korunur; kullanıcıya otomatik atanmaz. İlk yazma öncesi özgün dosyanın birebir kopyası `.v1-backup` olarak yalnız yoksa oluşturulur. Önceden var olan farklı yedek üzerine yazılmaz. Yeni dosya ve yedek 0600'dür. Bozuk JSON/okuma/yazma hatası boş geçmiş veya başarı sayılmaz; yazma hatasından sonra aynı servis örneği recovery gerektirir.

Eski `.slice(-100)` ile sessiz disk budaması kaldırıldı. 100 konuşma sınırı kullanıcı başına yeni oluşturma sırasında görünür 409 üretir; eski sohbetler otomatik silinmez. Sahibi bilinmeyen eski konuşmalar yeni listede görünmez ve bunun nedeni arayüzde belirtilir. **Bunları güvenilir sahiplik kanıtıyla yeniden erişilebilir yapan açık migration hâlâ ayrı iştir.** Yedeği döndürmek tek başına eski yetkisiz erişim davranışına geri dönme izni değildir; rollback erişim sınırlarını korumalıdır.

Cursor anahtarı servis örneğinde üretilir. Restart veya başka örneğe geçişte eski cursor reddedilir, kullanıcı Geçmişi yenile ile ilk sayfadan başlar. Cursor yetki belgesi değildir. JSON yazma sıralaması aynı servis örneği içindir; süreçler arası kilit, fsync/crash dayanıklılığı ve uzun provider çalışması sırasında canlı session iptalini yeniden değerlendirme bu dilimle tamamlanmadı. Mevcut dış auth ve tool policy sınırları korunur.

Taslaklar açık AI penceresinde bellektedir; pencere kapanınca veya site/oturum değişince korunacağı söylenmez. Mesaj detayının tamamını parçalara bölme, provider streaming/reconnect ve eylem kartlarının genel lifecycle iyileştirmeleri bu geçmiş-listesi işinden ayrıdır.

## Çalıştırılan kontroller

Node **22.16.0**, npm **10.9.2**:

```sh
node --test apps/api/test/ai-conversation-history.test.js apps/api/test/ai-conversation-storage.test.js apps/web/test/ai-history.test.js apps/web/test/ai-history-wiring.test.js
```

Son koşu 41 testtir; önceki 10/37 koşuları buna eklenmez. Servis testi gerçek geçici dosyada V1 yedeği, V2 kayıt/yeniden açılış, 24 paralel oluşturma, kapasite ve bozuk dosya/yedek çakışmasını çalıştırdı. Route modülü gerçek servisle çağrıldı; provider/orchestrator, HTTP middleware ve transport sınırları açık fixture'dır. Gerçek Express listener/auth/CSRF veya dış model çalıştırılmadı. Node module-mocks bayrağı yalnız alt test süreçlerinde kullanıldı; npm komutları/paket pinleri değiştirilmedi. Kısmi yerel ağaçtaki import çözümleme placeholder'ları repoya eklenmedi.

Bir JSX dosyası (`AiDrawer.jsx`) hazır parser ile parse/transpile edildi; çıkan JS ve beş kaynak JS dosyası node --check ile geçti. Eski testin yalnız auth/Website fixture değişikliği olduğu özgün blob `c238c9c4a88524a0eaf118f7113d19e78bfcf62b` ile geri karşılaştırıldı; yeni dosyasının sözdizimi de kontrol edildi. Bu import çözümlemesi, React render veya Vite build değildir.

**Chromium 144.0.7559.96, temsilî HTML + gerçek yeni CSS:** 320×640, 390×844, 834×900, 1440×900 ve 568×320 boyutlarında 100 uzun geçmiş satırı/uzun mesajlarla bağımsız kaydırma, görünen yazma alanı ve yatay taşma kontrol edildi. Sayfa ekleme mesaj scrollTop/arka sayfa konumunu değiştirmedi. Bu beş yerleşim senaryosu Node test sayısına eklenmez ve üretim React/Ember/font kabulü değildir. İlk dar-yatay denemede sıfır geçmiş yüksekliği görüldü; araç satırı düzenlenip beş senaryo yeniden kontrol edildi.

`39bac22f` sürümündeki yedi kaynak/CSS ve beş test dosyası yerel içerikle Git blob düzeyinde eşleşti:

| Dosya | Blob |
| --- | --- |
| API ai-conversation-history.js | 952ff2fa3b01425106de0c5868b822c3d4f1ec16 |
| API ai-conversation-service.js | 48a526c8cb72cfefea85e42c3e1cf9ae95d8a503 |
| API ai-http.js | 59814186ed91d4b61f2a233705f69cc538e28178 |
| Web ai-history.js | 659223ef90f2674e524f865e9d5abb3672b765c9 |
| Web ai-client.js | 591df704fd0726486d265fc003ec92e3fa35d998 |
| Web ai-history.css | 2238c434d03e998c3a7b79c1fef2e0066abe5242 |
| Web AiDrawer.jsx | 324d8a18f4c7a5f58e23031ccacfab6708f8b1d0 |
| API ai-conversation-history.test.js | ac8cfbc4b7b5d250c570bc6b07a920b028a0539b |
| API ai-conversation-storage.test.js | 8b8427f3279bf63e0862204e4818b6e75b085d0d |
| API ai-conversation.test.js | ef2cd3c397595691be6be4355d11e0db1db64ab5 |
| Web ai-history.test.js | 3311a2ce32f3c3a70096f7fa633498ea55f0cf62 |
| Web ai-history-wiring.test.js | 8f1ed372cda5a5e02262030e9cb0a2cde81b837d |

## T-DEV-AI-HISTORY — Açık gerçek kabul

- [ ] Node24/npm11 tam checkout/npm ci/lint/test/build; yeni dört test dosyasıyla mevcut ai-conversation, ai-conversation-http, ai-http, ai-client, provider/tool/policy ve session regresyonları. Burada Git DNS çözümlemesi başarısız olduğundan tam checkout ve hedef bağımlılıklarla build yapılmadı.
- [ ] Gerçek React/SessionProvider/router ve HTTP/auth/CSRF ile iki kullanıcı ve iki Website; liste/detay/silme/mesaj/stream sınırları, doğrudan ID değiştirme, oturum ve yetki iptali. Uzun provider/tool çalışmasında canlı yetki denetimi ayrıca doğrulansın; test fixture auth nesnesi gerçek oturum deposu değildir.
- [ ] 20'den fazla konuşma, eşit zaman, eski sayfa sırasında yeni mesaj/yeni sohbet/silme; son sayfa, hata/retry, restart cursor yenileme ve birden fazla API örneği. Aktif sohbet, açık pencere taslağı ve scroll korunmalı; kayıp mutation cevabı otomatik tekrar üretilmemeli.
- [ ] Gerçek üretim React/Vite/Ember fontları ile 320/390/834/1440 px, yüzde200 zoom, kısa/yatay ekran ve mobil klavye; uzun başlık/mesaj/hata, klavye/ekran okuyucu/modal odağı, composer ve arka sayfa konumu. Temsilî HTML görüntüsü canlı ürün kanıtı değildir.
- [ ] Sahibi bilinmeyen eski kayıtların açık ve doğrulanabilir migration/rollback'i; yedeğin saklanması, dosya izinleri, süreçler arası yazma/crash kabulü. Eski kayıtları rastgele Owner'a atama veya izin kontrolünü gevşetme. Gerçek provider/tool kabulü ayrı kalır; `.44` hariç yalnız izinli test hostu.

AH kaynak alt işleri tamamlandı; üst BUG-08/UX-PL-08/production kapıları açık. Files/mail/SSL/hosting/alias motorları, main, paket/lock dosyaları değişmedi. GitHub Actions ve canlı deploy yok.
