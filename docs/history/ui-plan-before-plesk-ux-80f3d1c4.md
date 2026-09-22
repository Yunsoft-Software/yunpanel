# YunPanel — UI/UX Yeniden Tasarım Planı

**Tarih:** 21 Eylül 2026  
**Durum:** Yalnız plan; uygulama başlamadı.  
**İnceleme referansı:** `main` / `209cdd2c1a662c522e99ef64d29a7ce1dc334844`. Uygulamaya başlanırken güncel kaynak tekrar okunmalıdır.  
**Hedef:** Plesk'in yönetim hiyerarşisini, aaPanel'in hızlı erişimini ve CyberPanel'in site çalışma alanı yaklaşımını; YunPanel'e ait tek bir görsel dil, kaliteli mikro etkileşimler ve güvenilir işlem geri bildirimi altında birleştirmek.

> Bu belge aktif Codex çalışmasına yeni kodlama görevi vermez. Kullanıcının bu turdaki talebi yalnız `ui-plan.md` oluşturulmasıdır. `apps/`, `packages/`, `agents.md`, `plan.md`, `todo.md`, paket dosyaları ve workflow'lar bu plan commiti kapsamında değiştirilmez. UI uygulaması ayrıca başlatılana kadar [agents.md](agents.md) içindeki tasarımın ertelenmesi kararı geçerlidir.

## 1. Kapsam ve korunacak sınırlar

Bu bir tema değiştirme işi değildir. Navigasyon, bilgi yoğunluğu, form davranışları, tablolar, araç entegrasyonları, loading/empty/error durumları ve animasyonlar birlikte tasarlanacaktır. Amaç mevcut işlevleri azaltmadan paneli günlük kullanımda anlaşılır, hızlı ve tutarlı hale getirmektir.

- React + JavaScript/JSX, mevcut React Router ve Vite altyapısı korunur. TypeScript, yeni router veya komple frontend yeniden yazımı kapsam dışıdır.
- Panel yalnız kurulu olduğu sunucuyu yönetir. Tasarıma çoklu sunucu seçici, agent enrollment, reseller, hosting paketi veya faturalama ekranı eklenmez.
- Website, Domain ve Application kimlikleri birbirinin yerine kullanılamaz. Site, alt alan adı ve alias ilişkileri backend'in açık bağlarından okunur.
- AuthGate, server-derived yetkiler, Owner/salt okunur ayrımı, CSRF, site izolasyonu, secret masking, resource lock, durable job ve preview/confirmation sözleşmeleri korunur. Arayüzde kolaylık sağlamak için bu sınırlar gevşetilmez.
- elFinder, ttyd, phpMyAdmin, Roundcube, PowerDNS, Netdata, GoAccess, CrowdSec ve restic/rclone yeniden yazılmaz. YunPanel bunların etrafındaki akışı ve ortak kabuğu iyileştirir; desteklenmeyen araç için sahte çalışan ekran üretmez.
- Mevcut Passenger, PHP-FPM, Python ve Docker adapter kararları değişmez. Görsel tasarım yeni runtime motoru ekleme gerekçesi değildir.
- Özellik çalışıyor olması, UI kabulünün tamamlandığı anlamına gelmez; güzel görünen ekran da backend özelliğinin tamamlandığı anlamına gelmez.

Mimari ve ürün kapsamı için [agents.md](agents.md), [docs/architecture.md](docs/architecture.md), [plan.md](plan.md) ve [todo.md](todo.md) esas alınır. Bu belge onların yerine geçen ikinci bir backend backlog'u değildir.

## 2. Kaynak koddan görülen başlangıç noktası

Aşağıdaki bulgular kaynak incelemesidir; canlı YunPanel oturumu açılarak yapılmış görsel/usability testi değildir. İlk uygulama aşamasında gerçek ekranların tarayıcı ölçümleri alınacaktır.

| Mevcut yüzey | Kaynakta görülen durum | Tasarım karşılığı |
| --- | --- | --- |
| `WorkspaceApp.jsx` | Gerçek URL routing, Owner/salt okunur ekran ayrımı ve site sekmesi rotaları var. | Router yeniden yazılmaz; deep link ve geri/ileri davranışı korunur. |
| `WorkspaceLayout.jsx` | Sabit yan menü, mobil menü/focus yönetimi, site araması ve global iş bileşeni var. | Mevcut kabuk geliştirilir; menü grupları, site bağlamı ve kalıcı işlem merkezi eklenir. |
| Global arama | Ctrl/Cmd+K arama inputuna odaklanıyor; arama `/websites?q=...` adresine gidiyor. | Mevcut arama kaybolmadan, gerçek komut paleti ayrı ve aşamalı geliştirilir. |
| Yan menü sayacı | Web sitesi sayacı `domains` koleksiyonundan hesaplanıyor. | Bağımsız Website sayısı, hostname/domain sayısı ve alias sayısı ayrı anlamlara kavuşturulur. |
| `PanelKit.jsx` | Button, Badge, Section, EmptyState, Modal, ConfirmDialog gibi ortak bileşenler var. | İkinci, rakip bir component sistemi yerine bunlar genişletilir. |
| `workspace.css` | Mavi vurgu/koyu yan menü temeli var; incelenen kurallarda tokenlarla birlikte sabit renkler, 10–12 px küçük metinler kullanılıyor. | Semantik tokenlar, okunabilir tipografi, yoğunluk seçenekleri ve tam tema kapsamı oluşturulur. |
| `CollectionNotice` | İlk yüklemede spinner; stale durumda son başarılı veri zamanı ve yeniden deneme var. | İyi durum ayrımı korunur; şekle uygun skeleton ve sessiz arka plan yenileme eklenir. |
| `SiteDetailPage.jsx` | Breadcrumb, runtime'a göre sekmeler, bağlı kaynaklar ve recovery/isolation panelleri var. | Site workspace'i görsel olarak bütünleştirilir; teknik ayrıntılar uygun seviyeye taşınır. |
| Site URL kimliği | Route parametresinin adı `websiteId` olsa da sayfa önce `domain.id` ile arıyor, gerçek Website'ı `domain.websiteId` üzerinden buluyor. | UI yenilemesinde kimlik anlamı sessizce değiştirilmez; eski linkler için açık resolver/uyumluluk gerekir. |
| `JobDrawer.jsx` | İsmi drawer olsa da şu an Modal kullanıyor; gerçek job aşaması, teşhis ve desteklenen işlerde deploy logu gösteriliyor. | İş takibi masaüstünde engellemeyen sağ panele taşınır; mevcut observer ve sonuç doğrulaması korunur. |
| Entegre araçlar | Site dosya/terminal ekranları ve gateway bağlantıları mevcut. | Araçlara geçiş, bağlantı durumu ve hata geri dönüşü tasarlanır; yeni dosya yöneticisi veya terminal yazılmaz. |

İncelenen temel dosyalar: [WorkspaceApp](apps/web/src/workspace/WorkspaceApp.jsx), [WorkspaceLayout](apps/web/src/workspace/WorkspaceLayout.jsx), [PanelKit](apps/web/src/workspace/PanelKit.jsx), [workspace.css](apps/web/src/workspace/workspace.css), [SiteDetailPage](apps/web/src/workspace/SiteDetailPage.jsx), [JobDrawer](apps/web/src/workspace/JobDrawer.jsx), [web package.json](apps/web/package.json).

## 3. Referanslardan ne alınacak?

Rakiplerin CSS'i, ikonları, marka öğeleri veya ekranları birebir kopyalanmaz. Bir panelin sayfası aaPanel, başka sayfası Plesk gibi görünmeyecektir. Aşağıdaki aktarım kararları YunPanel için tasarım önerisidir.

| Referans | Belgelenen yaklaşım | YunPanel'e uyarlama | Alınmayacak taraf |
| --- | --- | --- | --- |
| Plesk | Power User görünümünde site yönetimi ile sunucu araçlarını birleştiriyor; hosting satışına yönelik yapıları ayrı tutuyor. [R1] | Site bağlamını koruyan yönetim; global sunucu ayarlarını günlük site işlerinden ayırma. | Reseller/abonelik karmaşıklığı; mevcut ürün kapsamı dışındaki ekranlar. |
| aaPanel | Ana sayfada kaynak kullanımı, hızlı erişim ve kurulum/işlem mesajları; site listesinde doğrudan ayar erişimi bulunuyor. [R2][R3] | Bir bakışta sağlık, kompakt ve okunabilir site listesi, sık işlemlere kısa yol, görünür iş kuyruğu. | Her satıra bütün butonları koymak; durum rozetini fark edilmeden servis kapatan kontrole dönüştürmek. |
| CyberPanel | Website Home; dosya, DNS, SSL, mail, veritabanı, yedek ve gelişmiş kontrolleri site workspace'inde topluyor. [R4] | Kullanıcıyı global ekranlara savurmayan site merkezi ve mantıksal araç grupları. | Site başlığının altında sınırsız kısayol kartı, yinelenen menüler ve gizli bağlam değişimleri. |

**Birleşik karar:** Plesk benzeri düzenli yönetim hiyerarşisi + aaPanel benzeri hızlı operasyon + CyberPanel benzeri site merkezi; fakat tek tip bileşen, ikon, renk, boşluk ve motion sistemi.

Resmî kaynaklar iş akışı referansıdır. Rakiplerin bütün animasyonları canlı demoda ölçülmüş değildir. Bu belgedeki milisaniye değerleri ve loading davranışları, onlardan alınmış ölçümler değil YunPanel için önerilen tasarım spesifikasyonudur.

## 4. Bilgi mimarisi ve navigasyon

### 4.1 Global menü

Menü aynı anda bütün teknik modülleri eşit önemde göstermez. Üç grup kullanılır:

| Grup | Girişler | Davranış |
| --- | --- | --- |
| Günlük kullanım | Web siteleri, Genel bakış | Web siteleri birincil çalışma alanı; Genel bakış sağlık ve dikkat gerektiren işler içindir. |
| Kaynaklar ve işlemler | Veritabanları, Mail, Docker, Yedekler, İşlemler | Global envanter; her kaydın bağlı olduğu site görülebilir ve oraya dönülebilir. |
| Sistem | Sunucu, Denetim, Ayarlar | Yerel sunucu yönetimi, audit ve kullanıcı/panel tercihleri. |

Global DNS/sertifika envanteri gerekiyorsa Sunucu altından açılır; günlük DNS/SSL yönetimi site içindedir. `/applications` normal ana menüye taşınmaz; tanılama/gelişmiş envanter olarak korunur. Bir modülün henüz tam ekranı yoksa çalışıyormuş gibi menü eklenmez; mevcut capability durumu açıkça gösterilir.

İlk geçişte mevcut `/dashboard` açılışı korunur. Yeni tasarım doğrulandıktan sonra varsayılan giriş Web siteleri yapılabilir; kullanıcının Genel bakış tercihi saklanabilir. Geçersiz veya yetkisiz son sayfa otomatik açılmaz.

### 4.2 Site çalışma alanı

Siteye girince başlıkta her zaman domain, gerçek Website bağlamı, runtime, yayın durumu ve SSL özeti bulunur. Alan adı seçicisi **aynı yerel sunucudaki siteler** arasında geçiştir; sunucu seçici değildir.

Ana navigasyon en fazla altı grup olarak düzenlenir:

| Grup | Alt görünümler |
| --- | --- |
| Genel bakış | Sağlık, hızlı erişim, son işlemler, dikkat gerektiren adımlar |
| Uygulama | Runtime, Git/deploy, ortam değişkenleri, desteklenen PHP/Python/Docker kontrolleri |
| Alan adları | Domain/alt alan adı/alias, DNS, SSL |
| Kaynaklar | Veritabanı, mail, dosyalar, SFTP/SSH erişimi |
| Operasyon | Loglar, cron, yedek/geri yükleme, site terminali |
| Ayarlar | Siteye ait ayarlar, izolasyon ayrıntıları, gelişmiş ve yıkıcı işlemler |

Genel bakışta Dosyalar, SSL, Veritabanı, Mail, Loglar ve Terminal için doğrudan kısa yollar bulunur. Böylece gruplama sık işlemleri fazladan tıklamaya zorlamaz. Runtime veya yetki ile ilgisiz araçlar çıkarılır; kurulabilir eksik bağımlılık ise nedeni ve gerçek kurulum yolu ile gösterilir.

### 4.3 URL ve bağlam sözleşmesi

- Mevcut `/websites`, `/websites/new`, `/websites/:websiteId/:tab?`, `/mail`, `/databases`, `/docker`, `/jobs`, `/audit`, `/servers` ve `/settings` bağlantıları kırılmaz.
- Görsel grup değişimi backend kimlik migration'ı değildir. Özellikle mevcut site route parametresinin Domain kimliği davranışı korunur veya testli bir compatibility resolver ile taşınır.
- Yeni alt görünümlerin URL eşlemesi uygulama başında gerçek `SITE_TABS` ve router ile çıkarılır. Bir URL'nin var olması o özelliğin hazır olduğu anlamına gelmez.
- Arama, filtre, sıralama ve sayfa query string'de tutulur. Geri dönüşte liste konumu mümkün olduğunca korunur. Secret, parola, token veya confirmation değeri URL'ye yazılmaz.
- Salt okunur kullanıcı yalnız izinli kaynakları görür. Arama, sayaç, kısayol ve son işlemler üzerinden gizli kaynak bilgisi sızmaz.

## 5. Görsel sistem

### 5.1 Genel görünüm

Başlangıç tasarım referansı: koyu lacivert yan menü, nötr açık içerik alanı, beyaz çalışma yüzeyleri, mevcut mavi vurgu ve ölçülü sınır/gölge kullanımı. Koyu tema aynı bileşenlerin semantik renk karşılıklarıyla üretilir; CSS filter ile ekran ters çevrilmez.

Landing-page tarzı dev başlıklar, gradient istatistik kartları, parlayan kenarlar, cam efekti, aşırı yuvarlak butonlar, dekoratif animasyonlar ve sürekli hareket eden grafikler kullanılmaz. Panel iş yapmak içindir; görsel kalite hizalama, kontrast, tipografi ve davranış tutarlılığından gelir.

### 5.2 Boyut ve yerleşim tokenları

Aşağıdaki değerler uygulama için başlangıç spesifikasyonudur; gerçek ekran ve erişilebilirlik testleriyle doğrulanacaktır.

| Token grubu | Öneri |
| --- | --- |
| Boşluk | 4, 8, 12, 16, 24, 32, 48 px; rastgele ara değerler yerine ortak ölçek |
| Yan menü | Açık 240 px, daraltılmış 72 px; küçük ekranda off-canvas |
| Üst bar | 64 px; arama, yerel host durumu, aktif işlem sayısı, hesap |
| İçerik | Standart sayfalarda mevcut 1560 px üst sınırı; editör/terminal/dosyalarda alanı kullanan geniş düzen |
| Yatay sayfa payı | Mobil 16 px, tablet 24 px, masaüstü 32 px |
| Radius | Küçük kontrol 6 px, kart 10 px, modal/drawer 14 px |
| Metin | Gövde 14–16 px; tablo 13–14 px; yardımcı metin en az 12 px; başlık 24–28 px |
| Kontrol | Standart input/buton 40 px, kompakt 36 px; dokunmatik birincil hedef 44 px |
| Tablo yoğunluğu | Rahat satır 52 px, kompakt 40 px; çok satırlı içerikte yükseklik sabitlenmez |
| Katmanlar | İçerik < sticky başlık < navigasyon < drawer < modal < toast; native dialog top-layer davranışı ayrıca test edilir |

Sayılar için tabular numerals; path, port, commit ve teknik değerlerde ölçülü monospace kullanılır. Uzun domainler tooltip'e mahkûm edilmez: açılabilir/kopyalanabilir tam değer, uygun satır kırılması ve IDN görünümü bulunur.

### 5.3 Renk ve tema

Mevcut `--ws-*` değişkenleri uyumluluk katmanı olarak korunur; yeni semantik rollerle genişletilir. `canvas`, `surface`, `surface-raised`, `text`, `text-muted`, `border`, `accent`, `focus`, `success`, `warning`, `danger`, `info` ve `unknown` ayrılır.

| Rol | Açık tema başlangıcı | Koyu tema başlangıcı |
| --- | --- | --- |
| Canvas | `#F4F6FA` | `#0F172A` |
| Surface | `#FFFFFF` | `#182235` |
| Ana metin | `#1B2940` | `#E5EDF7` |
| Yardımcı metin | `#52637A` | `#A8B7CC` |
| Vurgu | `#2E62DC` | `#8AAEFF` |
| Yan menü | `#18263C` | `#101827` |

Bunlar ölçülmüş erişilebilirlik sonucu değil tasarım adaylarıdır. Her metin/arka plan, border/focus ve disabled kombinasyonu ayrıca ölçülür. Özellikle koyu temada vurgu butonunun foreground rengi otomatik beyaz varsayılmaz.

Tema seçenekleri Sistem / Açık / Koyu; yeni kullanıcı varsayılanı Sistem. Yoğunluk Rahat / Kompakt; varsayılan Rahat. Tarayıcıda yalnız bu zararsız tercihler saklanabilir. Form verisi, kaynak envanteri, terminal içeriği ve secret'lar localStorage'a yazılmaz. Tema ilk boyamadan önce doğru uygulanır; CSP gevşetilmez. Fontlar yerel/system fallback ile çalışır, harici font servisi zorunlu olmaz.

## 6. Bileşen mimarisi ve standart davranışlar

`PanelKit.jsx` uyumlu export yüzeyi olarak korunabilir. Yeni bileşenler gerektiğinde `apps/web/src/workspace/ui/` altında ayrıştırılır; bu yol **önerilen yeni klasördür**, mevcut olduğu varsayılmaz. Domain/job iş mantığı sunum bileşenlerine taşınmaz.

| Bileşen | Sözleşme ve kabul |
| --- | --- |
| Button / AsyncButton | Normal, hover, focus, pressed, disabled, pending, success ve error; loading sırasında genişlik sabit, tekrar submit engelli. |
| StatusBadge | Renk + ikon + metin; `unknown`, `partial`, `stale`, `blocked` ayrı. Çalışıyor ile tamamlandı karışmaz. |
| PageHeader / SiteHeader | Başlık, breadcrumb, bağlam, tek birincil eylem; diğerleri ikincil/overflow. |
| ResourceBoundary | İlk yükleme, yenileme, stale, empty, hata, yetki ve eksik servis durumlarını tek sözleşmede işler. |
| Skeleton | Gerçek tablo/kart/form geometrisine uygun; ekran okuyucuya sahte içerik okutmaz. |
| DataTable | Tutarlı arama, filtre, sıralama, sayfalama, boş sonuç, seçili kayıt sayısı, satır eylemi; semantik table korunur. |
| FormField / FormSection | Label, açıklama, inline hata, required, disabled nedeni; dirty state ve focus yönetimi ortak. |
| Select / Combobox | YunPanel görsel dili, arama gerektiğinde arama, klavye ve ekran okuyucu davranışı; büyük seçenek listesi sınırlandırılır. |
| Modal / Drawer | Ortak başlık/footer, dismiss politikası, odak dönüşü; modal ile non-modal ayrımı açık. |
| ConfirmMutation | Etkilenen site/kaynak, veri kaybı, backend preview ve gerekiyorsa tam typed confirmation; genel bir “Emin misiniz?” yeterli değildir. |
| JobTimeline / OperationCenter | Mevcut `observeJob` ve `job-presentation` üstünde gerçek stage/progress/result; sayfa değişiminden bağımsız izleme. |
| ToolFrame | Entegre araç başlığı, kapsam, yüklenme/bağlanma, oturum hatası, yeniden açma ve tam ekran davranışı. |
| Toast / InlineNotice | Kısa başarı geri bildirimi toast olabilir; işlem hatası ve gerekli eylem kalıcı yüzeyde de bulunur. |
| CommandPalette | İzinli site/alan adı ve navigasyon araması; destructive komut doğrudan çalıştırmaz. |

`window.alert`, `window.confirm` ve `window.prompt` yerine panel bileşenleri kullanılır. Semantik HTML input/button/dialog kullanımı yasak değildir; erişilebilirlik sağlamak için korunur. İşlevsiz özel kontrol, çalışan native semantiğe tercih edilmez.

Tek ikon çizgisi ve boyut ölçeği kullanılır; mevcut SVG seti uygunsa genişletilir. Aynı projeye birden fazla ikon/UI kütüphanesi eklenmez. CSS transitions/animations ilk tercihtir; yalnız kanıtlanmış ihtiyaç varsa tek bir motion bağımlılığı, bundle ve bakım değerlendirmesiyle ayrıca kararlaştırılır. Bu plan dependency ekleme izni değildir.

## 7. Loading, veri tazeliği ve hata sözleşmesi

### 7.1 Ekran durumları

| Durum | Görsel davranış | Eylem |
| --- | --- | --- |
| İlk yükleme | Yerleşimi koruyan skeleton; yalnız ilgili bölüm busy | Gerekiyorsa güvenli okuma isteğini iptal etme |
| Hazır / veri var | Gerçek içerik, veri zamanı | Normal kullanım |
| Hazır / kayıt yok | Özelliğe özgü empty state | Yetkili kullanıcıya oluşturma; salt okunura açıklama |
| Filtre sonucu yok | Mevcut filtreleri açıklayan boş sonuç | Filtreleri temizle; “ilk kaydı oluştur” gösterme |
| Arka planda yenileme | Eski içerik görünür, küçük yenileniyor göstergesi | Form/scroll/selection değişmez |
| Stale / yenileme hatası | Son başarılı içerik + zaman + uyarı | Güvenli yeniden oku; riskli mutation güncel preview ister |
| İlk veri hatası | Bölüm bazlı hata ve güvenli hata kodu | Yeniden dene; tüm uygulamayı boşaltma |
| Oturum sona erdi | AuthGate akışına geçiş; korunan içeriği temizle | Yeniden giriş; eski mutation otomatik gönderilmez |
| Yetki yok | Net erişim açıklaması | İzinli sayfaya dönüş; kaynak verisi sızdırma |
| Kaynak yok | Gerçek bulunamadı durumu | Üst listeye dön |
| Servis eksik / özellik desteklenmiyor | Birbirinden ayrı açıklamalar | Yalnız gerçek kurulum/ayar yolu varsa eylem |
| Ağ yok / cevap belirsiz | Bağlantı uyarısı, iş sonucu bilinmiyor | Bağlantı sonrası önce durumu doğrula |
| Kısmi tamamlanma / müdahale gerekli | Tamamlanan ve bekleyen adımlar ayrı | Backend'in izin verdiği retry/continue/recovery |

HTTP durum kodu tek başına ürün teşhisi değildir. Örneğin 404 otomatik olarak “korumalı”, 409 otomatik olarak “başarısız kurulum”, ağ hatası otomatik olarak “iş başarısız” sayılmaz. API'nin güvenli hata kodu ve mevcut kaynak/operation durumu birlikte değerlendirilir.

### 7.2 Zamanlama kuralları

- Tıklama ve klavye geri bildirimi anında verilir. 150 ms altında biten veri okuması için loader parlatılmaz; sonuç hazırsa hemen gösterilir.
- Yaklaşık 150–200 ms sonrasında ilgili alana skeleton/spinner girer. Minimum gösterim süresi uğruna hazır sonuç geciktirilmez.
- Kısa kaydetme işleminde buton içinde spinner + eylem metni kullanılır. Ekranın tamamı kapatılmaz.
- Uzun SSL, deploy, yedek, restore veya paket işleminde HTTP kabulü yalnız “İşlem başlatıldı” demektir. Başarı, terminal job sonucu ve ilgili health/activation kanıtı geldikten sonra gösterilir.
- On saniyeyi geçen doğrulanmış işler için geçen süre, son güncelleme ve mevcut aşama gösterilir. Rastgele kalan süre veya kendiliğinden yüzde 90'a ilerleyen bar kullanılmaz.
- Backend yüzde vermiyorsa indeterminate progress ve aşama adı kullanılır. Aşama sayısı biliniyorsa “3/5 aşama” yazılabilir; bu otomatik yüzde 60 süre anlamına gelmez.
- Gözlem zaman aşımı işin bittiği anlamına gelmez. “Sonuç henüz doğrulanamadı” durumundan aynı operation kimliği yeniden okunur; kör POST tekrarı yapılmaz.

### 7.3 Yenileme ve veri kaybını önleme

Mevcut polling/observer altyapısı başlangıçta korunur; tasarım için SSE/WebSocket API'si şart koşulmaz. Sonraki optimizasyonda okuma istekleri birleştirilir, görünmeyen sayfalar azaltılır ve tekrar denemelerde backoff uygulanır. Bunlar auth/session ve gateway reauthorization zamanlayıcılarını durdurmamalıdır.

Site veya kullanıcı kapsamı değiştiğinde önceki kapsamın verisi ve formu taşınmaz. Yavaş A sitesi cevabı, B sitesi ekranını güncelleyemez; istekler abort/generation kontrolü ile korunur. Logout ve rol değişimi korunan cache'i temizler. Arka plan refresh dirty formu ezmez; çakışan revizyon varsa kullanıcıya güncel veriyle yeniden değerlendirme gösterilir.

Mutasyonlar varsayılan olarak optimistic değildir. Tema/yoğunluk gibi yerel tercihler anında değişebilir; DNS, SSL, mail, runtime, backup ve silme işlemleri doğrulanan backend sonucu bekler. Toplu işlemde başarılı ve hatalı hedefler ayrı gösterilir; tek yeşil bildirimle bütün seçim başarılı sayılmaz.

## 8. Motion ve mikro etkileşim sistemi

### 8.1 Motion tokenları

Temel süreler: `instant: 0`, `fast: 120`, `normal: 180`, `slow: 240` ms. Giriş eğrisi `cubic-bezier(0.2, 0, 0, 1)`, çıkış `cubic-bezier(0.4, 0, 1, 1)`; dönen gösterge için linear. Bunlar uygulama önerisidir.

| Etkileşim | Önerilen animasyon | Sınır / reduced-motion karşılığı |
| --- | --- | --- |
| Buton hover | 100–120 ms renk/border geçişi | Layout değişmez; focus halkası anında görünür. |
| Buton pressed | 80–100 ms, en fazla `scale(0.98)` | Tablo satırı ölçeklenmez; reduced-motion'da yalnız renk. |
| Menü/popover | 120–160 ms opacity + 4 px translate | Odak animasyon bitişini beklemez; azaltılmış harekette anında. |
| Modal | 160–200 ms opacity + 8 px dikey geçiş | Bounce/zoom yok; azaltılmış harekette fade veya anında. |
| Sağ işlem drawer'ı | 200–240 ms opacity + en fazla 24 px translate | Masaüstünde sayfayı kilitlemez; reduce durumunda kayma yok. |
| Site grup/sekme değişimi | 140–180 ms indicator ve içerik fade | Başlık, menü ve bütün sayfa tekrar animasyona girmez. |
| Domain ağacı | 120 ms chevron, 160 ms küçük alt grup açılışı | Büyük listede yükseklik animasyonu yok; focus/scroll sabit. |
| İlk skeleton | 1200–1600 ms çok düşük kontrastlı shimmer | Reduced-motion'da statik blok; offscreen durumda durur. |
| Kısa işlem spinner'ı | 800 ms sakin dönüş | Reduced-motion'da statik ikon + işlem metni. |
| Doğrulanmış başarı | 180–220 ms check/fade | Yalnız gerçek başarıda; konfeti veya büyük ekran kaplaması yok. |
| Güncellenen tek satır | En fazla 600 ms hafif arka plan vurgusu | Her polling turunda yanıp sönmez; reduce durumunda sabit durum metni. |
| Progress bar | Yeni gerçek değere 120 ms geçiş | Backend verisini uydurmaz; geri aşama geçişini gizlemez. |
| Grafik güncelleme | Yeni veriyi sakin ekleme; varsayılan count-up yok | Her refresh'te sıfırdan çizim/sıçrama yok. |
| Hata | İlgili alan border/ikon + inline açıklama | Form sallanmaz, kırmızı ekran flash'ı olmaz. |

### 8.2 Uygulama kuralları

Motion önce loading/form/tab/drawer üzerinde uygulanır; ekran açılırken her kartı sırayla uçurma yapılmaz. `transition: all`, büyük blur, sonsuz dekoratif pulse ve uzun stagger yasaktır. Öncelik transform/opacity; boyut animasyonu gerekli ve küçük değilse kullanılmaz. CSS/WAAPI ile çözülen etkileşim için ağır animasyon motoru eklenmez.

`prefers-reduced-motion` tüm ortak bileşenlerde desteklenir. Kullanıcı panel içinden hareketi daha da azaltabilir; panel tercihi OS'nin azaltılmış hareket talebini zorla geçersiz kılamaz. Bilgi ve işlem durumu hareket kapalıyken de anlaşılır kalır. İş mantığı `animationend` olayına bağlanmaz. [R6]

Native dialog açılış/kapanış yaşam döngüsü, focus/inert ve exit animasyonu birlikte test edilir; görünmez ama tıklamaları yakalayan overlay bırakılmaz. Eşzamanlı modal/drawer açılışında iki focus trap yarışmaz. Terminal/araç iframe'ine odak varken global kısayollar komutları çalmaz.

## 9. Ekran bazlı tasarım

### 9.1 Web siteleri — ana çalışma ekranı

Üstte başlık, gerçek Website sayısı, tek “Site ekle” butonu; altında arama, runtime/durum/SSL filtreleri, yoğunluk ve liste görünümü bulunur. Varsayılan, geniş ekranı verimli kullanan kompakt liste; alternatif genişletilebilir özet görünümüdür. Her site için dev bağımsız kart zorunlu değildir.

Satır: domain ve alt ilişki göstergesi; yayın durumu; runtime; SSL; ölçüm gerçekten varsa kullanım; son ilgili işlem; “Yönet” ve overflow. Dosyalar/SSL gibi güvenli kısayollar klavye odakta da erişilebilir olur. Silme/durdurma sıradan metin tıklamasına bağlanmaz.

Domain, alt alan adı ve alias aynı simge/etiketle sunulmaz. Bağımsız Website olan subdomain kendi kapsamına sahiptir; alias hedef siteye yönelir. Hiyerarşi backend referanslarından oluşturulur, string parçalayarak türetilmez. “12 site / 18 alan adı” gibi ayrı sayaçlar yalnız veri bunu doğruluyorsa kullanılır.

İlk yüklemede 6–8 temsilî satır skeleton; filtre değişiminde mevcut tablo korunur ve yenileme göstergesi çıkar. Seçim kapsamı “bu sayfadaki 25 kayıt” gibi açık yazılır; API toplu işlem desteklemiyorsa toplu destructive kontrol gösterilmez. Arama sonucundan geri dönünce filtre ve konum korunur.

**Kabul:** Bir siteyi bulup Dosyalar, SSL veya Loglar ekranına en fazla iki navigasyon eylemiyle ulaşılabilmesi; uzun domainlerde eylemlerin taşmaması; alias'ın bağımsız site sayılmaması.

### 9.2 Genel bakış — sağlık ve öncelik ekranı

İlk sıra: site/servis sağlığı, CPU, RAM ve disk özeti; mevcut veri kaynaklarıyla sınırlı. Ağ ve zaman serileri gerçekten varsa aşağıda tek odaklı grafikler. Nümerik değer bilinmiyorsa `—` ve nedeni; 0 veya dekoratif demo grafik yok.

İkinci sıra: “Dikkat gerekiyor” listesi ve aktif işlemler. SSL süresi yaklaşan site, doğrulanmış servis hatası, yedekleme problemi ayrı metinlerle gösterilir. Sağlık alarmı tıklanınca ilgili site/servisin teşhisine gider. Alt bölüm son siteler ve sık kullanılan araçlardır; pazarlama/promosyon alanı değildir.

**Kabul:** Kullanıcı ilk ekranda hangi kaynağa müdahale gerektiğini ve verinin ne zaman güncellendiğini görebilir. Bir metrik hata verdiğinde diğer kartlar boşalmaz.

### 9.3 Site genel bakışı — tek bir çalışma alanı

Sticky site başlığı: breadcrumb, domain, runtime, yayın/SSL durumları, “Siteyi aç” ve eylem menüsü. Altında altı grup navigasyonu; sayfa içeriğinde iki kolon: solda yayın ve uygulama özeti, sağda dikkat gerektiren durumlar. Sonraki sıra kısa yollar ve siteye ait son işlemler.

DB/mail/backup kaynağı mevcutsa özet ve doğrudan erişim; eksikse dürüst empty state. Website izolasyon ayrıntıları ve eski kayıt migration uyarıları yok edilmez, “Teknik ayrıntılar” altında düzenlenir. İşlem gerektiren blocker hiçbir zaman varsayılan kapalı ayrıntılara gömülmez.

**Kabul:** Her mutation ekranında hangi site ve kaynağın etkilendiği görülebilir. Site değiştirince eski form, secret ve araç oturumu yeni siteye taşınmaz.

### 9.4 Site oluşturma — önizlemeli wizard

Beş adım: **Alan adı → Runtime → Hizmetler → Önizleme → Kurulum durumu**. Küçük ekranda stepper sadeleşir; adımlar ayrı dev sayfalara dönüşmez.

Alan adı adımında bağımsız site/alt alan adı/alias ayrımı ve parent açık seçilir. Runtime adımı yalnız gerçekten desteklenen sürüm/adapter'ları gösterir. Hizmetler adımında DNS local/external, SSL, mail, veritabanı ve erişim seçenekleri anlaşılır varsayılanlarla sunulur; ileri ayrıntılar disclosure altında kalır.

Önizleme backend'in exact preview sonucudur: oluşturulacak identity, dizin/runtime, hostname, DNS, TLS, mail ve DB kapsamı gösterilir. Blocker varsa “Oluştur” kapalı ve neden görünürdür. Örneğin güncel backend local-DNS subdomain kurulumunu desteklemiyorsa UI bunu destekliyor gibi göstermeyecektir; alternatif ancak gerçek external-DNS akışı varsa sunulur.

Apply sonrası tek operation kimliğiyle adım adım ilerleme açılır. Unix identity, runtime, Nginx, seçili DNS/mail/DB/TLS ve health adımları backend'den geldiği ölçüde gösterilir. Metadata oluştu diye “Siteniz hazır” denmez. Kısmi başarısızlıkta korunmuş kaynaklar ve uygulanabilir recovery eylemi açıkça listelenir. Pencereyi kapatma veya başka sayfaya geçme sunucudaki işi iptal etmez.

**Kabul:** Back/Next formu korur; çift submit duplicate site üretmez; preview drift güncel önizleme ister; reload aynı devam eden işi bulur; unsupported seçim apply öncesi açıklanır.

### 9.5 Runtime, deploy ve ortam değişkenleri

Uygulama özeti; mevcut runtime/sürüm, çalışan release/commit, health ve son deploy sonucunu önde tutar. Node/PHP/Python/Docker kontrolleri runtime'a göre değişir; örneğin Node ayarı PHP formunda görünmez.

“Deploy et”, “Yeniden başlat” ve varsa “Geri al” etkileri ayrıdır. Commit/release seçimi ve etkilenen site onay ekranında bulunur. Deploy görünümü aşama timeline'ı, bounded canlı log ve sonucun health durumunu birlikte gösterir. Logu yukarı kaydıran kullanıcı otomatik alta çekilmez; “Canlı takibe dön” sunulur.

Environment editörü key/value satırları, masked secret, değişiklik özeti ve explicit Kaydet içerir. Saklanan secret yerine gösterilen maske gerçek değer gibi tekrar gönderilmez. Başarısız kaydetmede alanlar korunur; otomatik refresh değerleri ezmez. Geri alma, revision/digest ve mevcut backend rollback kanıtını atlamaz.

### 9.6 Domain, DNS ve SSL

Domain görünümünde ana domain/alt domain/alias ve yayın hedefi açık gösterilir. Silme işlemi bağlı kaynakları ve cascade etkisini backend preview'dan alır; “domain sil” ile “site ve tüm veriyi sil” aynı eylem değildir.

DNS görünümünde ilk kart “Yetkili DNS nerede?” sorusunu cevaplar: local PowerDNS / external provider / doğrulanamadı. Kayıt tablosu tür, ad, değer, TTL, sahiplik ve doğrulama durumunu gösterir. Managed kayıtlar açıklamalıdır; manuel kayıtların üzerine sessizce yazılmaz. Dış provider'da yapılması gereken değişiklikler kopyalanabilir requirement listesi olur; panelde kaydetmek public DNS'i değiştirmiş sayılmaz. NS/glue/delegation ve DNSSEC beklemeleri ayrı durumdur; tek sunucudaki iki NS adı iki bağımsız sunucu gibi gösterilmez.

SSL görünümünde kapsam/hostname'ler, issuer, son kullanma, yenileme durumu ve gerçek hizmete uygulanma bilgisi bulunur. Akış: Ön kontrol → Uygun challenge seçimi → Başvuru → Nginx/TLS uygulama → Doğrulama. DNS eksikliği, provider yetkisi, rate limit ve Nginx hatası farklı teşhis edilir. Her kontrol mevcut endpoint/evidence ile sınırlandırılır; UI kendi kendine “DNS doğrulandı” kararı vermez.

**Kabul:** Sertifikanın alınması ile aktif yayında kullanılması ayrıdır. Sağlıksız TLS yeşil rozet almaz. Retry yalnız backend'in uygun gördüğü koşullarda açılır; rate limitte otomatik tekrar başlatılmaz.

### 9.7 Dosyalar, SFTP ve terminal

Dosyalar sayfasında elFinder, YunPanel başlığı ve site kapsamı altında mümkün olan en geniş çalışma alanında açılır. Handoff hazırlanıyor, araç yükleniyor, oturum sona erdi, araç eksik ve erişim reddi ayrı yüzeylerdir. Iframe'in `load` olayı tek başına kimlik doğrulama veya araç hazır kanıtı değildir; gateway sözleşmesi esas alınır.

elFinder için yalnız desteklenen tema/konfigürasyon sınırlarında iyileştirme yapılır; vendor DOM'una kırılgan müdahale veya ikinci dosya editörü yoktur. Yükleme/indirme/çakışma durumları vendor yeteneğiyle uyumlu sunulur. Handoff hatasında tekrar açma yeni güvenli oturum üzerinden yapılır; token query string'e veya loga yazılmaz.

Site terminali ve Owner sunucu/root terminali görsel olarak ayrılır. Header'da host, site ve kullanıcı kapsamı sabittir. Bağlantı durumu, yeniden bağlanma ve gerçek oturum kapatma ayrı işlemlerdir. UI sekmesini değiştirmek otomatik komut tekrarına yol açmaz. Ttyd bağlantısı kapandı diye daha önce gönderilmiş komutun etkisi geri alınmış sayılmaz.

**Kabul:** Tema/yan menü değişiminde terminal gereksiz remount olmaz; kimlik/kapsam değişiminde eski oturum kapanır veya mevcut gateway politikasına göre yeniden yetkilendirilir. Root terminal sıradan site terminali gibi etiketlenmez. Terminale yazılanlar genel arama, analytics veya audit metnine kopyalanmaz.

### 9.8 Veritabanları

Global liste ile site listesi aynı tablo/oluşturma bileşenini kullanır; site bağlamı görünür ve create işleminde doğru ilişki korunur. Motor, DB adı, bağlı site, kullanıcı/izin özeti, gerçekten ölçülüyorsa boyut ve eylemler gösterilir. Canlı envanter okuması için “sunucuyu tara” işi başlatılmaz.

DB ve kullanıcı oluşturma akışı ilişkiyi açık gösterir. İzinler ve remote access gibi riskli seçenekler ileri bölümde olur. phpMyAdmin açılışı protected signon/gateway üzerinden; bağlantı hazırlanırken buton busy, hata durumunda güvenli açıklama. Dump/restore ve silme veri etkisi, doğrulanmış yedek ve typed confirmation kurallarını korur. PostgreSQL/pgAdmin yalnız gerçek backend desteği açıldığında aynı tasarıma katılır.

### 9.9 Mail ve webmail

Mail domain özeti; local/external modu, servis readiness, DNS kayıtları, TLS/webmail durumu ve posta kutularını ayrı gösterir. “Mail etkin” tek başına dışarı e-posta tesliminin kanıtı değildir. Mailbox, alias ve forwarding ayrı tablolardır; quota bilinmiyorsa sıfır çizilmez.

Mailbox oluşturma formu domaini sabit bağlamda gösterir; parola yöneticisiyle çalışır. Hata halinde secret dışındaki alanlar korunur; UI varsayılan ortak parola üretmez. Silme/disable bağımlılıkları açık önizlenir.

Roundcube `webmail.<domain>` üzerindeki ayrı mailbox girişidir. “Webmail'i aç” kullanıcıyı oraya götürür; panel Owner oturumunun otomatik posta kutusu oturumu olduğu varsayılmaz. Domain mapping/TLS hazır değilse bozuk link yerine gerçek blocker gösterilir. Mail server kurulumu ile mailbox oluşturma tek belirsiz loading'e birleştirilmez.

### 9.10 Yedekler ve geri yükleme

Özet; son doğrulanmış yedek, kaynak kapsamı, depo/hedef, saklama politikası ve aktif işler. Snapshot listesinde zaman, site/kapsam, boyut biliniyorsa boyut ve verification durumu bulunur. “Job kabul edildi” yedeğin mevcut ve kullanılabilir olduğunu göstermez.

Restore ayrı, ciddi bir akıştır: Snapshot seç → İçerik/kapsam → Etkilenecek mevcut kaynaklar → Backend preview/backup evidence → Typed confirmation → İlerleme ve doğrulama. Panel restore sırasında hangi site/hizmetlerin etkilenebileceğini gösterir; backend'in bilmediği kesin kesinti süresi uydurmaz.

Restic/rclone motorları korunur. Desteklenmeyen hedefe restore, dosya bazlı geri yükleme veya zaman çizelgesi özelliği yalnız görsel tamamlamak için eklenmez. Global `/backups` capability ekranından tam workspace'e geçiş gerçek API envanteriyle yapılır.

### 9.11 Docker, cron ve loglar

Docker: proje → servis/container hiyerarşisi; image, port, volume, health ve son işlem. Compose değişikliği için güvenli diff/preview, explicit apply; riskli volume/silme eylemi genel restart menüsüne karışmaz. Siteye bağlı proje ile global proje açık ayrılır.

Cron: ifade, okunabilir açıklama, saat dilimi, kullanıcı/site kapsamı, enabled ve gerçekten mevcutsa son/sonraki çalışma. Geçersiz ifade inline hata verir. Backend next-run bilgisi yoksa frontend sessizce kesin bir zaman uydurmaz; ayrıca hesaplanacaksa aynı timezone/parser sözleşmesi test edilir.

Loglar: kaynak/tarih/seviye filtreleri, bounded satır sayısı, pause/live takibi, arama ve güvenli kopyalama. Kaynak değişince eski log yeni başlık altında gösterilmez. GoAccess/Netdata gerekiyorsa ortak ToolFrame içinden açılır; panel kendi monitoring motorunu üretmez.

### 9.12 İşlemler, bildirimler ve denetim

Üst barda çalışan/bekleyen iş sayısı; açılınca aktif işler ve son sonuçlar. Masaüstünde sağdan açılan yaklaşık 440–480 px non-modal işlem paneli; ana ekran kullanılabilir. Dar ekranda ayrı detay sayfası veya erişilebilir tam ekran modal; kritik butonlar ekran dışına taşmaz.

Her işte insan tarafından anlaşılır eylem adı, hedef site/kaynak, durum, aşama, süre, son sinyal, log ve güvenli teşhis bulunur. Teknik job type/ID ikincil ayrıntıda kalır. Kullanıcı drawer'ı kapatınca iş backend'de devam eder; bu davranış açık yazılır. Açık panelde başka iş tamamlandı diye seçili iş değiştirilmez.

Cancel/Retry/Continue yalnız mevcut backend bu iş ve aşama için izin veriyorsa gösterilir. Mutation tekrarı yerine gerekli fresh preview alınır. İşlem merkezinin yeni backend scheduler veya bağımsız ikinci polling sistemi olması gerekmez; mevcut observer genişletilir.

Başarı toast'ı yaklaşık 4–6 saniye; hover/focus sırasında kapanma sayacı durur. Kritik hata ve müdahale gerektiren sonuç, toast kapansa da iş detayında/ilgili ekranda kalır. Aynı işin polling sonucu tekrar tekrar toast üretmez. Bildirimler ile audit ayrı amaç taşır: audit actor/action/resource/time güvenli kaydıdır; secret veya ham terminal dökümü içermez.

### 9.13 Sunucu, ayarlar, giriş ve salt okunur görünüm

Sunucu ekranı yalnız yerel host kimliğini gösterir. Servis/paket durumu, kaynak kullanımı, DNS kimliği/nameserver, desteklenen güvenlik/monitoring araçları ve Owner terminali mantıksal gruplardır. Bilinen sağlıklı, eksik, devre dışı ve bilinmeyen durumlar ayrıdır. Servis restart/update/reboot gibi etki alanı büyük işler site ayarı gibi sunulmaz.

Ayarlar: panel tercihleri, hesap/oturumlar, kullanıcılar/yetkiler ve gerçek sistem ayarları ayrı bölümlerde. Uzun formda section bazlı Kaydet; kaydedilmemiş değişiklik uyarısı. Düşük riskli tercihler ile sistem değişiklikleri aynı otomatik kaydetme modelini kullanmaz.

Giriş/ilk Owner kurulumu sade, markalı ve erişilebilirdir. Parola yöneticisi, paste, hata focus'u ve oturum sona erme dönüşü çalışır. Tasarım auth politikası değiştirmez; `.28` geliştirme hostu için mevcut isteğe bağlı MFA kararı korunur. Salt okunur kullanıcı aynı görsel kaliteyi alır; erişemediği ekranlara yönlendiren bozuk eylemler veya gizli veri sayaçları görmez.

## 10. Backend ve entegrasyon bağımlılık matrisi

Bu bölüm yeni endpoint'ler varmış gibi kod yazılmasını önler. Uygulayıcı her dilimde gerçek API yanıtını, hata kodlarını ve yetki kapsamını tekrar doğrular.

| İhtiyaç | Mevcut dayanak / kontrol | Eksikse davranış |
| --- | --- | --- |
| Site bağlamı | Domain → Website → Application açık ilişkileri; `SiteDetailPage` | Tahmin etmek yerine ilişki/legacy repair durumu gösterilir. |
| İş aşaması/yüzde | `observe-job.js`, `job-presentation.js`, gerçek job yanıtı | Aşama metni/indeterminate progress; sahte yüzde yok. |
| Tekrarlama/iptal | İlgili operation'ın mevcut lifecycle/confirmation sözleşmesi | Buton üretilmez; job türünden destek tahmin edilmez. |
| Dirty form çakışması | `UnsavedChanges` ve ilgili preview/revision/digest | Güncel veriyle yeniden önizleme; sessiz ezme yok. |
| Kaynak sayıları | Authorized koleksiyon ve gerçek entity türü | Bilinmiyorsa `—`; domain sayısı Website sayısı olmaz. |
| Arama | Mevcut izinli site/alias araması | Önce yerel navigasyon + izinli kayıtlar; yeni global search API şart değil. |
| Grafik ve kullanım | Mevcut metrik/monitoring endpoint'leri | Metrik yok durumu; demo sparkline yok. |
| Entegre araç readiness | Auth-bound gateway/handoff sözleşmesi | Iframe açılmasını başarı saymadan hata/yeniden açma akışı. |
| Webmail | Ayrı Roundcube mailbox auth + domain mapping/TLS | Owner SSO uydurulmaz. |
| Backup/cron/yeni alt görünüm | Gerçek mevcut API ve runtime desteği | Açık capability/bağımlılık; backend işini UI refactor'una gizleme yok. |

API ihtiyacı gerçekten ortaya çıkarsa normal ürün backlog'u içinde ayrı iş olarak ele alınır. UI göreviyle auth, database schema, runtime veya gateway protokolü sessizce değiştirilmez. Aktif Codex aynı kontratı değiştiriyorsa o dilim güncel kaynakla yeniden eşleştirilmeden uygulanmaz.

## 11. Responsive, erişilebilirlik ve performans

### 11.1 Responsive davranış

- 320–767 px: off-canvas global menü, tek kolon, kısa site başlığı, 44 px dokunmatik hedefler; görünür filtre özeti ve açılabilir filtre paneli.
- 768–1199 px: daraltılabilir menü, içerik gerektiğinde tek kolon; site navigasyonu erişilebilir grup seçiciye dönebilir.
- 1200 px ve üzeri: açık yan menü, iki kolonlu uygun içerikler, non-modal iş paneli. Drawer açılınca kullanılabilir genişlik yetmiyorsa içerik sıkıştırmak yerine uygun overlay/detay sayfası seçilir.
- Tablo ve terminal gibi iki boyutlu yüzeyler kendi sınırları içinde kayar; bütün sayfa istemsiz yatay kaymaz. Mobilde tabloyu anlamsız kartlara çevirmek yerine öncelikli kolonlar ve satır ayrıntısı kullanılır.
- Tarayıcı zoom, sanal klavye ve uzun hata metni altında sticky footer/başlık odaktaki alanı kapatmaz.

### 11.2 Erişilebilirlik kabulü

Hedef WCAG 2.2 AA'dır; bu belge uyumluluk sertifikası değildir. Normal metinde en az 4.5:1, büyük metin ve gerekli metin dışı kontrollerde ilgili 3:1 kontrast kuralları doğrulanır. Renk tek bilgi kanalı değildir. WCAG 2.2 AA hedef boyutu kriterinin 24 CSS px ve istisnaları vardır; YunPanel'in dokunmatik 44 px hedefi bunun üzerinde seçilmiş ürün standardıdır. [R5]

Klavye ile bütün kritik akışlar tamamlanabilir. Görünür focus, skip link, doğru label, hata ile alan ilişkisi ve uygun `aria-live`/`aria-busy` bulunur. Skeleton ekran okuyucuya satır verisi gibi okunmaz. Yüzdesi bilinmeyen progress için uydurma `aria-valuenow` verilmez. Modal focus trap/return/inert davranışı; non-modal drawer'ın ana içeriği gereksiz kilitlememesi test edilir. Tooltip tek açıklama kaynağı olmaz. Reduced-motion ve yüzde 200 metin büyütme desteklenir. [R5][R6]

### 11.3 Performans bütçesi

Uygulama başlangıcında aynı test cihazı/veri setiyle baseline alınır. Aşağıdakiler ölçülmüş mevcut değerler değil kabul hedefleridir:

| Alan | Hedef / kontrol |
| --- | --- |
| Etkileşim | Normal filtre/sekme/menü etkileşimlerinde hedef p95 görsel yanıt 200 ms altında; API bekleme süresi ayrı raporlanır. |
| Layout | Skeleton → içerik ve tema başlangıcında gözle görülür zıplama yok; layout shift tarayıcı kaydıyla kontrol edilir. |
| Animasyon | Test cihazında 60 Hz için yaklaşık 16.7 ms frame bütçesini bozan uzun motion işleri araştırılır; sürekli 60 FPS garantisi verilmez. |
| İlk yük | UI yenilemesinin initial JS/CSS gzip toplamına etkisi raporlanır; yüzde 15 üzeri büyüme gerekçelendirilmeden kabul edilmez. |
| Ağ | Baseline'a göre aynı veri için duplicate polling isteği artmaz; route/iş observer'ları paylaşılır. |
| Ağır araçlar | Terminal, dosya yöneticisi ve büyük raporlar ihtiyaç halinde yüklenir; ana ekrana bütün araç kodu taşınmaz. |
| Büyük liste | 1.000 site fixture'ında bounded render; 25/50/100 sayfa seçenekleri. API server pagination desteklemiyorsa destek varmış gibi sunulmaz. |
| Uzun oturum | Sekme değişimi, job aç/kapat ve tool reconnect döngülerinde listener/observer/timer birikmez. |

Yalnız sentetik performans skoru ile kabul verilmez; gerçek site bulma, form doldurma, log izleme ve araç kullanma akışları ölçülür. Test raporlarına secret, gerçek mailbox parolası, token veya terminal içeriği alınmaz.

## 12. Uygulama sırası ve küçük commit dilimleri

Aşamalar süre tahmini değildir. Aktif backend geliştirmesiyle sahiplik çakışması çözülmeden veya kullanıcı UI uygulamasını başlatmadan hiçbiri kodlanmaz. Her aşama bağımsız gözden geçirilebilir küçük commitlere bölünür; aynı committe paket yükseltme, backend refactor ve tasarım yapılmaz.

| Aşama | Teslim / önerilen dosya sınırı | Bağımlılık ve kabul |
| --- | --- | --- |
| UI-00 — Envanter ve baseline | Güncel router/PanelKit/ekran/API eşlemesi; gerçek tarayıcı referansları ve kabul senaryoları | Kodlamadan önce üç pilot ekran: Web siteleri, Site genel bakışı, İşlem detayı. Canlı test izni ayrıca gerekir. |
| UI-01 — Tasarım temeli | Semantik renk/spacing/type/motion tokenları; mevcut CSS ve legacy bridge uyum haritası | Açık/koyu/reduced-motion örnekleri; eski ekranlar kırılmaz. |
| UI-02 — Ortak bileşenler | PanelKit üzerinden AsyncButton, ResourceBoundary, Skeleton, form, tablo ve modal/drawer standartları | Bileşen durum matrisi ve klavye kabulü; yeni kütüphane zorunlu değil. |
| UI-03 — Kabuğun yenilenmesi | WorkspaceLayout; menü grupları, responsive header, site bağlamı ve arama | Mevcut route/read-only/auth davranışı korunur; global kısayollar araçlarla çakışmaz. |
| UI-04 — Site pilotu | WebsitesPage + SiteDetailPage/site sunum bileşenleri; liste/özet görünümü ve alt navigasyon | Domain/Website kimlikleri, filtre dönüşü, uzun domain, loading/stale/empty/error kabulü. |
| UI-05 — İşlem merkezi | JobDrawer/JobsTable/ilgili operasyon sunumları; mevcut observer korunur | Non-modal masaüstü, reload ile izleme, accepted/succeeded ayrımı, sahte yüzde/otomatik retry yok. |
| UI-06 — Kritik formlar | NewWebsitePage, SiteOperations, DnsPanel, runtime/env ve SSL yüzeyleri | Preview, double-submit, dirty form, conflict, partial/recovery ve yetki testleri. |
| UI-07 — Kaynak ekranları | Mail/DB/Docker/backup/cron, FilesPanel/TerminalPanel çevresindeki ToolFrame, loglar | Her modül ayrı commit; hazır vendor araç korunur, doğru site ve gateway kapsamı doğrulanır. |
| UI-08 — Son bütünleştirme | Dashboard, Sunucu, Ayarlar, giriş/salt okunur ekranlar; kullanılmayan stil temizliği | Responsive/a11y/performance/gateway regresyon matrisi; eski stiller ancak tüm kullanıcıları taşınınca kaldırılır. |

Örnek commit boyutu: önce yalnız token uyumluluğu; sonra bir ortak bileşen; sonra bir ekranın o bileşene taşınması. “Tüm UI modernize edildi” adlı tek dev commit yapılmaz. Import/export uyumluluğu korunarak eski ve yeni ekranlar kısa bir geçiş döneminde birlikte çalışabilir.

UI-04 sonrasında üç pilot ekran gerçek iş akışlarıyla incelenir. Sorunlu navigasyon bütün modüllere kopyalanmaz. Hızlı toparlanma için her dilimin geri alınabilirliği korunur; geri dönüş `main` geçmişini reset/force-push ederek değil ilgili commitin normal revert'üyle yapılır ve aradaki Codex değişiklikleri ayrıca gözetilir.

## 13. Test ve tamamlanma kriterleri

Aşağıdaki kutular **gelecekte yapılacak UI kabul işleridir**; mevcut backend kabulünün tamamlanma yüzdesi değildir. Bu plan commiti hiçbirini tamamlanmış saymaz.

### Görünüm ve kullanım

- [ ] Web siteleri, Site genel bakışı ve İşlem detayı aynı görsel sistemde; yalnız renk değişmiş eski ekranlar değil.
- [ ] 320, 390, 768, 1024, 1440 ve 1920 px genişliklerde kritik eylemler erişilebilir; uzun domain/path/çeviri metni düzeni bozmaz.
- [ ] Açık, koyu, sistem, rahat, kompakt ve reduced-motion kombinasyonlarının temsilî ekranları kontrol edilmiş.
- [ ] Klavye ile site bulma, SSL formu, job detayı ve modal kapatma tamamlanabiliyor; focus kaybolmuyor.
- [ ] İlk yükleme, boş veri, boş filtre sonucu, stale, forbidden, missing dependency, unsupported ve error görselleri ayrı.
- [ ] Bütün butonlar gerçek eyleme bağlı; disabled eylemin nedeni anlaşılır; tooltip veya renk tek açıklama değil.

### Akış, veri ve güvenlik

- [ ] Site değişimi/logout/rol değişimi eski kapsam verisini, formunu, secret'ını ve araç oturumunu yanlış hedefe taşımıyor.
- [ ] Arka plan refresh formu, scroll'u, seçili satırı ve log takibini bozmuyor; yavaş eski yanıt yeni siteyi ezmiyor.
- [ ] Route reload, browser back/forward, eski site deep linkleri ve Domain/Website resolver davranışı test edilmiş.
- [ ] Site create, SSL, deploy ve restore için success kadar partial/error/response-lost senaryoları da gösterilmiş.
- [ ] HTTP 202 veya kuyruğa kabul başarı sayılmıyor; gerçek yüzde yoksa determinate progress kullanılmıyor.
- [ ] 401/403/404/409/429/5xx, offline ve gecikme senaryoları doğru ayırt ediliyor; mutation kendiliğinden yeniden gönderilmiyor.
- [ ] Destructive preview/typed confirmation, stale revision ve kaynak kilidi davranışları UI yenilemesiyle atlanamıyor.
- [ ] Salt okunur kullanıcıda gizli veri/kaynak sayısı/arama sonucu sızıntısı yok; backend yetki kontrolü değişmemiş.
- [ ] phpMyAdmin/elFinder/ttyd handoff, session expiry, popup/iframe engeli ve yeniden açma davranışı doğrulanmış; Roundcube ayrı mailbox girişi korunmuş.

### Teknik kalite

- [ ] İlgili kaynak testleri ve web build yerelde çalıştırılmış; sonuç, commit ve ortam kaydedilmiş.
- [ ] Aynı cihaz/veri ile önce-sonra bundle, ağ isteği, etkileşim ve uzun oturum ölçümü yapılmış.
- [ ] Tekrarlanan overlay/focus trap, observer/timer kaçağı ve gereksiz tool remount yok.
- [ ] Son kalan legacy stil bağımlılıkları envanterden kontrol edilerek temizlenmiş; kullanılmaya devam eden sınıflar kör silinmemiş.
- [ ] Gerçek tarayıcı/gateway/host kabulü yapılamayan işler, UI uygulama aşamasında `todo.md` düzeniyle koordine edilerek takip edilmiş; yapılmış gibi raporlanmamış.

Mevcut web workspace scriptlerine göre gelecekte kullanılabilecek temel komutlar:

```sh
npm run test --workspace=@yunpanel/web
npm run build --workspace=@yunpanel/web
```

Node/npm sürümü repo şartlarına uymalıdır. Bu komutlar browser, ekran okuyucu, gateway ve gerçek sunucu kabulünün yerine geçmez. Görsel/E2E otomasyonu gerekiyorsa mevcut altyapı kontrol edilip ayrı test diliminde kurulur; projede kurulu olduğu varsayılmaz. **GitHub Actions kullanılmaz.**

## 14. Codex ile eşzamanlı çalışma protokolü

### Bu belge için

Yalnız yeni `ui-plan.md` dosyası, güncel `main` üzerine tek dosyalı içerik API'siyle eklenir. Commit öncesi hedef dosyanın bulunmadığı ve branch'in güncel durumu okunur. Başka dosyaları içeren yerel snapshot veya eski tree topluca geri yazılmaz. Commit sonrasında parent/diff kontrolüyle yalnız bu dosyanın eklendiği doğrulanır.

Eşzamanlı yazma nedeniyle conflict olursa güncel branch ve dosya yeniden okunur. Başka bir işlem aynı dosyayı oluşturmuşsa içerik körlemesine ezilmez. Yeni branch, force push, hard reset, history rewrite, otomatik merge veya Codex commitlerini geri alma yapılmaz. Tek dosya sınırı mevcut kodla çatışma riskini azaltır; gelecekte aynı dosyaya yapılacak her yazmanın çatışmasız olacağı garanti edilmez.

### UI uygulaması ayrıca başlatıldığında

Önce güncel `agents.md`, ilgili kod ve aktif değişiklikler okunur. Özellikle WorkspaceLayout, SiteDetailPage, PanelKit, API/contract dosyaları ve paket dosyaları eşzamanlı çalışma açısından sıcak alanlardır. Tasarım modeli ile backend modeli aynı dosyanın sahipliğini aynı anda almaz; bağlayıcı commit öncesi diff yeniden gözden geçirilir. Yerel commit güncel main'in gerisindeyse force push yerine iki tarafın değişikliklerini koruyan kontrollü birleştirme yapılır; çözülemeyen çakışma sessizce bir taraf seçilerek kapatılmaz.

Bu belge oluşturulurken `plan.md`, `todo.md` ve `agents.md` değiştirilmez. İleride UI gerçekten kodlanmaya başladığında normal dokümantasyon kurallarıyla ilişkilendirilir; tamamlanan işlerin kopyaları üç ayrı planda tutulmaz.

Hiçbir UI işi test/deploy bahanesiyle kapsam dışı `.44` Plesk sunucusuna erişim vermez. Bu plan hazırlığında SSH, sunucu değişikliği, live deployment veya auth politikası değişikliği yoktur.

## 15. Kapsamın büyümesini önleyen kararlar

İlk sürümün zorunlu çekirdeği: ortak tasarım sistemi, site merkezli navigasyon, kaliteli veri durumları, tutarlı formlar, güvenilir işlem merkezi ve bütün mevcut modüllerin bu sisteme taşınmasıdır.

Dashboard kişiselleştirme/drag-and-drop, yeni global search servisi, yapay zekâ asistanı, yeni monitoring motoru, vendor araçların komple reskin'i, yeni runtime ve Plesk'in bütün ticari özellikleri bu çalışmanın tamamlanma şartı değildir. Kullanıcı faydası ve mevcut kontrat kanıtlanmadan “modern görünsün” diye eklenmez.

Tasarım başarısı ekran sayısıyla değil şu sonuçla değerlendirilir: kullanıcı hangi sitede olduğunu, neyin çalıştığını, neyin beklediğini, hangi işlemin gerçekten bittiğini ve hata halinde ne yapacağını ek açıklamaya ihtiyaç duymadan anlayabilmelidir.

## 16. Kaynaklar

Erişim/inceleme tarihi: 21 Eylül 2026. Haricî kaynaklar ürün yaklaşımı ve erişilebilirlik referansıdır; piksel ölçümü, rakip animasyon benchmark'ı veya YunPanel canlı kabul kanıtı değildir.

- **[R1]** Plesk — [The Plesk GUI / Power User view](https://docs.plesk.com/en-US/obsidian/administrator-guide/about-plesk/the-plesk-gui.70562/).
- **[R2]** aaPanel — [Home: kaynak göstergeleri, tema ve işlem mesajları](https://www.aapanel.com/docs/Function/Home.html).
- **[R3]** aaPanel — [PHP Project: site listesi ve site ayarları](https://www.aapanel.com/docs/Function/php.html).
- **[R4]** CyberPanel — [How to Use Website Home](https://cyberpanel.net/KnowledgeBase/home/website-management-2/); sayfada belirtilen güncelleme 10 Ağustos 2026.
- **[R5]** W3C — [WCAG 2.2 Quick Reference](https://www.w3.org/WAI/WCAG22/quickref/).
- **[R6]** MDN — [prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion).

Repo kanıtları Bölüm 2'deki dosya bağlantıları ve inceleme referansındaki [agents.md](agents.md), [plan.md](plan.md), [todo.md](todo.md) içeriğidir. Daha sonraki commitlerde değişebilecek davranışlar uygulama öncesi yeniden doğrulanır.
