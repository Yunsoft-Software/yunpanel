# Site kopyalama

### T922 · Statik site kopyası için kaynak ve hedef planı
- **Bağımlı:** T894, T921
- **Dosyalar:** `apps/api/src/static-site-copy-plan.js`, `apps/api/test/static-site-copy-plan.test.js`, `apps/api/test/fixtures/static-site-copy.js`
- **İş:** Önceden oluşturulmuş, aynı yerel sunucudaki iki upload tabanlı statik sitenin değişmez dosya planını oluştur. Mevcut Website, Application, provisioning ve dosya denetimlerini kullan. İki uç ayrı site, Application, Unix kullanıcısı ve gerçek aktif kök olmalı. Ortak kök, iç içe kök ve yönetilen alt alan kökü kabul edilmez. Hedef boşsa veya tek `index.html` mevcut statik kurulum makbuzu ve resmî içerikle eşleşiyorsa plan oluştur. Dosya manifesti, sınırlar, kök ve sürüm kimlikleri işlem sırasında yeniden doğrulamaya elverişli olsun. Bu dilim dosya yazmaz, rota açmaz ve genel uygulama, veritabanı, posta veya DNS kopyalamaz.
- **Kabul:** Gerçek geçici dosya ağacında bağımsız kaynak ve boş/doğrulanmış hedef planı oluşur. Dolu veya değişmiş hedef, örtüşen kök, farklı sunucu, yönetilen alt alan, yanlış runtime ve değişen içerik reddedilir. İlgili kaynak testleri ve lint geçer. İş yürütme, arayüz ve `.28` kabulü sonraki dilimdedir.

### T923 · Statik site kopyası için kilitli dosya aktarımı
- **Bağımlı:** T921
- **Dosyalar:** `apps/api/src/site-file-manager.js`, `apps/api/src/static-site-copy-transfer.js`, `apps/api/test/static-site-copy-transfer.test.js`
- **İş:** İki site dosya işlemini Application sırasıyla ortak kilide al ve planın gerçek köklerini işlem boyunca doğrula. Normal dosya yöneticisi aynı kilidi kullanır. Kaynak dosyalar yalnız okunur. Hedefte yeni dosya üzerine yazılmaz ve resmî `index.html` en son, beklenen içerik eşleşirse değiştirilir. Son manifesti ve hedef içeriğini doğrula. Hata hâlinde mevcut içeriği veya belirsiz kısmi kopyayı otomatik silme. API, iş kaydı ve UI bu aktarımı sonraki dilimde çağırır.
- **Kabul:** Gerçek iki geçici dosya ağacında ikili içerik ve iç içe dizin aktarımı ile kaynak korunumu doğrulanır. Başka siteye yazma ve kök değişimi reddedilir. Kilit tutulurken normal dosya işlemi sırada kalır ve hata sonrasında serbest kalır. İlgili kaynak testleri ve lint geçer.

### T924 · Statik kopyayı kalıcı iş türüne bağla
- **Bağımlı:** T891, T921
- **Dosyalar:** `packages/protocol/src/index-node-passenger.js`, `apps/api/src/job-registry.js`, `apps/api/src/local-host-operations.js`, `apps/api/test/static-site-copy-job.test.js`
- **İş:** `website.static.copy` yerel iş türünü mevcut protokol, iş kaydı ve host yürütücü bağlantısına ekle. Payload kaynak/hedef Website ve Application kimlikleri, yetkili Owner oturumu ve plan özetiyle sınırlı olur. Public sonuçta yol, kullanıcı veya hedef kimliği yayımlanmaz. Kısmi hedefe genel yeniden deneme ile ikinci yazma başlamaz. HTTP ve kullanıcı arayüzü bu dilimde değişmez.
- **Kabul:** Gerçek geçici iş deposunda geçerli istek kaydolur ve aynı kimlikle okunur. Uyuşmayan kimlik, eksik yetki, geçersiz sonuç ve genel yeniden deneme reddedilir. Odak testleri ve lint geçer.

### T925 · Statik kopyayı panel API üzerinden başlat ve izle
- **Bağımlı:** T881, T892, T898, T913, T920, T922, T923, T924
- **Dosyalar:** `apps/api/src/website-static-copy-service.js`, `apps/api/src/website-static-copy-http.js`, `apps/api/src/index.js`, `apps/api/src/management-app.js`, `apps/api/src/local-execution-error.js`, `apps/api/test/website-static-copy-http.test.js`, `apps/api/test/job-recovery-operation-parity.test.js`, `apps/api/test/local-operation-queue-parity.test.js`
- **İş:** Owner için iki gerçek siteye bağlı önizleme, kalıcı istek açma ve aynı isteği okuma rotalarını bağla. Kopyalamadan önce iki yetkiyi ve plan özetini, sonrasında hedef HTTP sonucunu doğrula. Kayıp yanıtta aynı istek aynı işi döndürür. API başlangıcında yalnız yarım kalmış statik kopya işini sonuç belirsizliğiyle uzlaştır, dosya yazmayı yeniden başlatma. Mevcut DNS, DB ve kaynak site kimliği korunur.
- **Kabul:** Gerçek normal HTTP istemcisi, geçici kalıcı kayıt ve dosya ağacında önizleme, 202 ve aynı GET sonucu, iki uç yetki reddi, bozulmuş plan, farklı içerikle aynı istek kimliği ve yarım işin yerinde uzlaştırılması doğrulanır. Odak testleri ve lint geçer. Tarayıcı ve Linux host kabulü sonraki dilimdedir.

### T926 · Statik site kopyalama formu ve işlem takibi
- **Bağımlı:** T922, T923
- **Dosyalar:** `apps/web/src/workspace/StaticSiteCopyDialog.jsx`, `apps/web/src/workspace/SiteDetailPage.jsx`, `apps/web/src/workspace/job-presentation.js`
- **İş:** Owner’ın uygun statik site ekranına ortak panel bileşenleriyle kopya formunu ekle. Hedef seçimi sonrası önizleme yapılır ve aynı istek kimliğiyle iş başlatılır. Sayfa yenilemede veya yanıt kesilirse aynı iş okunur. Uygulama, posta, veritabanı veya DNS kopyalanmaz. Sunucunun hata yanıtı görünür kalır.
- **Kabul:** Lint ve web build geçer. Kopyalama modalı yalnız uygun sitelerde açılır ve aynı istek işine döner. Bu koşulların gerçek tarayıcı ve host kabulü T925 API bütünleşmesiyle birlikte yapılır.

### T927 · PHP sitesi için MariaDB kopyalama motoru
- **Bağımlı:** T925
- **Dosyalar:** `packages/host-runtime/src/site-database-copy-manager.js`, `packages/host-runtime/test/site-database-copy-manager.test.js`
- **İş:** Aynı yerel MariaDB üzerinde iki ayrı şema ve iki kayıtlı yerel kullanıcı için sınırlı aktarım hazırla. Sunucu envanteri desteklenmeyen nesneleri ve dolu hedefi aktarım öncesinde reddetsin. Tek InnoDB tutarlı veri anlık görüntüsünü yalnız kaynak kullanıcısıyla al ve yalnız hedef kullanıcısıyla içe aktar. Şema oluşturma, silme, root ile veri içe aktarma, bağlantı bilgisi sızıntısı ve otomatik tekrar olmamalı. Sonuç tablo ve aktarım bilgisiyle sınırlı olsun. Bu motoru çağıracak yetki, ortak kilit ve kalıcı iş ayrı görevde uygulanır.
- **Kabul:** Ayrı test MariaDB örneğinde iki kullanıcı ve iki şemayla gerçek şema, satır ve binary içerik aktarılır. Hedef yazımı kaynak veriyi değiştirmez. Dolu veya desteklenmeyen şemada aktarım başlamaz. Hedef kullanıcı kaynağa erişemez. Geçerli yerel ortam ve doğrulama komutu kaydedilir.

### T928 · PHP kopyasında hazır site ve veritabanı kimliği
- **Bağımlı:** T921, T925
- **Dosyalar:** `apps/api/src/php-site-copy-plan.js`, `apps/api/test/php-site-copy-plan.test.js`
- **İş:** Aynı yerel sunucudaki ayrı ve etkin iki PHP sitesi için değişmez kopya girdisi oluştur. P1b’nin sabitlenmiş kök ve sahiplik denetimlerini, normal PHP kurulumunun beklenen hedef dosyası ve binding/credential registry’leriyle birleştir. İlk dilim web kökünde tek giriş dosyası ve site ev dizininde desteklenen özel bağlantı biçimi kullanan opt-in uygulamadır. İki ayrı scope ve schema, binding/credential revizyonları ve dosya hash’i bağlansın. Özel bağlantı değerleri plan veya sonuçlara girmez. Plan dosya/veritabanı yazmaz.
- **Kabul:** İki ayrı kimlik, etkin PHP yayını, ideal kaynak ve resmî başlangıç dosyalı hedefte plan oluşur. Dolu/yanlış hedef, ortak kök, paylaşılan site ya da kullanıcı, yönetilen alt kök, yanlış binding, çoklu veritabanı, değişen dosya ve bayat revizyon reddedilir. Gerçek dosya ağacı ve kalıcı registry kanıtı, sonraki gerçek DB/paket kabulünden ayrı kaydedilir.

### T929 · PHP kopyasında özel bağlantı dosyası
- **Bağımlı:** T921
- **Dosyalar:** `apps/api/src/php-site-copy-connection.js`, `apps/api/src/php-site-copy-connection-worker.js`, `apps/api/test/php-site-copy-connection.test.js`
- **İş:** Kaynak bağlantı dosyasını kayıtlı binding ve kullanıcının güncel değerleriyle site Unix hesabı altında doğrula. Hedefte yalnız hedefin değerleriyle, web dışındaki site ev dizininde, yeniden yazılamayan özel bir dosya oluştur. Kimlik bilgileri yalnız worker stdin’inden geçer. Worker veya plan sonucunda yalnız bağlantı kimliği ve sürümü döner. Çakışan, yanlış sahipli, dış yol ya da link içeren mevcut dosya korunur.
- **Kabul:** Gerçek dosya sisteminde özel dosya oluşturma ve okuma, doğru ve yanlış bağlantı eşleşmesi, eski içeriğin korunması, symlink/hardlink ile zayıf mod reddi ve web kökünden bağımsızlık doğrulanır. Linux site kullanıcısı ve PHP okuması bütünleşik canlı kabulde sınanır.

### T930 · Veritabanı üstverisinde ortak uygulama kilidi
- **Bağımlı:** T925
- **Dosyalar:** `apps/api/src/database-binding-http.js`, `apps/api/src/database-credential-http.js`, `apps/api/src/website-database-delete-http.js`, `apps/api/src/management-app.js`, `apps/api/test/database-binding-http.test.js`, `apps/api/test/database-credential-http.test.js`, `apps/api/test/website-database-delete-http.test.js`
- **İş:** Doğrudan binding, credential ve DB silme onayı üstveri yazımlarını mevcut Application kilidinden geçir. Yetki kapsamı, güncel kayıt ve revizyon kilit altında yeniden kontrol edilsin. Kuyrukta zaten sıralanan native işler, phpMyAdmin'in salt okunur kontrolü ve site bağlantıları korunur. Uygulama kilidi farklı sitelerin bağımsız üstveri işlemlerine engel oluşturmaz.
- **Kabul:** İlgili yönetim rotalarının mevcut testleri geçer. Gerçek geçici kilit ve kalıcı registry kullanan normal HTTP akışında aynı uygulamanın üstveri yazımı kilit tutulurken reddedilir, başkasına ait uygulama yazımı kendi scope içinde çalışır, kilit bırakıldığında eski akış başarılı olur. Dosya, kaynak ve kapsam dışı sunucu davranışı değişmez.

### T931 · PHP dosyası ve MariaDB kopyasının yürütme sırası
- **Bağımlı:** T927, T928, T929
- **Dosyalar:** `apps/api/src/php-site-copy-transfer.js`
- **İş:** İki Application kilidini sabit sırayla al. Kaynak ve hedef site, bekleyen silme, dosya, yetki ve DB planını yazım öncesi tekrar doğrula. Hedef kendi DB hesabıyla veriyi aldıktan sonra özel bağlantıyı oluştur. Tek PHP giriş dosyasını başlangıç dosyasının hash’iyle koşullu olarak en son yayınla. İş sırasında kaynak dosyalar salt okunur. Hedef HTTP ve kaynak/hedef dosya içerikleri readback ile doğrulansın. Kısmi yazım durumu otomatik yinelenmesin ve mevcut veri korunarak raporlansın.
- **Kabul:** Kaynak incelemesi ve mevcut gerçek dosya, kilit ve MariaDB bileşen testleri geçer. Birleşimin hedef HTTP yanıtı, DB ve dosya kapsamı ile dolu hedef kabulü T934’te gerçek paketle ölçülür.

### T932 · PHP kopyası için kalıcı yerel iş ve sonuç
- **Bağımlı:** T924, T925
- **Dosyalar:** `packages/protocol/src/index-node-passenger.js`, `apps/api/src/job-registry.js`, `apps/api/src/local-host-operations.js`, `apps/api/test/php-site-copy-job.test.js`
- **İş:** `website.php.copy` yerel işini ekle. Statik kopyanın doğrulanmış kaynak/hedef kimliği, Owner ve digest envelope sınırlarını ortak kullan. Sonuçtaki dosya, tablo ve bayt sayıları sınırlandırılsın ve hiçbir sır taşımasın. Veritabanı veya dosya yazımı belirsiz iş genel retry ile yeniden başlamasın. Taşıma ve HTTP ayrıdır.
- **Kabul:** Gerçek geçici iş kaydında işlem kabul, kaynak, salt yerel yürütme, kalıcı iş kimliği ve public sonuç kapsamı; yetkisiz/yanlış şema sonucu reddi ve genel retry yasağı doğrulanır. Mevcut statik kopya ve kuyruk regresyonu geçer.

### T933 · PHP ve MariaDB kopyasını panel API’sine bağla
- **Bağımlı:** T925, T930, T931, T932
- **Dosyalar:** `apps/api/src/php-site-copy-service.js`, `apps/api/src/website-static-copy-http.js`, `apps/api/src/index.js`, `apps/api/src/management-app.js`, `apps/api/src/local-execution-error.js`, `apps/api/test/job-recovery-operation-parity.test.js`, `apps/api/test/local-operation-queue-parity.test.js`, `packages/host-runtime/package.json`
- **İş:** Owner iki siteye güncel erişimle önizleme, onay ve aynı istekle iş takibi yapabilsin. PHP işinin başlatılması ve süreç kesintisi uzlaştırması mevcut yerel yürütücüye bağlansın. Yarım veya doğrulanmamış hedef kullanıcıya gösterilsin. Statik kopya rotaları ve WordPress staging korunur.
- **Kabul:** Yerel kuyruk ve yeniden başlatma eşleme doğrulamaları, bağımsız kaynak incelemesi ve tam kaynak kontrolü geçer. Gerçek panel API, aynı iş ve host davranışı T934’te doğrulanır.

### T934 · PHP ve MariaDB kopyasını panelde aç
- **Bağımlı:** T926, T932
- **Dosyalar:** `apps/web/src/workspace/StaticSiteCopyDialog.jsx`, `apps/web/src/workspace/SiteDetailPage.jsx`, `apps/web/src/workspace/job-presentation.js`, `apps/web/test/job-presentation.test.js`, `docs/website-workspace.md`
- **İş:** Kopyalama formunu statik ve desteklenen PHP sitesi için ortak kullan. PHP’de kaynak uygulama ve boş hedef koşullarını, dosya ve tablo sayısını ve aynı isteğin sonucunu göster. Uygulama hazırlama biçimi ve PHP bağlantı dosyası alanları kullanım notunda açık olsun. Kaynak, hedef ve diğer site türleri ayrımı korunur.
- **Kabul:** Lint, web build ve görev sunumu testi geçer. Gerçek tarayıcı kanıtı T935’te alınır.

### T935 · PHP ve MariaDB kopyasını gerçek paket ve tarayıcıda doğrula
- **Bağımlı:** T933, T934
- **Dosyalar:** `e2e/live-audit/30-native-php-db-copy-mutation.spec.js`, `docs/t883-coverage-and-priorities-2026-11-12.md`
- **İş:** Güncel kaynak ve Linux paketini doğrula. `.28` üzerinde iki sahipli geçici PHP sitesiyle normal panel kopya akışını çalıştır. Kopyayı tarayıcı reload sonrası aynı işten izle. Kaynak ve hedef DB kullanıcıları, SQL/HTTP sonucu, ilk yazım ve dosyaların etkisi ayrı ölçülsün. Test kaynaklarını normal panel üzerinden temizle.
- **Kabul:** Tam kaynak kapısı geçer. `.28` paketi ve gerçek Chromium/Firefox koşularında hedef SQL okuma/yazma, kaynak SQL/HTTP korunumu, DB kullanıcı sınırı, dolu hedef reddi, aynı iş kimliği, iki site temizliği ve mevcut panel sağlığı doğrulanır.
