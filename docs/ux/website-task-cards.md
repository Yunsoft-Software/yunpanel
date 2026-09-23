# UX-PL-04b — Site listesinden doğrudan görevler

2026-09-23; başlangıç `development@92e12391`. Kapsam `575a102b`, hedef modeli `660e8162`, kart bağlantısı `deeb700c`. Son kullanıcı talimatı devam eder: Plesk görev yerleşimi; günlük araçlar görünür, teknik envanter ikinci planda. Kaynak eşlemesi rota matrisindeki SITE-01–08, SITE-13/14 ve atlas R02/R03/R05–10. Yeni bir Plesk sürümü veya canlı görünüm bu tur araştırılmış sayılmaz.

## Tamamlanan kaynak alt işleri

- [x] **UX-PL-04b.1:** `WebsitesPage` artık yalnız SSL/Yönet tablosu değil, doğrudan görev kartları kullanıyor. Dosya Yöneticisi, Veritabanları, SSL/TLS, DNS, Posta ve Günlükler kartta açık. Barındırma ve DNS, doğrulanmış mevcut uygulama/Git ve site genel bakışı aynı kartta. Alias/bağlı uygulama ayrıntısı açıklanabilir alanda; araçlar onun içine saklanmıyor.
- [x] **UX-PL-04b.2:** domain/Website/application tekil kimlik ve aynı sunucuyla çözülüyor. Liste artık port/hostname tahminiyle runtime seçmiyor. Stale/eksik/yanlış/duplicate ilişkide DB/mail/runtime hedefi üretilmiyor; açıklaması görünüyor. Files kaybolmuyor: güncel domain varsa mevcut SiteFilesPanel setup/unsupported açıklamasına ulaşılabiliyor. Bu katman frontend gezinme modelidir, API yetkilendirmesi değildir.
- [x] **UX-PL-04b.3:** mevcut arama/alias, durum/tür filtreleri, sıralama, parent-group sayfalama, hiyerarşi daraltma ve yoğunluk tercihleri korundu. Başlıkta Owner Site ekle; uygun Owner kartında mevcut `?parent=<DomainID>` formuna Alt alan adı ekle. Yeni kayıt yetkisi veya create motoru eklenmedi. Yenile bütün ilgili koleksiyonları yeniler; filtre temizleme ilgisiz URL parametrelerini silmez. Eski site deep linkleri korunur.
- [x] **UX-PL-04b.4:** aşağıdaki 51 seçili test geçti. CSS yalnız kart yerleşiminde mevcut Ember tokenlarını kullanıyor; dar ekranda sarma, minimum dokunma yüksekliği ve summary focus stili var. Bunlar gerçek tarayıcı kabulü değildir.
- [ ] **Üst UX-PL-04/06 kabulü:** gerçek React/Vite/HTTP/browser/host; alias düzenleme, silme/askı, gerçek hosting formu ve PHP/cron/backup/istatistik görevlerinin bütün akışları. `DomainOperations` alias düzenleme formu değildir; sahte Alias ekle düğmesi konmadı.

## Çalıştırılan kontroller

Ortam: **Node v22.16.0 / npm 10.9.2**. Terminalde GitHub DNS çözümlemesi başarısız oldu; kaynaklar bağlı GitHub aracıyla alındı. Tam checkout/bağımlılıklar kurulmadı; repo Node/npm gereksinimleri düşürülmedi.

```sh
node --test apps/web/test/website-task-model.test.js apps/web/test/website-task-runtime-label.test.js apps/web/test/website-task-cards.test.js apps/web/test/site-list-model.test.js
```

**51 geçti / 0 başarısız / 0 atlandı.** Dağılım: 32 görev hedefi/URL modeli + 1 runtime etiketi + 7 hiyerarşi/sertifika davranışı + 7 kaynak bağlantısı + mevcut 4 liste regresyonu. Son kaynak hali tekrar çalıştırıldı. Dört yeni JS kaynak/test dosyası `node --check` ile geçti. Kaynak metni kontrolleri JSX parser veya React render değildir.

GitHub `deeb700c` içindeki yedi değişen kaynak/test blob'u, yerelde sınanan dosyalarla SHA üzerinden birebir karşılaştırıldı. Kullanılan değişmemiş `domain-tree.js`, `site-list-model.js`, `site-model.js` ve mevcut `site-list-model.test.js` dosyaları da kaynak blob'larıyla eşleşiyor. Önceki 49 gezinme, Files, removal veya reseller testleri bu 51'e katılmadı ve bu tur yeniden çalıştırılmış sayılmaz.

## T-DEV-SITE-CARDS — Codex / gerçek ortam TODO

- [ ] Node >=24.11.1/npm >=11 tam checkout: `npm ci` ve `npm run check`. Yukarıdaki yeni testler, mevcut domain-tree/site-list/Files/navigation testleri birlikte geçsin. İki JSX dosyasının gerçek parser, React/Vite modül çözümleme ve production build kontrolü yapılmalı.
- [ ] Owner ve iki site hesabıyla karttan Files, SSL, DNS, Posta, DB, Günlükler, barındırma ve mevcut runtime/Git ekranlarına gidip gerçek görev yürüt. Kartta link olması, mevcut hedef aracın bütün işlevlerinin tamamlanması değildir. API/session/CSRF/tenant sınırı ayrıca sınansın.
- [ ] Tek/çok site, bağımsız ve paylaşımlı alt alan adı, 50+ grup, alias arama, üst kayıt bağlamı, durum/tür filtreleri, sıralama, sayfalama ve alt alan adı daraltma. Back/forward/reload, eski deep link ve filtre parametreleri korunsun. Tam sayfa reload'da daraltma durumunun kalıcı saklanması bu dilimin kapsamı değildir.
- [ ] Slow/stale/403/500, duplicate veya yanlış server/binding ve oturum değişimi. Diğer sitenin uygulama adı gösterilmemeli; görev yanlış Website'e gitmemeli. Files eksik/unsupported durumda görünür kalsın; mevcut açıklama/onarım yolu çalışsın. Stale sertifika bilgisi güncel yeşil durum diye gösterilmesin.
- [ ] Owner'ın yeni site/alt alan adı bağlantıları mevcut forma doğru parent ile gitsin. Site hesabında bu ekleme eylemleri görünmesin. Eski doğrudan new-site URL'sinin backend güvenliği ayrıca kontrol edilsin; bu tur route guard veya backend rol modeli değiştirilmedi.
- [ ] Chromium/Firefox, 320/390/834/1440 px ve %200 zoom, açık/koyu tema, klavye/ekran okuyucu. Kart araçları sarılmalı; kesilme/örtüşme olmamalı. Disabled görev açıklamaları, bağımsız kart adları, parent toggle ve summary focus doğrulansın. Mevcut Ember tokenları/görsel dili korunsun.
- [ ] API/web build kimliği aynı gerçek sürümde doğrulansın. Canlı dağıtım, host işlemi veya gerçek Files upload/delete testi burada yapılmadı. `.44` hiçbir amaçla kullanılmaz.

Bu liste `docs/ux/plesk-navigation-todo.md`, `docs/ux/development-todo.md` ve kök `todo.md` kabullerini tamamlar; önceki açık işler silinmez. Sonraki kaynak işi site araçlarının gerçek form/işlem/sonuç/geri dönüş akışıdır; yeni dashboard veya reseller paket motoru değildir.

## Korunan sınırlar

FilesPanel/gateway, backend API/CSRF/yetki kontrolleri, site kimlikleri, mevcut route'lar ve tema tokenları değiştirilmedi. Bu tur yalnız development'a küçük commitler gönderildi; Actions/main/deploy/canlı host işlemi yapılmadı. Kartlardan hiçbir mutation otomatik başlatılmaz. Kaynak alt işaretleri üst UX veya production kabulünü kapatmaz.
