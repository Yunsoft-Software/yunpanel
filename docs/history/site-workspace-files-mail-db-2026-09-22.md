# Site çalışma alanı — Dosyalar, e-posta ve veritabanları

Tarih: 22 Eylül 2026. Başlangıç: `92a51d1d3b201d91872f25bfaefdc1a7290cd327`. Bu kayıt kaynak geliştirmesini ve yerel bileşen kontrollerini anlatır; canlı dağıtım veya tüm güvenlik kabullerinin tamamlanması değildir.

## Görsel referans ve kaynak kapsamı

Kullanıcının seçimi, reddettiği açık/Bootstrap benzeri kolaj değil, onu izleyen koyu lacivert ve mavi vurgulu YunPanel çizimidir. Önceki ortak tema korunurken bu turda özellikle dosya çalışma yüzeyi ve site içi kaynak erişimi düzenlendi.

- `FilesPanel.jsx` ve `ui/file-workspace.css`: masaüstünde solda site kökü/tembel yüklenen klasör ağacı, sağda dosyalar; üstte konum yolu ve Yeni dosya / Yeni klasör / Yükle eylemleri. Arama, gizli dosyalar, klasör-öncelikli sıralama, liste/ızgara, filtreye göre çoklu seçim ve dosya ayrıntıları var. Mobilde klasör ağacı ayrı pencereye açılır. Tek başına yeni bir dosya arka ucu, root dosya erişimi veya dosya motoru eklenmedi.
- Metin editörü satır numarası, Ctrl/Cmd+S, kaydedilmemiş değişiklik onayı ve mevcut `expectedSha256` karşılaştırmasını kullanır. Dosya sürükleme/yükleme önce kullanıcı onayı ister; tamamlanan yüklemeler hata sonrası yeniden gönderilmez. Klasör silme ve toplu silme hedefleri mevcut açık onaylarla iletilir.
- `SiteNavigation` ile sitenin Dosyalar, Veritabanları, E-posta, SSL ve Uygulama girişleri doğrudan erişilebilir. Diğer araçlar gerçek bağlantılarla Diğer menüsündedir. Domain-ID kullanan mevcut URL sözleşmesi değişmedi; `/resources` eski bağlantısı korundu.
- `SiteResourcesPanel`: veritabanı sekmesi yalnız seçilen Website'in kayıtlarını okur. phpMyAdmin eylemi ve Yönet penceresi aynı site bağlamındadır. Eksik erişim kullanıcısı oluşturma/uygulama, mevcut parola rotasyonu, kullanıcı kaldırma, doğrulanmış yedek, geri yükleme ve silme/finalize sözleşmeleri kullanılır. Yeni bağımsız schema oluşturma akışı bu turda eklenmedi; provision edilmiş veya Owner tarafından bağlanmış veritabanları yönetilir.
- `SiteMailPanel`: mail alan adı, açık `webDomainId -> Domain.websiteId` ilişkisiyle bulunur; alan adı son ekinden sahiplik türetilmez. Posta kutuları, yönlendirmeler, webmail ve değişiklik uygulama site içinde açılır. Site yöneticisine global mail kuyruğu, ortak Roundcube kurulumu veya başka sitelerin envanteri gösterilmez. Owner'a mevcut DNS/DKIM ve yapılandırma araçları korunur. Ziyaret edilen e-posta bölümleri taslakları korumak için mounted kalır; Website değişiminde state sıfırlanır.
- `SiteWebmailAccess` yalnız sunucunun döndürdüğü etkin ve geçerli hostname mapping'ini açar. Harici/eksik mail hizmeti hazır gibi gösterilmez. `SiteMailApplyPanel` yeni önizlemede mevcut etkin/devre dışı durumunu korur; iş başarıyla bitmeden tamamlandı demez ve başarısız işi körlemesine yeniden sıraya koymaz.

## Yetki katmanı

`apps/api/src/app.js`, mevcut uygulamanın değişmeden taşınmış `management-app.js` kopyasını saran dar bir Express sınırıdır. İç uygulama başlangıçtaki `803f68e6169f0586808c80a386c47b35dcbda170` blob'uyla aynıdır. Express zaten mevcut bağımlılıktır. Auth, CSRF ve mevcut route/lifecycle kontrolleri kaldırılmadı.

`site-resource-boundary.js`, site_manager için dosya, veritabanı binding/credential, mail domain/mailbox/alias kimliklerini canlı registry ilişkileri üzerinden doğrular. Başka Website/uygulama/sunucuya ait kimlik ve body ile sahiplik taklidi reddedilir; izin kaynağı okunamazsa kapalı kalır. Koleksiyonlar siteyle sınırlandırılır, sunucu yanıtı küçük kimlik özetiyle sınırlanır. Mail yapılandırma önizlemesindeki genel domain listesi ve artifact ayrıntıları site hesabına verilmez. Owner ve read-only mevcut ayrı politikalarını kullanır.

Bu ek katman, bütün DNS/terminal/AI uçlarının ve her job result alanının bağımsız güvenlik incelemesi yerine geçmez. Gerçek HTTP entegrasyonu ve iki site hesabıyla kabul testleri açık kalır.

## Açık phpMyAdmin işi — YP-04 kapanmadı

Yerel kaynak incelemesinde ortak phpMyAdmin proxy'sinin SQL oturum çerezini güncel panel hesabına bağlamadığı görüldü. Siteye bağlı bir signon capability üretmek, sonraki vendor isteklerindeki eski SQL oturumunu tek başına bağlamaz. Aynı tarayıcıda Owner/Site A oturumundan Site B panel hesabına geçiş özellikle doğrulanmalıdır.

Bu nedenle ilk rol istisnası son güvenlik commitinde kapatıldı: `tool-gateway-session-policy.js`, site_manager için `phpmyadmin_site_session_binding_required` ile 403 döndürür. Owner'ın mevcut geçişi korunur; site içi diğer veritabanı kontrolleri bundan ayrıdır. **Site yöneticisi phpMyAdmin erişimi bu turda tamamlanmış değildir.** Bunu yalnız rolü kontrol edip açarak veya cookie temizliğini kullanıcıya bırakarak çözmek kabul edilmez.

Kalan kaynak işi: her phpMyAdmin vendor isteğinde güncel panel session/user ve güncel Website yetkisiyle bağlanmış bir SQL/gateway session doğrulaması; logout, session rotation, hesap değişimi, Website yetkisinin kaldırılması ve cookie replay için fail-closed davranış. Mevcut kalıcı SQL oturumlarının geçiş planı ve regresyon testleri birlikte gerekir. `plan.md` YP-04 bu nedenle açık kalır; gerçek host kabulü `todo.md` T-SITE-WORKSPACE'dedir.

## Gerçekte çalıştırılan kontroller

- 32/32 seçili Node testi: 6 dosya liste/selection/path modeli, 5 site kaynak modeli ve veri talebi, 17 registry-mock sınır testi, 4 phpMyAdmin gateway politika testi. Son dört test erişimin güvenli bağ eklenene kadar kapalı kaldığını doğrular; çalışan site-manager SQL oturumu kanıtı değildir.
- 42/42 yerel Chromium bileşen kontrolü: dosya ağacı/arama/seçim/editör/çakışma/yükleme onayı; site DB liste/iş/form davranışları; site mail seçimi, bölüm/draft davranışı ve webmail kartı; 320/390/834/1440 CSS px sayfa taşması kontrolleri.
- 12 modüllük yerel JSX transpile kontrolünde sıfır diagnostic. Bu Vite/production build değildir.
- 15 güncel ekran görüntüsü üretildi. Dosyalar, site veritabanları ve site webmail için dört genişlik; ayrıca ızgara, editör ve mobil klasör ağacı. Her görüntüde örnek-verili bileşen testi olduğu yazılıdır.

Yerel ortam Node 22.16.0 / React 18.2.0 / Chromium 144.0.7559.96'dır. Üretim Node/React sürümleri değiştirilmedi. Tam checkout/npm ci yapılamadı. Harness kabuğu, router, WorkspaceContext ve API taklittir; mevcut mail CRUD alt panelleri stub'dır. Mail ekran görüntüsü gerçek yeni SiteWebmailAccess bileşenini gösterir; SMTP veya posta kutusu CRUD kabulü değildir. Gerçek auth, Express uygulama mount zinciri, SQL/phpMyAdmin/PHP, upload host izinleri ve üretim React 19/Vite bundle'ı çalıştırılmadı. Ekranlar geliştirme bileşenlerine aittir; bütün üretim bundle'ıyla byte-identical oldukları iddia edilmez.

Mevcut source-wiring testlerindeki mail/database sekmesi yasağı gerçek yeni ekranlarla değiştirildi; dosya endpoint yolu ve checksum guard kontrolleri korundu. Bu eski bütün test paketlerinin çalıştırıldığı anlamına gelmez. Eski bir metin beklentisi için çalışan arayüz veya yetki katmanı topluca geri alınmamalıdır.

Sunucuya bağlanılmadı/deploy yapılmadı; `.44` Plesk hostuna dokunulmadı. GitHub Actions kullanılmadı. Kalan canlı kabul `todo.md` içinde; geniş UI planı, YP-04 ve diğer uzman ekranlar tamamlandı sayılmadı.
