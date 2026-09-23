# Plesk yerleşimi — son kullanıcı teyidi ve uygulama kaydı

2026-09-23; kaynak tabanı `development@bc5f0d40`. Plan teyidi `aea72899`; ana gezinme `aa41cc24`; site görev grupları `6b755b28`. Kullanıcı yeniden açıkça istedi: günlük işlerin yeri, menüsü ve işleyişi Plesk gibi olacak; teknik/gereksiz ayrıntılar önde, gerekli araçlar gizli olmayacak. Yeni tema veya backend motoru kurulmadı.

## Doğrulama sonucu

`plan.md` A bölümü, `ui-plan.md`, `plesk-ux-spec.md` ve `plesk-route-matrix.md` hedef olarak doğru yöndedir. **Başlangıç kodu bu hedefe uygun değildi.** `/` dashboard açıyordu; menü Günlük kullanım / Kaynaklar / Sistem düzenindeydi; site DNS/Git/günlükleri Diğer içindeydi; provisioning recovery günlük araçların önündeydi; site ayarları kayıt kimlikleriyle başlıyordu. Bu kaynak dilimi aşağıdaki farkları düzeltti; bütün Plesk UI/iş akışı bitmiş değildir.

## Plesk kaynakları

1. [The Plesk GUI](https://docs.plesk.com/en-US/obsidian/administrator-guide/70562/): Power User'da host yönetimi Tools & Settings; Customer Panel site/mail/içerik odaklı. Power User ve Service Provider aynı görünüm değildir.
2. [Plesk Tutorial](https://docs.plesk.com/en-US/obsidian/quick-start-guide/plesk-tutorial.74376/): domain → File Manager; global Databases ve Mail; domain kartı Hosting & DNS → DNS; Dashboard → Backup & Restore; üst kullanıcı menüsünden profil.
3. [Managing Web Hosting](https://docs.plesk.com/en-US/obsidian/quick-start-guide/plesk-functionality-explained/managing-web-hosting.74401/) ve [General Settings](https://docs.plesk.com/en-US/obsidian/administrator-guide/website-management/websites-and-domains/hosting-settings/general-settings.72050/): domain altında Hosting & DNS → Hosting.

Doğrulama görev konumlarına aittir. Eski ekran görüntüsü 2026 canlı build kanıtı değildir; bütün sürüm/edition/extension ekranları sınanmadı. Sade reseller kararı korunur: kullanıcı/bayi için ayrı paket/abonelik önkoşulu üretilmez; bu model Plesk Power User'ın birebir özelliği diye adlandırılmaz.

## Tamamlanan kaynak alt işleri

- [x] **UX-PL-03a — `aa41cc24`:** `/` → `/websites`; Owner sol menüsünde Web Siteleri ve Alan Adları, Posta, Dosyalar, Veritabanları, Araçlar ve Ayarlar, Kullanıcılar. Yeni araç dizini mevcut sunucu/Docker/ayar/envanter/denetim ekranlarına gider. Eski URL'ler korunur. Görünüm tercihleri başlangıçta kapalıdır; değerler ve bileşen silinmedi. Komut araması gerçek Owner bağlamını kullanır ve Owner araçlarını site hesabına önermez.
- [x] **UX-PL-03b — `aa41cc24`:** site hesabının global Posta/DB girişi Owner konsolu yerine mevcut site aracına gider. Ready envanter, tekil Website/Domain, aynı sunucu ve açık ilişki doğrulanır. Tek siteye ait çok domain de seçim ister; yanlış/boş explicit kimlik başka siteye düşmez. Eksik ilişki görünürdür. `/websites` veri talebine eksik Website envanteri eklendi.
- [x] **UX-PL-04a/06a — `6b755b28`:** site içinde Genel Bakış, Barındırma ve DNS, Posta aileleri. Alt araçlar gizli Diğer menüsü değil açık, sarılabilir bağlantılardır. Genel bakışta Dosya Yöneticisi/DB/SSL/runtime/Git/günlük/DNS/Posta araçları önce; recovery kaldırılmadan aşağıda. Hosting ailesi mevcut DNS, barındırma bilgisi, alan adı yönetimi ve terminale gider. Kayıt kimlikleri teknik ayrıntıda kalır.
- [x] **Seçili model/kaynak kontrolleri:** 49 geçti / 0 başarısız / 0 atlandı; Node22.16.0/npm10.9.2. Komut aşağıdadır. Son kaynak hali tekrar çalıştırıldı; önceki Files/removal/reseller testleri bu toplama katılmadı.
- [ ] **Üst UX-PL-03/04/06 kabulü açık:** gerçek React/HTTP/tarayıcı/host; genişleyen domain kartı ve tüm create/edit/return akışları; gerçek hosting düzenleme, PHP/cron/backup/istatistik araçları. Bu tur Website listesinin tablosu yeniden yazılmadı. `/settings` site sekmesindeki Barındırma bilgileri bir hosting düzenleme formu değildir.

```sh
node --test apps/web/test/plesk-navigation.test.js apps/web/test/site-tool-entry-model.test.js apps/web/test/workspace-resources.test.js
```

19 Plesk gezinme/model/kaynak testi, 20 site aracı hedef çözümleme testi ve 10 veri-talebi regresyonu. Dört JS kaynak ve üç JS test dosyası `node --check` ile geçti. JSX yalnız metin bağlantıları açısından incelendi; gerçek parser/render/build çalıştırılmış değildir. Ortamda GitHub/npm DNS erişimi olmadığından tam checkout ve bağımlılıklar alınamadı. Node24/npm11 `npm run check`, gerçek API/oturum/CSRF/MFA/host/browser kabulü açık.

## Korunan davranış ve sınırlar

FilesPanel, FilesPage, gateway ve dosya motoru değiştirilmedi. SiteFilesPanel'in doğrulanmış Domain→Website girişi, eski `/resources`, site terminali, uygulama seçimi ve mevcut işlem/onarım bileşenleri korunur. Sadece gezinme değişikliği tenant izolasyonu veya canlı servis sağlığının yeni kanıtı değildir. Eski `/mail/:mailDomainId` yolu ve backend guard'lar değiştirilmedi; tüm doğrudan yollar gerçek kabulde ayrıca sınanmalıdır.

Boş Backup CapabilityPage ve olmayan istatistik/PHP/cron ekranları çalışan araç olarak menüye eklenmedi; bunlar açık iştir, kapsamdan çıkarılmadı. Ember tokenları, renk/font/radius ve backend izinleri değiştirilmedi. Yeni CSS yalnız görev gezinmesinin sarılma/boşluk yerleşimini düzenler; responsive görünüm henüz gerçek tarayıcıda doğrulanmadı.

## Öncelik ve devir

**Güncel sıra: UX-PL-03/04/06 yerleşimini ve görev akışlarını tamamla; sonra ayrı reseller/cleanup backend genişlemesine dön.** Önceki RS/BUG/PROD işleri silinmez ve güvenlik kabulü gevşetilmez. Kaynak kutusu canlı başarı değildir.

Yeni kabul eki [T-DEV-PLESK-NAV](plesk-navigation-todo.md); mevcut `docs/ux/development-todo.md` ve kök `todo.md` geçerliliğini korur. Küçük commit, development ve `[skip ci]`; main/Actions/canlı host işlemi yok. `.44` hiçbir amaçla kullanılmadı.
