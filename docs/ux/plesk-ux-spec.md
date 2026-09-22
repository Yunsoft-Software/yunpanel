# YunPanel — Plesk ile Eşlenmiş Kullanım Sözleşmesi

**Tarih:** 2026-09-23  
**Durum:** onaylanmış yön doğrultusunda uygulama şartnamesi; henüz kod/canlı kabul değildir.  
**Kaynak inceleme tabanı:** `80f3d1c4` (uygulama kodu), `0a84612f` (yeni açık plan).  
**Görsel dil:** mevcut YunPanel Ember; renk, font, radius ve bileşen biçimleri değişmeyecek.

Bu belge bir tema çalışması değildir. Plesk kullanıcısının bir iş için gittiği yer, gördüğü kaynak kapsamı ve işi bitirme/geri dönme biçimi YunPanel'de de karşılığını bulmalıdır. aaPanel/CyberPanel harmanı ve bağımsız icat edilmiş workspace kategorileri hedef değildir. İşlerin durumu [plan.md](../../plan.md), kaynaklar ve ekranların kökeni [atlas](plesk-reference-atlas.md), kod/rota farkları [matris](plesk-route-matrix.md), canlı kapanış [kabul listesi](plesk-browser-acceptance.md) içindedir.

## 1. Hangi Plesk görünümü?

Plesk tek, her rolde aynı menüye sahip bir ekran değildir. Resmî GUI belgesi Power User, Service Provider ve Customer Panel ayrımını yapar. YunPanel'in tek sunucu/Owner/site kullanıcısı kapsamı için **Owner = Power User görev düzeni**, **site kullanıcısı = Customer Panel'in izinli site kapsamı** seçilir. Service Provider'ın müşteri, abonelik, bayi ve satış paketi ana ekranı bu geçişin hedefi değildir. [R01]

Domain görünümünde varsayılan **genişleyen domain kartı / expanded row** yaklaşımı seçilir. Güncel Plesk belgelerindeki `Dashboard`, `Hosting & DNS`, `Mail` konumları kullanılır. Ayrı sayfa görünümü de Plesk'te vardır; iki düzenin parçaları rastgele birleştirilmez. Çok sayıda domain için arama, filtre ve görünüm tercihi aynı araçları erişilebilir tutmalıdır. [R02][R03]

![Plesk Power User görünümünün resmî, tarihsel ekranı](https://docs.plesk.com/en-US/obsidian/administrator-guide/images/75255.png)

**Şekil 1 — Bağlam referansı, yeni YunPanel tasarımı değil.** Görselde Obsidian 18.0.20 / 2019 bilgisi vardır. Global Files, domain içi File Manager ve Owner Tools & Settings ilişkisi için kullanılır; 2026 görünümünün piksel veya sürüm kanıtı değildir. Güncel görev yerleri R02–R17 ile çapraz okunur. Görsel dış kaynaktan yüklenir.

### 1.1 Birebir kullanım eşlemesinin sınırı

Desteklenen ortak işlevlerde **aynı görev yeri, aynı kaynak bağlamı, aynı işlem türü** hedeflenir. URL metninin veya Plesk'in backend'inin kopyalanması gerekmez. YunPanel'in mevcut site-başına Unix kimliği ve veri izolasyonu korunur; Plesk subscription paylaşımı uğruna kullanıcı dosyaları aynı köke taşınmaz. Mevcut SFTP'ye FTP denmez. Nginx-only yüzeyde çalışmayan Apache seçeneği üretilmez. Şu an olmayan WordPress Toolkit/Sitejet/billing gibi ürünler için boş ekran doldurulmaz; fark matriste belirtilir. Bunlar gizlenmiş işlev değil, açık kapsam farkıdır.

Kullanıcının özel talepleri de korunur: SSL iletişim inputu düzenlenebilir, retry erişilebilir, silme çalışır, AI geçmişi bağımsız sayfalıdır. Bu talepler eski Plesk ekranının farklı davranışı gerekçe gösterilerek geri alınmaz.

## 2. Değişmeyecek görünüm ve altyapı

Mevcut `workspace.css`, `ui/ux-theme.css` ve bunların token zinciri önce envanterlenir. Aktif Ember grafit/mandalina/kırık beyaz renkleri, mevcut fontlar, radius, buton/input biçimleri, açık/koyu tema ve kullanıcı tercihleri korunur. Bu tur yeni renk paleti, yeni component kütüphanesi veya yeni router seçme işi değildir. Yerleşim ve responsive ölçüler, araçları Plesk yerlerine taşımak için değişebilir; görünüm tokenı değişikliği ayrı kullanıcı kararı gerektirir.

`AuthGate`, gerçek oturum, API yetki kontrolü, CSRF, Website scope, güvenli gateway, job kilidi ve destructive onay korunur. Dosyalar/terminal/backup/DB motoru UX gerekçesiyle yeniden yazılmaz. Mevcut çalışan native fallback, hazır replacement gerçek kabulü geçmeden kaldırılmaz.

## 3. Ana kabuk ve gezinme

### 3.1 Sol menü

Aşağıdaki sıra desteklenen Plesk girişlerinin göreli sırasıdır. Kurulu olmayan katalogları taklit etmek için boş satır eklenmez. Owner ve site hesabı aynı görev isimlerini görür; içerik yalnız yetkili kapsamdır. [R01][R04]

| Menü etiketi | Ana görev | Kapsam / karar |
| --- | --- | --- |
| Web Siteleri ve Alan Adları | Domain/site kartları ve araçları | Varsayılan giriş; tüm izinli siteler |
| Posta | Mail hesapları ve domain mail ayarları | Global liste site/domain filtresiyle; site kartından aynı liste filtreli |
| Uygulamalar | Plesk'te uygulama kataloğu | YunPanel `/applications` runtime envanteri bunun karşılığı değildir; sahte katalog açılmaz |
| **Dosyalar** | Dosya yöneticisi | Kalıcı giriş; tek site varsa doğrudan, çok sitede kapsam seçimi |
| Veritabanları | DB listesi ve kullanıcılar | İzinli site DB'leri; altyapı DB'leri gösterilmez |
| İstatistikler | Site tüketimi ve web istatistikleri | Sunucu CPU grafiğiyle aynı kavram değildir |
| Araçlar ve Ayarlar | Host güvenliği, servisler, sunucu ayarları | Yalnız Owner; Plesk Tools & Settings karşılığı |
| Uzantılar / kurulu araçlar | Gerçek kurulu entegrasyonların yönetimi | Sahte mağaza yok; bir araç sırf burada var diye domain girişi kaldırılmaz |
| Kullanıcılar | Panel kullanıcıları ve roller | Owner yönetimi; site hesabına yalnız mevcut açık yetki izin verirse |
| Profilim / Hesap | Kendi parola, e-posta, oturum ve tercihleri | Panel, mailbox ve DB parolaları birbirine karıştırılmaz |

Plesk'te bir aracın hem ana menüde hem domain kartında bulunması hata değildir. **Global Dosyalar + site File Manager**, **global DB + site DB**, **global Posta + site Mail** aynı kaynağın iki kapsamlı girişidir; 'menü tekrarını azaltma' gerekçesiyle birisi silinmez.

Üst çubuk arama, kullanıcı/oturum, seçili site/kapsam ve bildirimleri taşır. YunPanel AI ayrı açık eylem olarak kalır; sohbetten komut yazmak Dosyalar menüsünün yerine geçmez. Geçerli site bağlamı varsa tekrar site seçtirilmez. Belirsiz global bağlamda rastgele ilk siteye yazma açılmaz.

### 3.2 Giriş ve geri dönüş

Yeni varsayılan başlangıç `/websites` olur. Eski `/dashboard` boşaltılmaz: var olan sağlık işlevleri uygun sunucu/genel bakış konumuna taşınıp deep link korunur. Kullanıcının geçerli son bağlamı tutulabilir; kaldırılmış/yetkisiz site otomatik seçilmez. Kullanıcı adı menüsünden profile ve çıkışa doğrudan ulaşılır. [R03]

Tarayıcı geri/ileri, reload ve kopyalanabilir URL her ekranda çalışır. Domain → SSL → geri akışı aynı domain kartına ve uygun sekmesine döner. Dosya seçimi/klasör yolu geri dönüşte mümkün olduğunca korunur; farklı siteye taşınmaz.

## 4. Web Siteleri ve Alan Adları ekranı

Üst eylemler Plesk karşılıklarıyla **Alan Adı Ekle, Alt Alan Adı Ekle, Alan Adı Takma Adı Ekle** olur. Her eylem gerçekte farklı ilişki üretir; hepsi aynı boş website formuna düşmez. Ana domain, bağımsız subdomain ve alias açıkça ayırt edilir. Mevcut Website/Domain kimlik modeli değiştirilmez. [R02]

Domain kartı başlığı alan adı, yayın durumu, gerçek document root bağlantısı, IP/runtime gibi temel bilgileri taşır. Document root bağlantısı o sitenin dosya yöneticisini ilgili klasörde açar; host dosya yolunu yetkisiz kullanıcıya vermez. Kart genişletildiğinde araçlar çalışma alanında görünür, teknik recovery paneli normal girişin tamamını işgal etmez.

### 4.1 Domain içi görev haritası

| Plesk domain konumu | YunPanel'de aynı görev yeri | Açılan iş |
| --- | --- | --- |
| Dashboard → Files / File Manager | **Dosyalar / Dosya Yöneticisi** | Site kökü, ağaç, liste ve dosya işlemleri |
| Dashboard → Databases | Veritabanları | İlgili site filtresi, DB/kullanıcı yönetimi, phpMyAdmin |
| Dashboard → SSL/TLS Certificates | SSL/TLS Sertifikaları | Gerçek sertifika, kapsam, al/yenile/yükle |
| Dashboard → PHP / Node.js / Git | İlgili gerçek runtime aracı | Runtime ayarı, environment, repo/yayın |
| Dashboard → Logs / Statistics | Günlükler / İstatistikler | İlgili site servis logu ve web kullanım raporu |
| Dashboard → Backup & Restore | Yedekleme ve Geri Yükleme | Site kapsamlı Backup Manager |
| Websites & Domains → Scheduled Tasks | Zamanlanmış Görevler | İlgili site kullanıcısının cron görevleri |
| Hosting & DNS → Hosting | Barındırma Ayarları | Document root, hosting seçimi, gerçek desteklenen ayarlar |
| Hosting & DNS → DNS | DNS | Zone/record ve local/external DNS yönetimi |
| Hosting & DNS → erişim ayarları | Barındırma Erişimi / SFTP | Gerçek site kullanıcı/kök/bağlantı bilgileri |
| Mail sekmesi | Posta hesapları ve posta ayarları | İlgili mail domain kapsamında |
| Domain eylemleri → Remove Website | Web Sitesini Sil | Bağımlılık önizlemesi ve mevcut removal lifecycle |

Bu tablo tüm kutuların her runtime'da çalıştığını söylemez. Kurulabilir araç görünür açıklama sunar; ilgisiz runtime aracı gösterilmez. Ancak **yetkili ve desteklenen Files girişinin veri yüklenirken kaybolması kabul edilmez**. Eylem yeri güncel belgede farklı görünüyorsa kaynak/atlas güncellenir; geliştirici kişisel düzen icat etmez. [R03–R13]

## 5. Dosyalar — ilk teslim ve en ayrıntılı kabul

### 5.1 Mevcut kaybolma riski

Kaynak incelemesinde `FilesPanel.jsx` hâlâ SiteDetailPage tarafından render ediliyor. Global router'da `/files` yok; ana menü modelinde Files yok. Site içi giriş `canManage`, çözülmüş Website kaydı ve static/node/php/python runtime koşullarıyla filtreleniyor. SiteNavigation'ın Files birincil sırasına koyması, üst katman bu tabı kaldırdıysa işe yaramıyor. Route parametresi `websiteId` diye adlandırılmış olsa da mevcut site URL'si Domain ID ile çözümleniyor. Bu bulgular canlı oturumun kesin kök nedenini kanıtlamaz; ilk uygulama araştırmasının açık hedefleridir. [C01–C04]

### 5.2 İki erişim yolu

**Global yol:** Sol menü → Dosyalar → gerekiyorsa izinli siteyi seç → dosya yöneticisi. Önceden geçerli site seçiliyse ara ekran yoktur. Tek izinli site doğrudan açılır. Hiç site yoksa site oluşturma bağlantılı boş durum gösterilir.

**Site yolu:** Web Siteleri ve Alan Adları → domain kartı → Dosya Yöneticisi. Domain başlığındaki document root da aynı yüzeyi doğru klasörde açar. File Manager'a erişmek için Kaynaklar → Diğer → gelişmiş araç aramak veya terminal komutu bilmek gerekmez. Plesk belgeleri hem global Files hem domain içi File Manager yolunu gösterir. [R03][R05]

![Plesk File Manager araç çubuğu ve klasör ağacı referansı](https://docs.plesk.com/en-US/obsidian/quick-start-guide/images/77081.webp)

**Şekil 2 — Plesk'in resmî File Manager görseli.** İndekslenmiş görsel önizlemesinde klasör ağacı, seçimli liste ve araç çubuğu incelendi; tam çözünürlük dosyası bu ortamda alınamadı. Yerel screenshot veya YunPanel mock'u değildir. Kaynak ve alternatif belge bağlantısı atlastadır; internet erişimi gerekir.

### 5.3 Pencere anatomisi

Sol ana menü yerinde kalır. Dosya çalışma alanının üstünde açık domain adı, **Dosyalar** başlığı, site seçici ve güncel yol bulunur. Altında işlem çubuğu vardır. Çalışma alanının solunda klasör ağacı, sağında dosya tablosu; sütunlar ad/tür/boyut/değiştirilme/izin gibi gerçek metadatalardır. Ağacın ve tablonun scroll alanı ayrı olabilir; 1000 kayıt bütün sayfayı kontrolsüz uzatmaz.

Ağaç gerçek site kapsamının kökünü gösterir. `httpdocs` Plesk örneğidir: YunPanel başka document root kullanıyorsa gerçek kök etiketi gösterilir, diskte sırf benzemek için klasör taşınmaz. Public document root ve uygulama kökü ayrıysa açık kısayollar sunulur; private alan public root diye gösterilmez.

### 5.4 İşlem çubuğu ve davranış

| İşlem | Yer / davranış | Tamamlanma koşulu |
| --- | --- | --- |
| Yükle | Üstte görünür; tek/çoklu dosya ve desteklenen klasör yükleme | Dosyalar listede gerçek sonucu ile görünür; yarım upload ayrı |
| Yeni | Üst + menüsü: dosya, klasör | İsim çakışması açıklanır; otomatik overwrite yok |
| Aç / Düzenle | Dosya adı ve satır eylemi | Metin editörü, kaydet/iptal; gerçek kullanıcı değişikliği dirty olur |
| İndir | Seçili dosyanın eylemi | Yetkili gerçek içerik; hata HTML'i dosya gibi sunulmaz |
| Kopyala / Taşı | Seçim sonrası üst araç çubuğu | Hedef klasör scope içinde; aynı ad/overwrite etki gösterir |
| Yeniden adlandır | Seçili satır eylemi | Yeni ad listede görünür; geçersiz isim/path reddedilir |
| Arşivle / Çıkart | Archive menüsü, desteklenen türler | Path traversal/symlink/zip-bomb limitleri; desteklenmeyen format açık |
| İzinler | Satır / More eylemi | Scope ve izin verilen değişiklik; geniş chmod çözümü yok |
| Sil | Seçim sonrası üst Remove ve satır eylemi | Dosya adları/adet/etki onayı; hata sonrası liste yalan söylemez |
| Ara / sırala / gizli dosyalar | Liste üst araçları | Dosya adı araması; içerik araması yalnız gerçek destek varsa |

Plesk'teki **URL'den içe aktarma**, HTML görsel editörü veya tüm arşiv biçimleri, YunPanel'de varmış sayılmaz. URL import uygulanacaksa SSRF, redirect/private-address, boyut ve timeout kontrolü ayrı backend kabulü ister. UX-PL-05 bu kapasite boşluklarını matrise işleyerek tamamlar; yalnız screenshot'a bakıp çalışan düğme koyulmaz. [R05][R06]

### 5.5 Görünürlük, yükleme ve hata

- İlk site verisi yükleniyorsa Files girişi korunur, içerikte yükleniyor durumu vardır.
- Domain→Website bağı eksikse **site bağlantısı tamamlanmamış** açıklaması ve Owner için güvenli onarım; sıradan kullanıcıya yöneticisine ileteceği hata kodu gösterilir.
- Gerçek yetki yoksa API ve UI reddeder; başka sitenin dosya adını bile açığa çıkarmaz. Read-only rolüne yeni dosya yetkisi otomatik verilmez.
- Araç servisi/gateway hazır değilse neden ve yetkiye uygun çözüm görünürdür. Sayfa 'yok' gibi davranmaz.
- Site A'dan B'ye geçildiğinde eski istek, seçim, draft ve upload A/B arasında karışmaz. Dirty taslak için açık onay gerekir.
- 409 içerik çakışmasında kullanıcının metni korunur; sessiz overwrite yapılmaz. İptal değişmemiş sayfada uyarı üretmez.

### 5.6 İlk dilimin sınırı

Önce **bulunabilir ve çalışan mevcut Files**. Aynı committe dosya motoru değiştirilmez, yetki sistemi refactor edilmez, tüm CSS yazılmaz. Global giriş + doğru resolver + görünür durumu + mevcut işlemlere regresyon tamamlandıktan sonra Plesk düzenindeki gelişmiş araç yerleşimi ilerler. Gerçek kabul: Owner ve site kullanıcısı upload → klasör → düzenle → kaydet → rename → delete → geri/reload akışını tamamlar. Süre/tıklama hedefleri YunPanel kabul ölçütüdür, ölçülmüş Plesk performansı diye sunulmaz.

## 6. Posta akışı

**Giriş:** Sol Posta veya domain Mail sekmesi. **Liste:** e-posta adresi, bağlı domain, gerçek uygulanma durumu, kota/kullanım ve açık eylemler. Domain içinden girildiyse domain filtresi hazırdır. Plesk Mail → Create Email Address yolunun karşılığı **E-posta Adresi Oluştur** olur. [R07]

**Oluştur/düzenle:** kullanıcı kısmı + domain, parola, mailbox açık/kapalı, gerçek kota; alias/yönlendirme ilgili hesap ayrıntısında. Mailbox, panel hesabı ve DB kullanıcısı farklıdır. Mevcut olmayan spam/otomatik cevap özelliği aktif gibi gösterilmez; kaynak kapasitesi doğrulanıp uygulanır.

**Kaydet sonucu:** yalnız registry kaydı yazıldıysa 'Hesap çalışıyor' denmez. Kullanıcı tek görev başlatır; gerekli mail config apply/health zinciri sunucuda yürür, UI uygulanıyor/kısmi/hata/başarılı gösterir. Teknik apply zorunluysa anlaşılır görünür eylem vardır; kullanıcı başka gizli sekmeyi tahmin etmez.

**Sil:** listede veya hesap ayrıntısında Remove; alias/forwarding ve verinin tutulması/silinmesi önizlenir. Başarı sonrasında liste, SMTP/IMAP/webmail erişimi birlikte güncellenir. Disable ile Delete ayrı görevlerdir. **Webmail aç** aynı shared Roundcube'a gider; ikinci instance kurmaz. **Bağlantı bilgileri** gerçek sunucu/port/TLS gösterir. Geri dönüş mevcut domain ve filtreyi korur. BUG-03, PROD-06/12 bu akışta kapanır.

## 7. Veritabanları ve phpMyAdmin

**Giriş:** global Veritabanları veya domain Dashboard → Veritabanları. **Liste:** DB adı, bağlı site, engine, gerçek boyut/durum, kullanıcılar; Ekle, İçe/Dışa Aktar, Kullanıcılar, phpMyAdmin, Sil. Plesk Database Servers sunucu ayarı ile müşteri DB listesi karıştırılmaz. [R08]

**Oluştur:** DB adı + desteklenen engine/server + ilişkili site + yeni/mevcut kullanıcı. Site bağlamında ilişki otomatik doludur. Credential oluşturmak ile schema oluşturmak ayrı backend işlemleriyse tek kullanıcı görevi bunu açıkça yönetir; biri tamamlanınca öteki olmuş gösterilmez.

**phpMyAdmin:** doğru site/kullanıcı oturumuyla handoff; Owner/site switch, vendor cookie ve logout sınırı korunur. Mevcut site-session binding koruması YP-04 kapanana kadar gevşetilmez. Buton çalışmıyorsa gerçek neden görünür; tüm DB aracı gizlenmez. Roundcube altyapı DB'si normal müşterinin kaynağı gibi listelenmez.

**Sil/restore:** hedef, ilgili kullanıcı/grant, uygulama etkisi ve yedek kanıtı gösterilir. Gerçek job tamamlanır, liste tazelenir; başarısız restore eski sağlıklı durumu yok saymaz. Geri aynı site filtresine döner.

## 8. SSL/TLS

**Giriş:** domain Dashboard → SSL/TLS Sertifikaları. Özet gerçek issuer, kapsam, başlangıç/bitiş, kalan süre ve canlı bağlama durumudur. Eylemler ücretsiz sertifika al, desteklenen sertifika yükle, yenile ve yenilemeyi test et; HTTPS yönlendirme desteklenen alanda ayrı ayardır. Plesk SSL It görev yeri referanstır, arkasındaki mevcut Certbot motoru korunur. [R09]

ACME e-posta inputu **işlemi yapan kullanıcının** adresiyle hazır ve düzenlenebilir olur; başka Owner/global adres sessizce geçmez. Alan aktif sertifikada da kullanıcının talebine uygun görünür; inputun değişmesi gerçekten hangi sonraki isteği etkileyecekse açıklanır. Bu UX gereksinimi shared ACME hesabının bütün domainler için e-postasını yetkisiz değiştirme izni değildir; backend scope açık tutulur.

Kapsam seçimleri www/mail/webmail/wildcard için gerçek DNS ve challenge gereksinimleriyle gösterilir. Mail olmayan domain için seçili webmail varsayımı gereksiz hataya yol açmasın. DNS-01 sağlayıcısı yokken wildcard hazır gibi sunulmaz. İstek kabulü ile sertifika yayınlanması ayrı aşamadır. Mail TLS ataması başarısızsa console'a yazıp bütün işlem başarılı gösterilmez.

Yenileme sonunda job → kayıt → ilişki → API → bütün UI ve yayındaki sertifika tutarlı olur. Dry-run/yenileme gerekmiyor/aynı sertifika/gerçek yeni sertifika ayrı sonuçtur; kalan güne uydurma süre eklenmez. Otomatik dolmuş form dirty değildir. Değişiklik yapmadan geri, uyarısız aynı domain kartına döner. BUG-04/05/06 bu akışta uygulanır.

## 9. DNS ve barındırma ayarları

**DNS:** domain → Hosting & DNS → DNS. Liste kayıt tipi/adı/değeri/TTL, Add Record, düzenle, sil; local authoritative ile external mod ayrımı görünürdür. Plesk'teki bekleyen kayıt değişikliği/uygulama aşamasının karşılığı gerektiğinde açık şerit ve Uygula'dır; gizli başka apply sayfası değildir. Server-wide DNS template ise Owner Araçlar ve Ayarlar → DNS Ayarları konumundadır. İkisi aynı form değildir. [R03][R10]

External DNS'te yerel kaydı düzenlemek sağlayıcıyı değiştirmiş gibi gösterilmez. Provider desteği varsa gerçek apply, yoksa yapılması gereken kayıt ve doğrulama sunulur. Parent delegation/DNSSEC/NS ve zone ilişkisinin güvenli backend koşulları korunur. Subdomain, parent DNS ilişkisi gerekmeden yeni zone oluşturmuş sayılmaz.

**Hosting:** domain → Hosting & DNS → Barındırma. Domain/hosting tipi, document root, gerçek runtime ve HTTPS tercihi ilgili araçlarda düzenlenir. Owner'a teknik kayıt JSON'u göstermek ayar formu sayılmaz. Suspend/resume ve Delete farklı eylemlerdir. **Erişim** ekranında site kullanıcısı, SFTP anahtarı/parola politikası ve izinli kök açıkça verilir. FTP motoru yoksa etikette SFTP yazılır; port 21 açılmaz. [R11]

## 10. Runtime, Git, günlükler ve cron

**PHP/Node.js:** domain Dashboard'daki ilgili araç açılır. Node.js ayrıntısında sürüm, application/document root, mode, startup, environment, desteklenen package manager, dependency install, script ve restart gösterilir. PHP için sürüm/handler ve izinli ayarlar kendi ekranında olur. Plesk'in Node.js görev akışı referans alınır; Passenger/site Unix kimliği korunur. Yeni Plesk sürümlerinin ek araçları mevcut YunPanel API'sinde yoksa varmış sayılmaz. [R12]

**Git:** domain Dashboard → Git → repository listesi/ayarı → kaynak, branch, deployment hedefi ve desteklenen yayın modu → pull/deploy → gerçek sonuç. `/applications` günlük yolu zorunlu değildir. Plesk remote/local repo seçeneklerinden sadece gerçek desteklenen yol açılır; mevcut olmayan push hosting servisi icat edilmez. Release/rollback mevcut backend'in açık ek kapasitesidir. [R13]

**Günlükler:** domain Dashboard → Günlükler; access/error/runtime seçimi, arama/filtre, durdur/başlat canlı akış, güvenli indirme. Site job sonucu ile HTTP access log aynı liste olarak karıştırılmaz. Bir satırdan ilgili işlem/teşhise geçilip aynı filtreye geri dönülür. Renkli terminal dump'ı tek hata açıklaması değildir.

**Zamanlanmış Görevler:** Websites & Domains içindeki ilgili görev girişi → liste → Ekle/düzenle/etkinleştir/çalıştır/sil. Schedule, timezone, site Unix kullanıcısı ve komut görünürdür; 'Şimdi çalıştır' kalıcı job ile izlenir. Plesk Command/URL/PHP çeşitlerinden mevcut motorun desteklemediği seçenek kapalı ve gerekçelidir. Site görevi Owner root cron'una dönüşmez. [R14]

Python/Docker için Plesk ortak görev alanındaki benzer bağlam kullanılır; birebir doğrulanmamış ek ekranlar **YunPanel uzantısı** olarak matrise işlenir. Host terminali Owner Araçlar ve Ayarlar'dan, site terminali sitenin erişim/terminal eyleminden açılır; kimlik/root farkı sürekli görünür.

## 11. Yedekleme, istatistikler, sunucu araçları

**Yedekleme:** domain Dashboard → Backup & Restore. Liste son başarılı tarih, kapsam, depo, boyut/sonuç; Back Up, Schedule, Remote Storage ve restore eylemleri. Site seçilmişse geri yüklemede tekrar belirsiz global seçim yoktur. İçerik/DB/mail/config kapsamı ve overwrite etkisi onaylanır. restic/rclone değiştirilmez. Owner sunucu yedeği Tools & Settings kapsamındadır; sitenin yedeğiyle aynı yetki kabul edilmez. [R03][R15]

**İstatistikler:** global İstatistikler site kapsamı seçer; domain web istatistikleri aynı rapora yönlenir. Gerçek disk/trafik/limit ile CPU/RAM host ölçümleri ayrılır. Bilinmeyen 0 değildir; 'ölçüldü', 'son kontrol' ve gerçekten enforce edilen kota farklı gösterilir. Mevcut Netdata/GoAccess kullanılır.

**Araçlar ve Ayarlar:** Plesk'in Owner konumunda kategori başlıklarıyla Güvenlik, Servisler/Sunucu Yönetimi, DNS/Mail/DB sunucu ayarları, Yedekleme/Güncelleme ve Panel ayarlarına erişilir. Firewall güvenlik bölümündedir; site WAF etiketiyle karıştırılmaz. Portun dinlemesi, firewall izni ve dışarıdan erişimi ayrı sütun/durumdur. Değişiklik etki/önizleme/onay ve yeni bağlantı teyidiyle güvenli geri alınabilir. [R16]

**Kullanıcılar/Profil:** Owner'ın kullanıcı listesi, site ilişkileri/rolü, davet/ekleme veya mevcut desteklenen hesap oluşturma, devre dışı bırakma ve güvenli silme eylemleri; kendi profilinde e-posta/parola/oturum/MFA tercihi. Mailbox parolasını değiştirirken panel parolası değişmez. Owner reset YP-11, phpMyAdmin rol sınırı YP-04 kapanış kapılarıdır. Plesk'in farklı hesap yüzeyleri aynı 'Ayarlar' formuna sıkıştırılmaz. [R01][R03]

## 12. İşlem ve form sözleşmesi

Normal görev dili: **Kaydediliyor → uygulanıyor → doğrulanıyor → tamamlandı / kısmen tamamlandı / başarısız**. Teknik job ID, revision, digest, retry-attempt tanılamada kalır. `0/3` teknik sayaç üç kez işlem yapılması gibi sunulmaz; başarısız iş `3/3 tamamlandı` rozeti almaz.

Uygun hatada Yeniden Dene görünür; kullanıcı problemi düzelttikten sonra otomatik limit doldu diye çıkışsız kalmaz. Hata sınıfı/sağlayıcı bekleme süresi ve kısmi başarı korunur. Destructive işlemi kör tekrar ettiren genel replay düğmesi yoktur. Kullanıcıya ilgili kaynak ekranı + nedeni + düzeltme + güvenli devam yolu verilir.

Kaydet/İptal yeri tutarlıdır. Form alanları hata sonrasında korunur. Otomatik doldurma dirty değildir; başlangıç baseline'ı alınır. Aktif backend işi pencere kapanınca durmaz; gerçek iptal destekleniyorsa ayrı eylemdir. Website oluşturma yönetici e-posta/parola kolonları aynı ölçü ve helper/hata alanına sahiptir.

Website silme domain kartının açık eylem menüsündedir; core File Manager bu menüye saklanmaz. Silme etki ekranı → onay → mevcut removal işi → gerçek sonuç → liste akışı vardır. Plesk'in ana subscription domainiyle ilgili kısıtları YunPanel'in bağımsız Website silmesini engelleyen yeni bir modele dönüştürülmez.

## 13. AI penceresi

YunPanel AI, panelin asıl navigasyonundan bağımsız kalır. Üstte açık sohbet eylemi; açılan alanın başlık ve yazma bölümü sabit, soldaki geçmiş ve sağdaki mesajlar bağımsız kayar. Geçmiş actor-scoped cursor ile sayfalıdır; scroll sınırında eski sayfa eklenir, konum/aktif sohbet korunur. Site değişimi veya rol iptali eski bağlamı kullanamaz. Boş, ilk yükleme, eski sayfa yükleniyor, son sayfa, retry ve gönderim hatası ayrıdır. Bu davranış BUG-08'dir; Plesk'in destek sohbetinin backend'inin kopyası değildir.

## 14. Geçiş ve kabul

Tam kabuğu silip sıfırdan yazmak yerine her araç için eski erişim → yeni erişim → aynı API → gerçek sonuç zinciri taşınır. Eski link ancak yeni yolun reload/back/forward ve role testleri geçince uyumluluk yönlendirmesine çevrilir. Route parametresi Domain ID ise yeni kod onu Website ID sanmaz; tek resolver açık bağı çözer. Sahiplik URL/metin benzerliğinden çıkarılmaz.

Her dilimin kabulü [tarayıcı listesinde](plesk-browser-acceptance.md) kayıtlıdır. İlk kapı Files, sonra domain kartı, sonra araçlar. Gerçek React/Vite build ve .28 dış kabulü yapılmadıysa yapılmış yazılmaz. Kaynakta FilesPanel bulunması, kullanıcının onu bulabildiğini kanıtlamaz; **sol Dosyalar ve domain File Manager yollarının ikisi de test edilir**.

## Kaynak anahtarı

R01–R17'nin tam resmî bağlantıları [atlasın kaynak kaydında](plesk-reference-atlas.md#resmi-kaynak-kaydi) bulunur. Önerilen YunPanel route/acceptance hedefleri tasarım kararıdır; Plesk'in iç implementasyonu hakkında iddia değildir.

C01: [WorkspaceApp](../../apps/web/src/workspace/WorkspaceApp.jsx), C02: [ux-model](../../apps/web/src/workspace/ui/ux-model.js), C03: [SiteDetailPage](../../apps/web/src/workspace/SiteDetailPage.jsx), C04: [SiteNavigation](../../apps/web/src/workspace/ui/SiteNavigation.jsx). Repo içi bağlantılar güncel kaynağa gider; bu bulguların tarihli tabanı `80f3d1c4`'tür.
