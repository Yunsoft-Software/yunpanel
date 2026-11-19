# Site kopyalama

### T922 · Statik site kopyası için kaynak ve hedef planı
- **Bağımlı:** T894, T921
- **Dosyalar:** `apps/api/src/static-site-copy-plan.js`, `apps/api/test/static-site-copy-plan.test.js`
- **İş:** Önceden oluşturulmuş, aynı yerel sunucudaki iki upload tabanlı statik sitenin değişmez dosya planını oluştur. Mevcut Website, Application, provisioning ve dosya denetimlerini kullan. İki uç ayrı site, Application, Unix kullanıcısı ve gerçek aktif kök olmalı. Ortak kök, iç içe kök ve yönetilen alt alan kökü kabul edilmez. Hedef boşsa veya tek `index.html` mevcut statik kurulum makbuzu ve resmî içerikle eşleşiyorsa plan oluştur. Dosya manifesti, sınırlar, kök ve sürüm kimlikleri işlem sırasında yeniden doğrulamaya elverişli olsun. Bu dilim dosya yazmaz, rota açmaz ve genel uygulama, veritabanı, posta veya DNS kopyalamaz.
- **Kabul:** Gerçek geçici dosya ağacında bağımsız kaynak ve boş/doğrulanmış hedef planı oluşur. Dolu veya değişmiş hedef, örtüşen kök, farklı sunucu, yönetilen alt alan, yanlış runtime ve değişen içerik reddedilir. İlgili kaynak testleri ve lint geçer. İş yürütme, arayüz ve `.28` kabulü sonraki dilimdedir.
