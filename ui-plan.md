# YunPanel — Plesk UX Geçişi

**Güncel karar: 2026-09-23. Dal: `development`. Plesk görev düzeni korunur; reseller ilk sürümü sadeleştirilir.**

Önceki aaPanel/Plesk/CyberPanel birleşimi ve özel altı-gruplu workspace yaklaşımı iptal edilmiştir. Mevcut Ember renkleri, fontlar, radius/element biçimleri ve ortak bileşenler korunur. Neyin nerede olduğu ve nasıl yönetildiği Plesk'e taşınır; marka/CSS kopyalanmaz. Global Dosyalar ve domain File Manager girişleri kaldırılmaz.

## Son kullanıcı teyidi — gerekli araçlar önce, Plesk yerleşimi

[Son yerleşim kontrolü ve kaynak raporu](docs/ux/plesk-placement-recheck-2026-09-23.md): planın görev yönü resmî Plesk belgeleriyle doğrulandı; başlangıç kodundaki eski menü, dashboard açılışı ve Diğer içine gizlenen site araçları tespit edilip `aa41cc24` / `6b755b28` ile düzeltildi. **Şimdiki öncelik UX-PL-03/04/06 görev yerleşimi ve gerçek kullanımdır; ayrı reseller/cleanup backend genişlemesi bunun önüne geçmez.** Güvenlik ve önceki açık işler iptal edilmez.

Kaynakta ana giriş Web Siteleri ve Alan Adları; sol menü Posta, Dosyalar, Veritabanları, Owner için Araçlar ve Ayarlar ve Kullanıcılar. Site görev aileleri Genel Bakış / Barındırma ve DNS / Posta; günlük araçlar açık bağlantılardır. Teknik kayıt/iş/envanter bilgisi günlük araçların yerine geçmez. Gerçek UI/API karşılığı bulunmayan yedek/istatistik/hosting formu, sırf Plesk'te var diye çalışan araç gibi gösterilmez; eksik olarak geliştirilir.

## Son karar — daha az reseller ekranı ve katmanı

Owner için mevcut sunucu/site araçlarına Bayiler ve Müşteriler; bayi için **Müşterilerim / Sitelerim / Hesabım** yeterlidir. Müşteri mevcut kendi-site araçlarını kullanır. Yeni dashboard veya tema, ayrı paket editörü, add-on, zorunlu abonelik seçimi, overselling ve login-as bu sürümde yapılmaz. Aynı müşteri/site listesi, basit form ve mevcut araçlar yeniden kullanılır.

Sahiplik: Owner → isteğe bağlı tek Reseller → Customer → mevcut Website. Site oluştururken önce paket/abonelik açtırılmaz. Mevcut site_manager otomatik reseller olmaz; ilişkiler ve backend yetkisi RS-02'de bağlanmadan yeni rol görünür veya kullanılabilir yapılmaz. Müşteri/site toplam adet sınırı yeterlidir; gerçek disk/mail/DB/site limitleri ayrıca korunur.

Önceki tam reseller/paket/abonelik şartı son kullanıcı kararıyla değiştirilmiştir. Ayrıntı [RS sözleşmesi](docs/ux/plesk-full-scope.md) ve [faz ayrımlı envanter](docs/plesk-feature-parity.md). Reseller dışındaki site/OS/premium yol haritası iptal değildir. Service Provider/Power User ayrımı uzun vadeli UX referansıdır; sade reseller için iki yeni yönetici paneli gerekmez.

## Okuma ve uygulama sırası

1. [Aktif plan](plan.md): kaynak alt işleri ve açık UX/BUG/PROD/PAR işleri; UX sırası bakımından yukarıdaki son teyit geçerlidir.
2. [Güncel özellik kapsamı](docs/plesk-feature-parity.md) ve [RS-00–05](docs/ux/plesk-full-scope.md).
3. [Site UX sözleşmesi](docs/ux/plesk-ux-spec.md), [resmî ekran atlası](docs/ux/plesk-reference-atlas.md) ve [rota matrisi](docs/ux/plesk-route-matrix.md). Eski reseller sınırları yerine son karar geçerlidir; son menü/rota kaynak durumu yerleşim kontrol raporundadır.
4. [Tarayıcı kabulü](docs/ux/plesk-browser-acceptance.md), [development TODO](docs/ux/development-todo.md), [T-DEV-PLESK-NAV](docs/ux/plesk-navigation-todo.md) ve kök `todo.md`.

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
- [x] Bu turun seçili kontrolleri: 19 gezinme/model/kaynak + 20 hedef çözümleme + 10 veri-talebi testi = **49 geçti / 0 başarısız / 0 atlandı**, Node22.16.0. Önceki testler tekrar çalıştırılmış sayılmaz; JSX render veya tam build değildir.
- [ ] Hedef Node24/npm11 tam React/Vite build; gerçek tarayıcı/host kabulü; dosya yolu/taslak korunması ve bütün dosya yönetim davranışları.
- [ ] Genişleyen domain kartları/görev zengini liste, domain/subdomain/alias üst eylemleri, gerçek hosting düzenleme ve kalan PHP/cron/backup/istatistik araçları. Menü kaynağı hazır diye UX-PL-03/04/06 üst özellikleri kapanmaz.
- [ ] RS-02–05: canlı sahiplik bağlantısı, hesap lifecycle'ı, reseller/customer self-service ve tenant izolasyonu kabulü. Owner profil API/UI alt işleri kök plandaki ilerlemesiyle korunur.

Sonraki dilimler: UX-PL-03/04/06/07 kullanıcı görevlerini tamamla → T-DEV-PLESK-NAV ve Files taslak/gerçek kabul → ayrı RS-02e–05 backend/self-service bağlantıları. Ertelenmiş paket/abonelik/markalama işleri ilk sürüme sessizce geri eklenmez.

Önceki belgenin eksiksiz kopyası: [2026-09-21 UI planı](docs/history/ui-plan-before-plesk-ux-80f3d1c4.md). Arşiv güncel UX talimatı değildir.
