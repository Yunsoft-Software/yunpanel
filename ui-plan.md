# YunPanel — Plesk UX Geçişi

## 2026-09-25 — Site Backup Manager

- [x] **BACKUP-UI-01/02 kaynak:** `06bc9fc3`, `300f813a`; site-scope repository/snapshot browser ve Barındırma ve DNS → Yedekleme ve Geri Yükleme ekranı. Site hesabına global repository target/path veya başka sitenin snapshotı açılmaz. Yedek kapsamı, retention, depo durumu ve site snapshotları görünür.
- [ ] **BACKUP-UI-03/04:** mevcut senkron backup/restore motorunu durable job/recovery hattına taşıdıktan sonra Owner oluştur/restore eylemlerini UI'ye bağla. Gerçek Restic/browser/host kabulü ve Node24/npm11 tam check açık. [Ayrıntı](docs/ux/site-backup-manager.md).
**Güncel karar: 2026-09-23. Dal: `development`. Plesk görev düzeni korunur; reseller ilk sürümü sadeleştirilir.**

Önceki aaPanel/Plesk/CyberPanel birleşimi ve özel altı-gruplu workspace yaklaşımı iptal edilmiştir. Mevcut Ember renkleri, fontlar, radius/element biçimleri ve ortak bileşenler korunur. Neyin nerede olduğu ve nasıl yönetildiği Plesk'e taşınır; marka/CSS kopyalanmaz. Global Dosyalar ve domain File Manager girişleri kaldırılmaz.

## 2026-09-25 — PHP mutation güvenlik hazırlığı

- [x] **PHP-ACTION-01 sözleşme:** `405d3cee`, `6a14d501`; üç sabit düşük-kapsam eylem için Website revizyonuna bağlı önizleme digest/confirmation. Raw komut girişi reviewed action kataloğuna giremez; bütün önizleme alanları çalıştırma öncesi yeniden hesaplanacak şekilde doğrulanır.
- [x] **Preview/kapsam:** `47053dfc`, `6a02d83f`; PHP action preview endpoint'i eklendi. Eski raw WP-CLI/Composer run uçları site_manager'a kapatılıp Owner-only bırakıldı. **Site ekranına mutation butonu eklenmedi.**
- [x] **PHP-ACTION-02a/b durable kaynak:** `2c9c3df8`, `130b17d1`, `b8ca6443`, `26962a8a`, `aa48a67d`; reviewed action operation'ı JobRegistry/local executor'a bağlandı, terminal sonuç daraltıldı, 0600 receipt ve receipt-only packaged recovery eklendi. Receipt yoksa çalışan komut tekrar edilmez; running job unresolved kalır.
- [x] **PHP-ACTION-02c kaynak:** `8b4a1892` → `263f865c`; canlı session/site grant enqueue ve worker başında yeniden doğrulanır, Application lock queue hazırlığını serileştirir, güvenli queue cevabı actor payload'ını gizler. PHP ekranında yalnız doğrulanmış araç için preview → açık onay → durable job → aynı job takibi → terminal sonrası status refresh akışı bağlandı.
- [ ] **PHP-ACTION-02c kabul/çok-süreç:** bağımsız iki API processinin ortak JSON JobRegistry üzerinde stale state yarışı gerçek transaction olarak çözülmüş sayılmaz. Tek-yazıcı production topolojisini kanıtla veya ortak job-store lock/reload ekle; gerçek session revoke/CSRF/restart/receipt/browser/host kabulünü çalıştır. GitHub DNS nedeniyle bu turun yeni testleri koşulamadı.

## 2026-09-25 — PHP / WordPress araç durumu kaynak dilimi

- [x] **PHP-UI-01 kaynak:** `6c212843`; mevcut PHP servisinde bağ/sonuç doğrulaması, WordPress/Composer unknown ayrımı, panel `data` zarfı ve Composer durum/çalıştırma için aynı proje seçimi. CLI/hosting motoru yeniden yazılmadı.
- [x] **PHP-UI-02 kaynak:** `c1fa3725`, `1e287437`; PHP sitesinin mevcut Uygulama sekmesinde PHP / WordPress görünümü. Sürüm/eklenti/tema, 20 kayıtlık sayfa, Composer proje/kilit/doğrulama, bağımsız yenileme ve son kontrol. Mevcut node URL'si, uygulama işlemleri, Files/SSL/cron ve Ember bileşenleri korunur.
- [x] **PHP-UI-03 seçili test:** Node22.16.0/npm10.9.2 altında **83 geçti / 0 başarısız / 0 atlandı**: 39 servis/regresyon/veri-sözleşmesi + 37 istemci/model + 7 kaynak bağlantısı. Backend CLI/registry/lstat açık fixture, host-runtime importu yerel loader kabuğudur; gerçek host/auth değildir. İki JSX ve dört JS sözdizimi kontrolü; altı kaynak blob'u `1e287437` ile eşleşti. Önceki cron 83'ü yeniden koşulmadı. [Kanıt ve T-DEV-PHP-UI](docs/ux/php-tools-flow.md).
- [ ] **Kalan PHP kaynak/kabul:** PHP sürümü/FPM düzenleme, güvenli WordPress/Composer mutation job/onay/kilit akışları; Node24/npm11 tam check, gerçek API/browser/host ve canlı yetki/release yarışları. Bu salt durum dilimi tam WordPress Toolkit veya bütün PHP yönetimi değildir. Üst UX/PROD/RS kutuları açık kalır.

## 2026-09-25 — Zamanlanmış Görevler kaynak dilimi

- [x] **CRON-UI-01/02 kaynak:** `f20f0c38`, `97b6e833`; mevcut cron API'si üzerinde kapsam/revizyon doğrulayan istemci, oluştur/düzenle/sil, tek gönderim ve belirsiz sonuçta otomatik tekrar yapmama.
- [x] **CRON-UI-03/04 kaynak:** `3382652c`, `fa0accf2`; Barındırma ve DNS → Zamanlanmış Görevler, Genel Bakış kısayolu, açık form incelemesi ve görev adıyla silme onayı. Doğru job sonucu ile güncel kayıt birlikte doğrulanır. Yapılandırmanın uygulanması komutun çalıştığı anlamına gelmez. Files ve mevcut görev grupları korunur.
- [x] **CRON-UI-05 seçili kontrol:** Node22.16.0/npm10.9.2 altında **83 geçti / 0 başarısız / 0 atlandı**: 54 istemci + 17 kapsam + 12 gezinme/bağlantı. Üç JSX sözdizimi/dönüşümü ve beş JS sözdizimi kontrolü geçti; 12 kaynak/test blob'u GitHub ile eşleşti. React render/build veya gerçek HTTP/host kabulü değildir. [Kaynak, sınırlar ve T-DEV-CRON-UI](docs/ux/cron-tasks-flow.md).
- [ ] **Gerçek kabul ve kalıcılık:** Node24/npm11 tam lint/test/build, gerçek Owner/Site A/Site B API/browser/host, farklı sekme/süreç yarışları, reload sonrası bilinmeyen iş/taslak devamı. Ekran durumu bellektedir; mevcut işlem geçmişi korunur. Kök plandaki üst UX-PL-04/06/07/08, BUG-02, reseller ve production kapıları kapanmaz.

## Son kullanıcı teyidi — gerekli araçlar önce, Plesk yerleşimi

[Son yerleşim kontrolü ve kaynak raporu](docs/ux/plesk-placement-recheck-2026-09-23.md): planın görev yönü resmî Plesk belgeleriyle doğrulandı; başlangıç kodundaki eski menü, dashboard açılışı ve Diğer içine gizlenen site araçları tespit edilip `aa41cc24` / `6b755b28` ile düzeltildi. **Şimdiki öncelik UX-PL-03/04/06 görev yerleşimi ve gerçek kullanımdır; ayrı reseller/cleanup backend genişlemesi bunun önüne geçmez.** Güvenlik ve önceki açık işler iptal edilmez.

Kaynakta ana giriş Web Siteleri ve Alan Adları; sol menü Posta, Dosyalar, Veritabanları, Owner için Araçlar ve Ayarlar ve Kullanıcılar. Site görev aileleri Genel Bakış / Barındırma ve DNS / Posta; günlük araçlar açık bağlantılardır. Teknik kayıt/iş/envanter bilgisi günlük araçların yerine geçmez. Gerçek UI/API karşılığı bulunmayan yedek/istatistik/hosting formu, sırf Plesk'te var diye çalışan araç gibi gösterilmez; eksik olarak geliştirilir.

Önceki kaynak dilimi [site içinden ek alan adları](docs/ux/domain-alias-flow.md): önceki yerel paket artık `027b664f` / `e3ac0fc9` ile development dalında. Barındırma ve DNS → Alan adları içinde alias ekle/çıkar/iptal, SSL etkili önizleme, kaydetme ve tek Yayına uygula var. Aynı routing sürümünün yayın durumu taslak silinmeden yenilenir. Eski ZIP patchleri yeniden uygulanmaz; gerçek kabul T-DEV-DOMAIN-ALIASES içinde açık.

Önceki [SSL formu](docs/ux/ssl-form-flow.md) kaynak dilimi: BUG-20260923-04/05 için gerçek kullanıcı e-postası, otomatik varsayılan ile kullanıcı değişikliğinin ayrılması, kapsam kutuları ve taslak/sıfırlama bağlantısı. Kaynak `36a46185` / `96db8b9b`; ana plandaki üst BUG/UX kabulleri açık kalır. Site kartı/listesi kaynak işi de önceki `660e8162` / `deeb700c` içinde tamamlandı; kalan bütün site akışları bundan ayrı izlenir.

## Son karar — daha az reseller ekranı ve katmanı

Owner için mevcut sunucu/site araçlarına Bayiler ve Müşteriler; bayi için **Müşterilerim / Sitelerim / Hesabım** yeterlidir. Müşteri mevcut kendi-site araçlarını kullanır. Yeni dashboard veya tema, ayrı paket editörü, add-on, zorunlu abonelik seçimi, overselling ve login-as bu sürümde yapılmaz. Aynı müşteri/site listesi, basit form ve mevcut araçlar yeniden kullanılır.

Sahiplik: Owner → isteğe bağlı tek Reseller → Customer → mevcut Website. Site oluştururken önce paket/abonelik açtırılmaz. Mevcut site_manager otomatik reseller olmaz; ilişkiler ve backend yetkisi RS-02'de bağlanmadan yeni rol görünür veya kullanılabilir yapılmaz. Müşteri/site toplam adet sınırı yeterlidir; gerçek disk/mail/DB/site limitleri ayrıca korunur.

Önceki tam reseller/paket/abonelik şartı son kullanıcı kararıyla değiştirilmiştir. Ayrıntı [RS sözleşmesi](docs/ux/plesk-full-scope.md) ve [faz ayrımlı envanter](docs/plesk-feature-parity.md). Reseller dışındaki site/OS/premium yol haritası iptal değildir. Service Provider/Power User ayrımı uzun vadeli UX referansıdır; sade reseller için iki yeni yönetici paneli gerekmez.

## Okuma ve uygulama sırası

1. [Aktif plan](plan.md): kaynak alt işleri ve açık UX/BUG/PROD/PAR işleri; UX sırası bakımından yukarıdaki son teyit geçerlidir. Son PHP ve cron kaynak/kabul ayrımı bu belgenin başında, [PHP-UI](docs/ux/php-tools-flow.md) ve [CRON-UI raporunda](docs/ux/cron-tasks-flow.md) izlenir.
2. [Güncel özellik kapsamı](docs/plesk-feature-parity.md) ve [RS-00–05](docs/ux/plesk-full-scope.md).
3. [Site UX sözleşmesi](docs/ux/plesk-ux-spec.md), [resmî ekran atlası](docs/ux/plesk-reference-atlas.md) ve [rota matrisi](docs/ux/plesk-route-matrix.md). Eski reseller sınırları yerine son karar geçerlidir; son menü/rota kaynak durumu yerleşim kontrol raporundadır.
4. [Tarayıcı kabulü](docs/ux/plesk-browser-acceptance.md), [development TODO](docs/ux/development-todo.md), [T-DEV-PLESK-NAV](docs/ux/plesk-navigation-todo.md), [T-DEV-SSL-FORM](docs/ux/ssl-form-flow.md), [T-DEV-DOMAIN-ALIASES](docs/ux/domain-alias-flow.md), [T-DEV-CRON-UI](docs/ux/cron-tasks-flow.md), [T-DEV-PHP-UI](docs/ux/php-tools-flow.md) ve kök `todo.md`.

## Değişmeyen kullanım sözleşmesi

Global Dosyalar ve domain File Manager aynı yetkili siteye gider. Birden fazla site varsa seçim yapılır; açık seçilmiş kimlik bulunamadığında başka siteye düşülmez. Loading, eksik ilişki, yetki kaybı veya desteklenmeyen runtime farklı durumlardır. Ctrl+K veya terminal, görünür Files girişinin yerine geçmez.

Domain görevlerinde Dashboard / Hosting & DNS / Mail grupları ve doğrudan araç girişleri korunur. Aynı sitedeki dosya/mail/SSL işi gereksiz müşteri/paket katmanlarına taşınmaz. Siteye bağlanmış müşteri/bayi bilgisi görünür olabilir; abonelik nesnesi zorunlu değildir.

Mevcut API/kimlik/auth/CSRF/gateway/Unix izolasyonu ve kalıcı iş/onay/rollback korunur. SFTP FTP diye, Nginx Apache diye, Ubuntu Windows eşdeğeri diye sunulmaz. Sahte çalışan buton veya salt frontend yetkisi üretilmez.

## Kaynak ilerlemesi

- [x] Global `/files`, görünür Owner/site-manager menüsü ve mevcut FilesPanel rotasına güvenli giriş: `256d991f`; önceki turun 31 kaynak testi. [Rapor](docs/history/development-files-entry-2026-09-23.md).
- [x] Site Files sekmesinde görünür ve doğrulanmış erişim: `72a16712`; önceki turun 22 kaynak testi. [Rapor](docs/history/site-files-visible-access-2026-09-23.md).
- [x] Sade reseller kapsamı ve kaynak sahiplik/adet politikası: `5ac33c10`, `6efc5038`, `cd89f8d8`, `87a23c2a`; önceki turun 107 Node22 testi. Bu UI veya gerçek auth entegrasyonu değildir.
- [x] UX-PL-03a/b kaynak: Plesk görev sıralı menü, `/websites` açılışı, Owner araç dizini, rol uyumlu komut araması ve site hesabına scope'lu Posta/DB girişi; `aa41cc24`.
- [x] UX-PL-04a/06a kaynak: üç site görev ailesi, görünür DNS/Git/günlükler, araçlar önce ve teknik kimlikler ayrıntıda; `6b755b28`. Eski site URL'leri ve çalışan paneller korundu.
- [x] Önceki gezinme turunun seçili kontrolleri: 19 gezinme/model/kaynak + 20 hedef çözümleme + 10 veri-talebi testi = **49 geçti / 0 başarısız / 0 atlandı**, Node22.16.0. Bu SSL turunda tekrar çalıştırılmadı; JSX render veya tam build değildir.
- [x] UX-PL-04b.1–4 kaynak: doğrudan Dosyalar/DB/SSL/DNS/Posta/Günlükler ve barındırma/uygulama/Git araçlı site kartları; mevcut arama/alias, filtre, hiyerarşi, grup sayfalama ve yoğunluk korunur. `660e8162`, `deeb700c`; önceki tur 51 test. [Rapor ve kabul](docs/ux/website-task-cards.md).
- [x] BUG-20260923-04a/b kaynak: gerçek alan farklarına göre dirty, otomatik e-postada uyarı üretmeme, kapsam kutuları, açık sıfırlama, onaydan vazgeçince taslağı koruma, staging testinde taslağı kaydedilmiş saymama ve snapshot baseline; `36a46185`, `96db8b9b`.
- [x] BUG-20260923-05a/b kaynak: gerçek kullanıcı session'ından adres, genel ACME ayarına fallback yok, boş adres açıklaması, elle girileni ezmeyen geç varsayılan, kullanıcı/site/session generation'a bağlı form; aynı kaynak commitleri.
- [x] Önceki SSL turu: **27 geçti / 0 başarısız / 0 atlandı** (19 model + 8 kaynak bağlantısı), Node22.16.0; JSX sözdizimi/dönüşüm kontrolü de geçti. [Kanıt ve sınır](docs/ux/ssl-form-flow.md). Gerçek React/HTTP/browser/host kabulü değildir; bu alias turunda yeniden çalıştırılmadı.
- [x] UX-PL-04c/06d kaynak ve aktarım: görünür alias düzenleme, SSL etkili önizleme, kaydetme ve tek yayın eylemi; `027b664f`, `e3ac0fc9`. **49 seçili test geçti / 0 başarısız / 0 atlandı**; önceki paketin 44 testi bu sayının içindedir. İki JSX sözdizimi/dönüşüm kontrolü geçti; gerçek React/HTTP/browser/host kabulü değildir. [Rapor ve T-DEV-DOMAIN-ALIASES](docs/ux/domain-alias-flow.md).
- [ ] Hedef Node24/npm11 tam React/Vite build; gerçek tarayıcı/host kabulü; dosya yolu/taslak korunması ve bütün dosya yönetim davranışları. T-DEV-SSL-FORM dahil üst BUG-04/05 kabulü açık kalır.
- [ ] Domain/subdomain/alias görevlerinin kalan DNS/mail/SSL otomasyonu ve gerçek kabulü, hosting düzenleme, silme/askı, PHP sürüm/FPM ve mutation akışları, backup/istatistik araçları, T-DEV-CRON-UI ve T-DEV-PHP-UI gerçek kabulü. Cron ekranı ve PHP araç durumu kaynak dilimleri yukarıda tamamlandı; kart ve menü kaynağı hazır diye UX-PL-03/04/06 üst özellikleri kapanmaz. SSL süre/fingerprint senkronizasyonunun güncel kaynak ve kabul ayrımı kök `plan.md` içinde izlenir.
- [ ] RS-02–05: canlı sahiplik bağlantısı, hesap lifecycle'ı, reseller/customer self-service ve tenant izolasyonu kabulü. Owner profil API/UI alt işleri kök plandaki ilerlemesiyle korunur.

Sonraki dilimler: UX-PL-03/04/06/07 kullanıcı görevlerini tamamla → T-DEV-PLESK-NAV, T-DEV-SSL-FORM, T-DEV-DOMAIN-ALIASES, T-DEV-CRON-UI, T-DEV-PHP-UI ve Files taslak/gerçek kabul → ayrı RS-02e–05 backend/self-service bağlantıları. Ertelenmiş paket/abonelik/markalama işleri ilk sürüme sessizce geri eklenmez.

Önceki belgenin eksiksiz kopyası: [2026-09-21 UI planı](docs/history/ui-plan-before-plesk-ux-80f3d1c4.md). Arşiv güncel UX talimatı değildir.
