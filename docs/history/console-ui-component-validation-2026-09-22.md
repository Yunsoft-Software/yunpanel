# YunPanel konsol düzeltmeleri — kaynak ve bileşen doğrulaması

Tarih: 22 Eylül 2026. Başlangıç: `26684d7e65e73ce998f2e0a79c6dad0e307e86cc`. Kaynak kapsamı: `0a4f663043617de8e67b6d4869d3997556a169cb`.

## Sorun ve değişiklikler

`2ca10bbedb52444e223f4f67d604ac00befaec78` veritabanı sayfasındaki arama, filtre, sayfalama, oluşturma penceresi ve eksik erişim yönlendirmelerini kaldırmış; eski teknik envanteri geri getirmişti. Bu düzeltme eski güvenlik verilerini silmeden günlük kullanım akışını geri kurar. API ve gateway yetkilendirmesine dokunulmaz.

| Commit | Kapsam |
| --- | --- |
| `b459e8d` | Veritabanı listesi, görünür phpMyAdmin/erişim kurulum eylemleri, ayrı oluşturma penceresi, kapalı teknik ayrıntılar; failed/cancelled işte formun korunması; dört regresyon testi. |
| `b3e6beb` | Konsol stilinin `main.jsx` içinde son ve tek yükleme noktası; karanlık/açık semantik yüzeyler, mobil kayıtlar, pencereler ve klavye odağı; iki yükleme-sırası testi. |
| `fdbf73b` | Gerçek oturum ölçümlerinden CPU/RAM/disk çizgileri, erişilebilir sayısal tablo, bilinmeyen veri ayrımı, sınırlı geçmiş; altı yardımcı model testi. |
| `0a4f663` | Mail listesinde arama/filtre/sayfalama; posta kutuları, webmail, alias, DNS/DKIM, yapılandırma ve loglar için ayrı bölümler. Bölüm geçişinde alt paneller mounted kalır; domain değişiminde state sıfırlanır. Üç kaynak regresyon testi. |

Veritabanı teknik alanları (Engine, DB güvenlik baseline, Admin socket auth, Website bağı, Credential ve eksik schema bağı) açılır tanılama bölümünde korunur. Kullanıcıya gösterilen metin değişti diye güvenlik kontratı kaldırılmaz; yalnız eski yerleşimi zorunlu tutan bir beklenti yüzünden yeni arayüz topluca geri alınmamalıdır.

Grafik geçmişi yalnız sayfa açıkken gelen son 60 gerçek ölçümdür. İlk okumada 24 saatlik uydurma veri yoktur. Tekrarlanan timestamp yeni ölçüm sayılmaz; eksik/invalid değerler sıfır yapılmaz ve çizgi boşlukları birleştirilmez.

## Gerçekten çalıştırılan kontroller

Yerel ortam: Node **22.16.0**, Chromium **144.0.7559.96**, Python Playwright **1.57.0**. Üretim bağımlılıkları kurulamadığı için test harness'i ortamda bulunan **React 18.2.0** ile çalıştırıldı. Repo React/Node sürümleri düşürülmedi; yeni production bağımlılığı eklenmedi.

- **34/34** çevrimdışı veritabanı/dashboard bileşen kontrolü geçti. Mevcut shell ve yeni sayfa bileşenleri tarayıcıda render edildi; router, WorkspaceContext, API ve phpMyAdmin transport mock idi. Arama, iki erişim alternatifi, iptal/başarısız/başarılı job, yenileme hatası, doğru handoff kimlikleri, native modal, Escape/odak dönüşü, mobil menü, gerçek örneklerden grafik ve sayısal tablo kontrol edildi.
- **20/20** mail üst-bileşen kontrolü geçti. Arama/mod filtreleri, tek görünür bölüm, bölüm geçişinde taslak korunması, query ile bölüm seçimi, harici sağlayıcı ayrımı ve mobil taşma kontrol edildi. Mail API'leri ve alt paneller bu testte stub idi; SMTP, Roundcube veya alt panel mutation işlevleri test edilmiş sayılmaz.
- **15/15** Node kaynak/model testi geçti: `console-database-regression.test.js`, `console-style-order.test.js`, `usage-history.test.js`, `mail-console.test.js`.
- 320, 390, 834 ve 1440 CSS px genişliklerde test edilen listeler/dashboard için sayfa taşması kontrolleri geçti. On dört örnek-verili PNG üretildi; görsellerin üstünde canlı sunucu olmadıkları yazılıdır. Bunlar image-generation taslakları değildir.
- Veritabanı, dashboard, mail, konsol CSS'i ve `main.jsx` dosyalarının yerel Git blob hash'leri GitHub'daki `0a4f663` dosyalarıyla aynı bulundu. Ekran görüntüleri başka bir tasarım dosyasından değil bu kaynakların bileşen testinden alınmıştır.

Kaynak testleri repo kökünden seçili olarak tekrar çalıştırılabilir:

```sh
node --test apps/web/test/console-database-regression.test.js apps/web/test/console-style-order.test.js apps/web/test/usage-history.test.js apps/web/test/mail-console.test.js
```

## Bu kanıtın kapsamadıkları

Tam checkout/`npm ci`, Node 24 + production React 19/Vite build, bütün monorepo testleri, production router/auth oturumu, Firefox, ekran okuyucu ve gerçek servis entegrasyonu bu ortamda çalıştırılmadı. Kullanılan JSX transpile kontrolü production build yerine geçmez. PHP signon, SMTP teslimi, DNS, site izolasyonu ve root yetkilendirme kabulü mock testle kapanmaz.

Sunucuya bağlanılmadı veya deploy yapılmadı; `.44` hosta dokunulmadı. Dolayısıyla canlı panelin güncellendiği iddia edilmez. Mevcut `plan.md` YP-15/YP-16 ve diğer uzman ekranların tüm kabul kapıları açık kalır. Docker, yeni site wizard'ı ve diğer uzman ekranların tamamı bu seriyle yeniden yazılmış değildir. Gerçek dağıtım ve kabul adımları `todo.md` T-VISUAL içindedir.
