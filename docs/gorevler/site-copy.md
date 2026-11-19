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
