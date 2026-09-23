# Plesk yerleşimi — son kullanıcı teyidi ve uygulama sırası

2026-09-23; kaynak tabanı `development@bc5f0d40`. Kullanıcı yeniden açıkça istedi: günlük işlerin yeri, menüsü ve işleyişi Plesk gibi olacak; teknik/gereksiz ayrıntılar önde, gerekli araçlar gizli olmayacak. Bu karar yeni tema veya yeni backend motoru değildir.

## Doğrulama sonucu

`plan.md` A bölümü, `ui-plan.md`, `plesk-ux-spec.md` ve `plesk-route-matrix.md` hedef olarak doğru yöndedir. **Mevcut kod henüz bu hedefe uygun değildir.** Kaynak taraması şu farkları doğruladı:

- `WorkspaceApp.jsx`: `/` hâlâ `/dashboard` açıyor; hedef `/websites`.
- `ui/ux-model.js`: ana menü eski Günlük kullanım / Kaynaklar / Sistem gruplarında; Kullanıcılar doğrudan görünmüyor. Site hesabının global Posta/Veritabanları girişi yok.
- `ui/SiteNavigation.jsx`: DNS, Git, günlükler, barındırma ve erişim araçları `Diğer` içinde. Eski altı-gruplu model de kaynakta duruyor.
- `SiteDetailPage.jsx`: genel bakışta günlük araçlardan önce provisioning recovery var. Hızlı erişimde DNS/Git yok; site ayarlarının ilk içeriği kayıt kimlikleri.
- `workspace-resources.js`: `/websites` Website envanterini istemiyor; site ilişkisi/runtime ve sayaç bilgisi bu girişte eksik kalabiliyor.
- Global `MailDomainsPage` sunucu düzeyinde yapılandırma ve kuyruk bileşenleri de taşıyor. Site hesabına sol menü eklemek, bu Owner ağırlıklı ekranı aynen açmak anlamına gelmeyecek; mevcut yetkili site mail/DB ekranına scope çözücüyle gidilecek.

## Plesk kaynakları yeniden okundu

1. [The Plesk GUI](https://docs.plesk.com/en-US/obsidian/administrator-guide/70562/): Power User'da host yönetimi Tools & Settings altında; Customer Panel site/mail/içerik odaklı. Power User ile Service Provider aynı görünüm değildir.
2. [Plesk Tutorial](https://docs.plesk.com/en-US/obsidian/quick-start-guide/plesk-tutorial.74376/): domain → File Manager; global Databases ve Mail; domain kartı Hosting & DNS → DNS; Dashboard → Backup & Restore; üst kullanıcı menüsünden profil.
3. [Managing Web Hosting](https://docs.plesk.com/en-US/obsidian/quick-start-guide/plesk-functionality-explained/managing-web-hosting.74401/) ve [General Settings](https://docs.plesk.com/en-US/obsidian/administrator-guide/website-management/websites-and-domains/hosting-settings/general-settings.72050/): domain altında Hosting & DNS → Hosting.

Bu doğrulama görev konumlarına aittir. Dokümanın eski ekran görüntüsünü 2026 canlı build'i diye sunmaz. Bütün Plesk sürüm/edition/extension ekranları test edilmiş değildir. Son sade reseller kararı korunur: kullanıcı ve bayi yönetimi için ayrı paket/abonelik önkoşulu üretilmez; bu model Plesk Power User'ın birebir özelliği diye adlandırılmaz.

## Bağlayıcı öncelik

**Bu tur UX-PL-03/04/06 kaynak yerleşimi, reseller/cleanup backend genişletmesinden önce gelir.** Güvenlik ve gerçek host kabulü ertelenmiş başarıya dönüşmez; önceki RS/BUG/PROD işleri silinmez.

- Ana giriş Web Siteleri ve Alan Adları; Posta, Dosyalar ve Veritabanları sol menüde doğrudan. Kullanıcılar Owner'a görünür. Host servisleri, Docker ve teknik envanter Araçlar ve Ayarlar üzerinden erişilir; mevcut URL'ler korunur.
- Site çalışma alanında Genel Bakış (Plesk Dashboard), Barındırma ve DNS, Posta görev aileleri. Dosyalar/DB/SSL/runtime/Git/günlükler görünür araçlardır; `Diğer` bunların tek erişimi olamaz.
- Genel bakışta araçlar önce, durum ve gerekli hata bildirimi görünür, uzun recovery/kimlik/envanter ayrıntısı daha aşağıda. Eksik veya başarısız iş gizlenmez.
- Sadece gerçekten mevcut UI/API'ye giden bağlantı eklenir. Henüz boş olan Backup CapabilityPage ve olmayan istatistik/PHP/cron arayüzleri çalışan araç diye vitrine konmaz; eksikler matriste ve TODO'da açık kalır.
- Owner global mail/DB ekranı ile site hesabının scope'lu ekranı ayrılır. Hazır olmayan/stale/forbidden envanterden otomatik hedef çıkarılmaz. Website ile Domain ID karıştırılmaz. Yanlış explicit seçim başka siteye düşmez.
- Mevcut Ember renk/font/radius, FilesPanel ve gateway, auth/CSRF/rol/Unix izolasyonu, eski deep linkler korunur. Dar ekranda araçlara yalnız yatay taşma veya gizli menü ile erişilmez; sarma ve klavye kabulü gerekir.

## Uygulama / kabul

- [x] Plan ve mevcut kaynak, resmî Plesk görev belgeleriyle karşılaştırıldı; farklar kaydedildi.
- [ ] UX-PL-03a: ana menü, varsayılan giriş, Owner araç merkezi ve rol uyumlu komut araması.
- [ ] UX-PL-03b: site hesabının global Posta/DB girişinden mevcut site aracına güvenli kapsam seçimi.
- [ ] UX-PL-04a/06a: üç site görev ailesi, görünür araçlar ve günlük görevlerin teknik ayrıntıdan önce gelmesi.
- [ ] Kaynak/model testleri; ardından Node >=24.11.1/npm >=11 tam check ve gerçek React/browser kabulü.
- [ ] Genişleyen domain kartı, domain/subdomain/alias üst eylemleri, gerçek barındırma düzenleme ve kalan araçların tamamı. Bu dar dilim tüm Plesk UX'ini kapatmaz.

Gerçek ortam devri `docs/ux/development-todo.md` ve `todo.md` içindedir. Yalnız development, küçük commitler ve `[skip ci]`; main/Actions/canlı host işlemi yok. `.44` hiçbir amaçla kullanılmaz.
