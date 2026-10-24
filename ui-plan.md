# YunPanel — Plesk UI/UX planı

24 Ekim 2026 Güncellemesi: Kullanıcı kararıyla eski Ember (bej/turuncu, 22px yuvarlak, 4 katmanlı CSS) görünümü terk edilmiştir. Yeni arayüz **Shadcn UI** tabanlı (`zinc/slate` net kontrast, `1px` keskin kenarlıklar, tek birleşik üst bar), **ufak mikro-animasyonlar ve zarif ışık/spotlight efektleriyle** modernleştirilmiş, sade ve kullanımı kolay bir tasarıma geçecektir. Ana domain ve alt alan adları (subdomain) hem arayüzde hem dosya köklerinde (`<domain-root>/subdomains/<sub-label>`) hiyerarşik ağaç yapısında sunulur. Görsel tasarım kullanıcı tarafından onaylandıktan sonra birebir kodlanır. İlgili açık işler [plan.md](plan.md), fiziksel kabul [todo.md](todo.md).

## 1. Kabuk ve gezinme

- Sol menü: Web Siteleri ve Alan Adları, Posta, Dosyalar, Veritabanları, İstatistikler. Owner: Müşteriler/Bayiler, Araçlar ve Ayarlar. Reseller: Müşterilerim/Sitelerim. Customer yalnız atanmış site araçlarını görür.
- Üstte arama, mevcut site/hesap bağlamı, işlem durumu ve profil. Tek site varsa araç doğrudan açılır; çok sitede seçili bağlam korunur ve açık seçici vardır.
- Sunucu servisleri, güvenlik, güncelleme ve global tanılama Araçlar ve Ayarlar altında; site logu ve site terminali site içinde.
- Gerçek URL, reload, geri/ileri, filtre/sayfa/scroll ve doğru dönüş. Bir araç seçimi başka sitenin kimliğine sessiz dönüşmez.
- Mobil site ekranında araç gezinmesi tek etiketli seçicidir; gruplu seçenekler aynı canonical sayfaya gider. Uzun araç listesi formu ilk ekranın dışına itmez. Masaüstünde gruplu doğrudan bağlantılar korunur. Seçici klavyeyle kullanılabilir; taslakta mevcut ayrılma koruması devrededir.
- **Bir görev, bir ekran.** Her görev tek canonical route ve ortak bileşende yaşar. Global giriş yalnız site filtresi taşır; ikinci sayfa ağacı üretmez. Link başka listeye gönderip aynı işi yeniden seçtirmez; modal içinden başka modal ve oradan başka yönetim ekranı açılmaz. Form → uygulanıyor → sonuç aynı bağlamda kalır.
- Müşteriler/Bayiler adresi sessizce Website listesine dönmez. Hesap oluşturmanın ilk alanı Müşteri/Bayi/Yönetici amacı; yeni hesap varsayılan Owner olmaz. Mevcut güvenli rol ve ilişki motorları tek kullanıcı formunda kullanılır.

## 2. Web Siteleri ve Alan Adları

Kompakt, açılır site satırı: alan adı, hosting türü, durum, SSL bitişi ve tüketim. Alt alan adı ve alias ana siteden ayırt edilir. Açılan kartta üç görev grubu:

| Grup | Kullanıcı araçları |
| --- | --- |
| Genel Bakış | Dosya Yöneticisi, Veritabanları, SSL/TLS, PHP veya Node.js, Git, Günlükler, İstatistikler, Yedekleme ve Geri Yükleme |
| Barındırma ve DNS | Barındırma, DNS, alt alan adı, alias, yönlendirmeler, erişim hesapları, zamanlanmış görevler, site terminali |
| Posta | Posta hesapları, alias/forward, kota, webmail, istemci ayarları |

Temel araca karttan tek tık. Araç ekranında kalıcı domain başlığı ve tek breadcrumb; aynı aracın ayrı site/global tasarımı olmaz. Uzun domainler okunur; normal sayfa teknik kimlik tablosuna dönüşmez. Backup mevcut özel gruptan Plesk'in Genel Bakış görev yerine alınır; eski URL çalışır.

## 3. Veritabanları

- Site içinde Veritabanı ekle: ad, yeni/mevcut kullanıcı, parola; gelişmişte kullanıcı hakları ve izinli erişim. Global girişte site seçimi aynı formun ilk alanıdır.
- Tek Oluştur eylemi schema, site bağı ve gerçek grant'i tamamlar. Ayrı binding/credential/apply ekranları kullanıcı işi değildir.
- Sonuç satırı: ad, site, kullanıcı, boyut; phpMyAdmin, Bağlantı bilgileri ve işlem menüsü.
- Bağlantı penceresi: host/port/ad/kullanıcı, açık yetkiyle geçici parola yönetimi, kopyalanabilir uygulama örneği. Güvenli parola saklama devam eder.
- Kullanıcı ekle/düzenle/parola/haklar; SQL içe/dışa aktarma, kopyalama, onarım ve yedek/restore mevcut gerçek kapasiteye göre sunulur. Kodda bulunmayan işlem düğmesi yapılmış gibi gösterilmez.
- Mevcut DB için Siteye bağla gerçek site listesi ve impact önizlemesi açar. Sonuç görünene kadar pencere aynı kaynakta kalır.

## 4. SSL/TLS

İlk görünüm: Korunuyor / Kurulum gerekiyor / Süresi yaklaşıyor / İşlem başarısız; issuer, korunan adlar, gerçek bitiş tarihi ve kalan gün. Otomatik yenileme durumu ve son gerçek yenileme ayrı gösterilir.

Temel eylemler: Sertifika al, Yeniden düzenle/yenile, Korunacak alan adları. Otomatik kontrol ile yeniden üretim aynı etiket altında karışmaz. Test, private key/chain/CSR ve gelişmiş seçenekler ikinci seviyede. Kullanıcı e-postası uygun session'dan gelir; geç varsayılan açık formu ezmez.

Tek gönderim → gerçek iş aşaması → sertifika kaydı → Nginx/mail uygulaması → canlı TLS doğrulaması → aynı ekranın güncellenmesi. Değişmeyen sertifikaya yenilendi yazılmaz ve 90 gün eklenmez. Parmak izi, UUID ve teknik onay metni normal akışta istenmez.

## 5. Site ekleme ve barındırma

Barındırma formu yönlendirme ve mevcut izinli web sunucusu ayarlarını tek Kaydet ve uygula akışında sunar: yükleme boyutu, yanıt başlıkları; statik sitelerde önbellek ve index.html fallback; proxy/Python için yanıt süresi ve WebSocket. Site türüne uymayan kontrol görünmez. Taslak, eşzamanlı değişiklik ve oturum sınırları korunur. PHP/statik sitelerde sıralı başlangıç dosyaları ve 403/404/500/502/503/504 için site içindeki HTML hata sayfaları kaynakta eklendi. Boş alan mevcut varsayılanı kullanır; eski kayıt ve kalıcı işlerin varsayılan biçimi korunur. Hata dosyaları dış URL, değişken, gizli dosya veya başka site yolu kabul etmez; mevcut önizleme, configtest, health ve rollback üzerinden uygulanır. Kaynak kontrolü geçti; gerçek HTTP kabulü açık kalır. Document root ve tercih edilen www için güvenli kaynak değişikliği ayrıca açıktır.

- Adım 1: domain/subdomain, mevcut sahip veya açık yeni site yöneticisi tercihi.
- Adım 2: dosya yükleme/PHP, statik site, Node.js/Git veya mevcut hedef. Sadece seçilen amaca ait alanlar. Git repository boş hosting için şart değildir.
- Adım 3: hosting/DNS/mail/SSL özeti → Oluştur → gerçek aşamalar → site kartı ve Dosyaları aç.
- Barındırma: document root, tercih edilen domain, redirect, index/hata sayfaları ve gereken Nginx seçenekleri. Kaydet mevcut backend preview/configtest/health/rollback ile uygulansın; kullanıcı ikinci teknik yayın ekranına gönderilmesin.
- PHP: sürüm/handler ve temel php.ini; FPM gelişmişte. WordPress/Composer kendi görev ekranıdır; PHP ayarlarının yerine CLI durum listesi geçmez.
- PHP sitesi için `/node` ikinci PHP / WordPress ekranı olmaz; eski adres canonical hedefe redirect eder. **PHP Ayarları** ve **WordPress** iki ayrı amaçtır. WordPress kartında Kur, Yöneticiye gir, Parolayı değiştir, Güncelle, Eklentiler, Temalar, Klonla ve Kaldır; kurulum yoksa kurma akışı. Composer gelişmiş PHP araçlarında; Node/Git alanları PHP ekranında görünmez.
- Alias/subdomain için hangi DNS/mail/SSL alanının değişeceği önizlenir; sonuç aynı site bağlamında görünür.

## 6. Dosya, posta ve yedek

- Files: sol klasör ağacı, yol, liste ve bağlama göre araç çubuğu. Upload, yeni dosya/klasör, edit/save, rename, copy/move, archive, download, permissions, delete. Desteklenen mevcut Files/elFinder çözümüyle devam edilir; kabulden önce fallback silinmez.
- Posta: hesap listesi ve sade oluştur/düzenle penceresi; parola/kota/forward/alias, webmail ve IMAP/SMTP bilgisi anlaşılır. Tek hesabın silinmesi diğerini kesmez.
- Backup: tarih, kapsam, boyut, durum; Yedek al, zamanla, indir ve geri yükle. Restore önce etkiyi gösterir, açık hedef onayı alır; iş fiziksel veri doğrulanana kadar bitmez.

## 7. Ortak bileşen ve durum kuralları

SiteContext + ResourceTable + FormDrawer + Field + Notice + OperationProgress + ConfirmDialog. Mevcut PanelKit ve tasarım tokenları genişletilir; paralel tasarım motoru eklenmez. Kompakt satırlar, net primary action, gelişmiş ayrıntılar kapalı. Yeni tarayıcıda Gece varsayılanı; mevcut açık/sistem tema tercihi korunur. Aynı işlemde farklı ekranların farklı buton/terim düzeni olmaz.

Normal mutation için açık kaydet/başlat düğmesi yeterli kullanıcı teyididir; server confirmation digest backend/client protokolünde kalır. Etkili silme/restore gerçek hedef adıyla onaylanır. Mevcut CSRF/RBAC/lock/idempotency/rollback kaldırılmaz.

Loading, boş, yetkisiz, eksik bağımlılık, eski veri, hata ve devam eden iş ayrı. Hata girilen değerleri silmez; poll draft/scroll'u sıfırlamaz. Başarı yalnız fiziksel sonuçla. Native prompt/alert kullanılmaz. Label/input bağlantısı, gerçek erişilebilir adlar ve modal odak tüm formlarda zorunlu; Firewall formunda gözlenen bağımsız label hatası giderilir.

## 8. Tasarım kabulü

Önce site kartı, DB oluştur/bağlantı, SSL ve site ekleme etkileşimli taslakları; ardından gerçek üretim bundle'ında aynı görevler. 320/390/834/1440 px, %200 zoom, Chromium/Firefox, klavye/modal odak, uzun domain ve 100+ satır. Tasarım görseli, login ekranı veya sabit artifact adresi ürün görevinin tamamlanması değildir. Her ekranın rol, API/web sürümü, gerçek görev ve sonucu kaydedilir.
