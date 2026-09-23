# UX-PL-04b — Site listesinden doğrudan görevler

2026-09-23; başlangıç `development@92e12391`. Son kullanıcı talimatı ve `ui-plan.md` önceliği devam eder: Plesk görev yerleşimi; günlük araçlar görünür, teknik envanter ikinci planda. Kaynak eşlemesi rota matrisindeki SITE-01–08, SITE-13/14 ve atlas R02/R03/R05–10. Yeni bir Plesk sürümü veya canlı görünüm bu tur araştırılmış sayılmaz.

## Kaynakta doğrulanan boşluk

`WebsitesPage` yalnız SSL ve Yönet eylemlerini gösteriyor. Parent-group sayfalama, arama, sıralama, görünüm tercihleri ve alt alan adı daraltma mevcut; korunacak. `DomainOperations` alias düzenleme formu değildir. `NewWebsitePage?parent=<DomainID>` mevcut alt alan adı formunu açar; yeni create motoru yazılmaz.

## Dar uygulama sözleşmesi

- [ ] **UX-PL-04b.1:** mevcut domain listesinde görev kartları; Dosya Yöneticisi, Veritabanları, SSL/TLS, DNS, Posta ve Günlükler her kartta açık. Barındırma ve DNS ile mevcut uygulama/Git bağlantıları aynı kartta. Araçların tek erişimi gizli menü veya teknik ayrıntı değildir.
- [ ] **UX-PL-04b.2:** domain/Website/application aynı sunucu ve tekil kimlikle çözümlenir. Loading/stale/eksik ilişki görünür açıklamadır; hostname veya porttan başka site uygulaması seçilmez. Kayıt kimlikleri site adının yerine geçmez. Frontend çözümleyici yetkilendirme motoru değildir.
- [ ] **UX-PL-04b.3:** arama/alias, durum/tür filtreleri, üst-alt hiyerarşi, parent-group sayfalama, yoğunluk ve eski site deep linkleri korunur. Üstte Site ekle, uygun Owner kartında Alt alan adı ekle; salt okunur ve site hesabına yeni oluşturma yetkisi verilmez.
- [ ] **UX-PL-04b.4:** model/regresyon ve mümkün olan kaynak kontrolleri; test sonucu ve sınırı aynı belgede kaydedilir.
- [ ] Gerçek React/Vite ve tarayıcı/host kabulü. Alias düzenleme, silme/askı, hosting formu ve kalan PHP/cron/backup/istatistik görevleri bu dar dilimin tamamlanma iddiası değildir.

## Korunacak sınırlar

FilesPanel/gateway, mevcut route/API/CSRF/yetki kontrolleri ve kayıt kimlikleri değişmez. Stale ilişkiden aktif uygulama/DB/mail hedefi türetilmez. Desteklenmeyen dosya hedefi mevcut SiteFilesPanel'in açıklamasını göstermeye devam eder; dosya erişimi gizlenmez. Sertifika/site durumu canlı sağlık ölçümü diye sunulmaz.

Mevcut Ember renk/font/radius tokenları ve ortak bileşenler korunur. Yeni CSS yalnız kart yerleşimine uygulanır. Görünür görev bağlantıları dar ekranda sarılır. Hiyerarşi daraltması site aracı kapatması değildir.

Gerçek ortam kontrolleri `docs/ux/plesk-navigation-todo.md`, `docs/ux/development-todo.md` ve kök `todo.md` ile birlikte geçmelidir. Kaynak alt işaretleri üst UX veya production kabulünü kapatmaz. Yalnız development, küçük commitler, `[skip ci]`, Actions yok; main ve canlı hosta dokunulmaz.
