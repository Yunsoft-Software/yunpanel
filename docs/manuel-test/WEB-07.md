# WEB-07 — Domain kartı/liste, arama, filtre ve doğru araç grupları
Sonuç: KISMİ
Ajan: AGENT_3 · Tarih: 2026-10-27 02:42 · Panel sürümü: 0.3.0 (yunpanel 0.3.0-2026101141 amd64)

## Özet
Gerçek `.28` (`https://server.cryptoraichu.website`) sunucusunda `/websites` domain kartı/ağaç listesi, arama, sıralama, görünüm tercihleri ve `/websites/<domainId>` altındaki 3 görev ailesi (`Site`, `Barındırma ve DNS`, `Posta`) tarayıcıda ve fiziksel Nginx/HTTPS üzerinde doğrulandı. Kök→alt alan adı ağacı (`11 ana alan adı · 8 alt alan adı`), arama, sıralama, yoğunluk/sayfa boyutu kalıcılığı ve rol izolasyonu çalışıyor. Ancak `Tür: Uygulama / Proxy` filtresi `targetType: "php" | "passenger"` siteleri eşleştirmediği için `0` sonuç döndürüyor, `Durum` filtresinde `Askıda` seçeneği bulunmuyor, müşteri ekranında `Veritabanları` kotası `— /` olarak boş görünüyor, statik sitede `Uygulama` (`/node`) aracı çıkıyor ve kart çekmecesindeki araçlar 3 görev grubuna ayrılmıyor.

## Senaryolar
| # | Senaryo | Rol | Adımlar | Beklenen | Gerçek | Sonuç | Kanıt |
|---|---|---|---|---|---|---|---|
| S01 | Domain kartı, kök→alt alan adı ağacı ve sayaçlar (Mutlu yol) | Owner | `/websites` açılıp sayaçlar, kart rozetleri ve `webrich.news` (`5 alt alan adı · Daralt`/`Göster`) kontrol edildi. | Sistem posta domaini gizlenmeli, `11 ana alan adı · 8 alt alan adı` ve alt ağaç daralt/göster doğru çalışmalı. | `mail.webrich.news` gizlendi, sayaç üst ve altta `11 ana alan adı · 8 alt alan adı` göründü; daraltmada 5 alt kart gizlenip toplam sayaç korundu. | GEÇTİ | `report-data.json`, `curl -skI https://webrich.news` → `200` |
| S02 | Kart aksiyon çekmecesi ve çalışma türüne göre araçlar | Owner | Statik (`webrich.news`), PHP (`yp-wp.webrich.news`) ve Node (`yp-node.webrich.news`) kartlarında `Aksiyonlar` açıldı. | Araçların çalışma türüne göre filtrelenmesi, 3 görev grubuna ayrılması ve `Terminal` içermesi. | PHP'de `PHP`+`WordPress`, Node'da `Uygulama`+`Git` ayrıştı; ancak statik sitede de `Uygulama` (`/node`) çıktı, çekmece 3 gruba ayrılmadı ve `Terminal` yok. | KISMİ | `03-s02-card-tools-php-node.png`, `14-s04-static-node-tab-bug.png` |
| S03 | Arama, durum/tür filtresi, sıralama ve görünüm tercihleri | Owner | `?q=yp-wp`, `?q=www.`, `?status=active|draft|suspended`, `?type=static|proxy`, `Z–A` ve `Kompakt`/`25` denendi. | Arama, durum/tür filtreleri, A–Z/Z–A sıralama ve görünüm tercihlerinin doğru çalışması. | Arama, `Aktif`/`Taslak`, `Statik site`, `Z–A` ve `localStorage` (`compact`/`25`) çalıştı; ancak `?type=proxy` `0` sonuç döndü ve `Askıda` filtresi yok. | KISMİ | `07-s03-filter-type-proxy-bug.png`, `report-data.json` |
| S04 | Site çalışma alanı 3 görev grubu ve kanonik URL çözümlemesi | Owner | Statik, PHP ve Node sitelerde `/websites/<id>/overview` açılıp 3 sekme ailesi, araç grupları ve `/websites/<websiteId>` yönlendirmesi denendi. | `Site`, `Barındırma ve DNS`, `Posta` sekmeleri ve 3 araç grubunun çalışma türüne göre açılması, URL'nin `domainId`'ye dönmesi. | 3 sekme ailesi, 3 araç grubu ve kanonik `domainId` yönlendirmesi çalıştı; PHP sitede `/node` → `/php`'ye döndü, statik sitede ise `/node` açık kaldı. | KISMİ | `12-s04-php-site-overview.png`, `14-s04-static-node-tab-bug.png` |
| S05 | Hatalı girdi ve sınır durumları (arama, müşteri, URL, mobil) | Owner | `?q=olmayan-xyz`, `?customer=olmayan-id`, `?type=invalid&page=999` ve `390x844`/`320x640` mobil görünüm denendi. | Eşleşmeyen aramada temizleme butonu, geçersiz müşteride fail-closed (`0` kart), bozuk parametrede güvenli sayfa ve taşmasız mobil. | Boş aramada `Filtreleri temizle`, geçersiz müşteride `0` kart + uyarı, `?page=999`'da `Sayfa 2 / 2` ve mobilde yatay taşmasız (`390/390`, `320/320`) görünüm doğrulandı. | GEÇTİ | `05-s03-search-empty.png`, `15-s05-invalid-customer-fail-closed.png` |
| S06 | Rol izolasyonu (Reseller, Customer, Site Manager, Read-Only) ve fiziksel doğrulama | Reseller, Customer, SM, RO | 4 rol hesabıyla `/websites` ve `/domains` açıldı; `.28`'de Nginx vhostları ve HTTPS cevapları kontrol edildi. | Her rol yalnız kendi kapsamını görmeli; aktif siteler Nginx/HTTPS `200` dönmeli. | İzolasyon ve HTTPS `200` (`webrich.news`, `yp-wp`, `yp-node`) doğrulandı; ancak Customer'da `Veritabanları: — /`, RO'da `mail.webrich.news` ve `/domains`'de İngilizce metinler görüldü. | KISMİ | `18-s06-customer-websites-quota-bug.png`, `20-s06-readonly-websites.png`, SSH `nginx -T` |

## Hatalar
| Sınıf | Başlık | Tekrar üretme | Bulgu görevi |
|---|---|---|---|
| NORMAL | H1 — `Tür: Uygulama / Proxy` filtresi PHP (`php`) ve Node Passenger (`passenger`) siteleri eşleştirmiyor (`0` sonuç) | `/websites` sayfasında `Tür` filtresinden `Uygulama / Proxy` (`?type=proxy`) seçildiğinde `row.domain.targetType === 'proxy'` kontrolü nedeniyle tüm PHP/Node siteler eleniyor. | — |
| NORMAL | H2 — `Durum` filtresinde `Askıda (suspended)` seçeneği bulunmuyor | `/websites` `Durum` açılır listesinde yalnız `Aktif`, `Taslak`, `Hazırlandı`, `Hata` var; `/websites?status=suspended` `all`'a düşüyor. | — |
| NORMAL | H3 — Customer `/websites` ekranında `Veritabanları` kota paydası `— /` olarak boş render ediliyor | Müşteri hesabıyla `/websites` açıldığında `WebsitesPage.jsx:103` içindeki `maxDatabases != null ?? 'Sınırsız'` ifadesi `false` ürettiği için `Veritabanları: — /` görünüyor. | — |
| NORMAL | H4 — Statik sitelerde kart çekmecesinde ve site çalışma alanında `Uygulama` (`/node`) aracı/sekmesi gösteriliyor | `webrich.news` (`application.type === 'static'`) kartında ve `/websites/09efa3a3-81ed-5764-b925-3a6770516a6f/node` adresinde `static uygulaması` ve Node/Git butonları açılıyor. | — |
| NORMAL | H5 — `WebsiteTaskCard` çekmecesinde araçlar 3 görev grubuna ayrılmıyor, kartta `Terminal` ve tüketim özeti yok | `/websites` kartında `Aksiyonlar` açıldığında araçlar düz ızgara olarak listeleniyor (`ui-plan.md` §2'deki 3 grup, `Terminal` kısayolu ve disk/trafik özeti yok). | — |
| NORMAL | H6 — `ReadOnlyWebsitesPage` sistem posta domainini (`mail.webrich.news`) gizlemiyor ve çalışma türünü yanlış etiketliyor | Read-only kullanıcıyla `/websites` açıldığında `mail.webrich.news` (`Askıda`) listeleniyor, filtreler yok ve PHP/Node siteler `Uygulama proxy · Dosya yayını` olarak yazılıyor. | — |
| NORMAL | H7 — `/domains` (`Gelişmiş alan adı araçları`) sayfası İngilizce metinler içeriyor ve mobilde `.ws-site-tool-select` gizleniyor | `/domains` açıldığında `Domain hierarchy`, `New domain`, `Stage`, `Activate` İngilizce görünüyor; `<=768px` ekranda `.ws-site-tool-select` `display: none !important` ile gizleniyor. | — |

## Mevcut testler
| Dosya | Ne ölçüyor | Çalıştırma sonucu | Sınıf | Not |
|---|---|---|---|---|
| `apps/web/test/domain-tree.test.js` | Kök→alt alan adı ağacı, daraltma, arama ve sıralama modeli | `10/10` geçti | GEÇERLİ | `domainTreeRows` ve `flattenSubdomains` mantığını doğru ölçüyor. |
| `apps/web/test/site-list-model.test.js` | `/websites` arama, durum/tür filtresi ve sayfalama modeli | `4/4` geçti | GEÇERLİ | Model fonksiyonunu ölçüyor; ancak gerçek `targetType: "php"\|"passenger"` verisini test etmiyor. |
| `apps/web/test/website-task-model.test.js` | `buildWebsiteTaskCardModel` çalışma türü, SSL ve araç modeli | `35/35` geçti | GEÇERLİ | Statik sitede `application: null` varsaydığı için `type: "static"` hatasını (H4) yakalamıyor. |
| `apps/web/test/website-task-runtime-label.test.js` | `application.type: "static"` için çalışma türü etiketi | `1/1` geçti | GEÇERLİ | Etiketin `Statik site` olduğunu doğruluyor. |
| `apps/web/test/website-preferences.test.js` | Yoğunluk ve sayfa boyutu `localStorage` kalıcılığı | `6/6` geçti | GEÇERLİ | `readWebsiteViewPreferences`/`writeWebsiteViewPreferences` doğrulaması tam. |
| `apps/web/test/site-tool-entry-model.test.js` | Araç başlatıcı (`SiteToolEntryPage`) rota ve uygunluk modeli | `31/31` geçti | GEÇERLİ | Çalışma türüne göre araç uygunluğunu doğru ölçüyor. |
| `apps/api/test/domain-hierarchy.test.js` | API domain hiyerarşisi ve ebeveyn-alt alan adı kuralları | `9/9` geçti | GEÇERLİ | Gerçek hiyerarşi doğrulamasını yapıyor. |
| `apps/api/test/domain-idn-hierarchy.test.js` | IDN/Türkçe karakterli alan adı normalizasyonu ve hiyerarşisi | `3/3` geçti | GEÇERLİ | Punycode/IDN sınır durumlarını ölçüyor. |
| `apps/api/test/website-auth-boundary.test.js` | `/api/panel/websites` ve `/domains` yetki/RBAC sınırları | `2/2` geçti | GEÇERLİ | Yetkisiz erişim sınırlarını doğruluyor. |
| `apps/web/test/scenarios-telemetry-alerts-rbac-resources.test.js` | RBAC kaynak görünürlüğü ve bildirim/telemetri senaryoları | `35/35` geçti | GEÇERLİ | Rol bazlı site/domain filtrelemesini doğruluyor. |
| `apps/web/test/scenarios-websites-nginx-jamstack.test.js` | `SCN-V3-02a/b` ve `SCN-V3-03` SSR kart ve liste filtreleme | `38/38` geçti | GEÇERLİ | `WebsiteTaskCard` SSR çıktısını ve sistem posta domaini gizlemeyi ölçüyor. |
| `apps/web/test/website-task-cards.test.js` | Kart modeli + JSX/CSS kaynak metni kontrolü | `14/14` geçti | YÜZEYSEL | 7 test model, 7 test `readFile` ile kaynak kodda string arıyor. |
| `apps/web/test/plesk-navigation.test.js` | `ux-model.js` navigasyon modeli + JSX kaynak metni | `18/18` geçti | YÜZEYSEL | `SiteDetailPage.jsx` ve `WebsitesPage.jsx` içinde `readFile` string kontrolü yapıyor. |
| `apps/web/test/centralized-design-system.test.js` | Merkezi tasarım sistemi CSS/JSX varlık kontrolü | `3/3` geçti | YÜZEYSEL | Yalnız `readFile` ile sınıf ve bileşen adı arıyor. |
| `apps/web/test/aapanel-notification-and-live-telemetry.test.js` | `/websites` ana/alt alan adı sayaç metni kontrolü | `5/5` geçti | YÜZEYSEL | `fs.readFileSync` + regex ile kaynak kodda şablon arıyor. |
| `apps/web/test/responsive-deep-links-browser-acceptance.test.js` | Derin bağlantılar için statik HTML `200` ve kaynak metni kontrolü | `11/11` geçti | YÜZEYSEL | Gerçek tarayıcı DOM'u çalıştırmadan statik HTML ve kaynak kodu okuyor. |
| `apps/web/test/reseller-customer-panel.test.js` | Reseller/Customer kota ve görünüm kontrolü | `18/18` geçti | YÜZEYSEL | `WebsitesPage.jsx` kaynağını regex ile okuduğu için H3 (`!= null ??`) hatasını kaçırıyor. |
| `apps/web/test/ux-presentation.test.js` | UI metin ve bileşen sunum kuralları | `19/19` geçti | YÜZEYSEL | Kaynak dosyalar üzerinde metin eşleşmesi yapıyor. |
| `e2e/03-website-workspace-tabs.spec.js` | `/websites` listesi ve site çalışma alanı sekmeleri (Playwright) | `0/8` geçti (`8` hata) | KIRMIZI | `e2e/helpers.js:67` eski `table.ws-table` ve `h1:has-text("Web siteleri")` seçicilerini arıyor. |
| `e2e/16-ui-preferences.spec.js` | `/websites` görünüm tercihleri ve tema kalıcılığı (Playwright) | `0/3` geçti (`3` hata) | KIRMIZI | Eski başlık/tablo seçicileri nedeniyle `/websites` yüklemesinde zaman aşımına düşüyor. |
| `e2e/12-domain-operations.spec.js` | `/domains` ağaç araması (`12.1`) ve `/websites` yönet bağlantısı (`12.4`) | `1/2` geçti (`12.1` geçti, `12.4` hata) | KIRMIZI | `12.4` eski `table.ws-table` seçicisini arıyor; `12.2`/`12.3` canlı veriyi bozmamak için koşturulmadı. |
Testi olmayan senaryolar (EKSİK): Gerçek sunucu verisinde `targetType: "php" | "passenger"` ile `Tür` filtresi doğrulaması (H1); `/websites` `Durum: Askıda (suspended)` filtresi (H2); Customer `/websites` ekranında `Veritabanları` kota paydasının DOM render kontrolü (H3); `application.type === "static"` olan sitelerde `Uygulama` (`/node`) aracının gizlenmesi (H4); `ReadOnlyWebsitesPage` filtre/etiket eşdeğerliği (H6).

## Panelde olmayan / bulunamayan
- Site kartlarında (`WebsiteTaskCard`) disk ve trafik tüketim özeti ile kart içi araç çekmecesinin 3 görev grubuna (`Genel Bakış`, `Barındırma ve DNS`, `Posta`) ayrılması (`ui-plan.md` §2).
- `/websites` `Tür` filtresinde `PHP` ve `Node.js / Passenger` çalışma türlerinin seçilebilmesi ve `Durum` filtresinde `Askıda` (`suspended`) seçeneği.
- Site kartı çekmecesinde ve Site Genel Bakış üst kısayollarında doğrudan `Terminal` bağlantısı.

## Oluşturulan ve temizlenen kaynaklar
| Kaynak | Temizlendi mi |
|---|---|
| `tweb07-a3-res-94781` (`reseller`, `de38c4e7-22df-4589-b70b-102ab6e24e33`) | Evet (`DELETE /api/auth/users/...` → `200`, listede `0` test hesabı doğrulandı) |
| `tweb07-a3-cust-94781` (`customer`, `13479a53-ca34-439f-b97d-634cb118ef02`) | Evet (`DELETE /api/auth/users/...` → `200`, listede `0` test hesabı doğrulandı) |
| `tweb07-a3-sm-94781` (`site_manager`, `bd07d6d5-9c12-4027-8f1b-6097a2e47de7`) | Evet (`DELETE /api/auth/users/...` → `200`, listede `0` test hesabı doğrulandı) |
| `tweb07-a3-ro-94781` (`read_only`, `5e3dbca8-7764-4808-8995-21fa83c07d23`) | Evet (`DELETE /api/auth/users/...` → `200`, listede `0` test hesabı doğrulandı) |
