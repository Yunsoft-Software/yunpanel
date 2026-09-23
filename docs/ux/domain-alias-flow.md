# UX-PL-04c / 06d — Site içinden ek alan adı yönetimi

2026-09-23; bu turun başlangıcı `development@ac08bca2`. Önceki yerel alias paketi yeniden incelendi; kaynak ve testleri artık `027b664f` ve `e3ac0fc9` ile **development dalına gönderildi**. Önceki kaynak yazım engeli bu tur yoktur. Eski ZIP patchleri tekrar uygulanmaz. Bu kayıt kaynak teslimidir; canlı dağıtım değildir.

## Plesk görev konumu

Web Siteleri ve Alan Adları → ilgili site → Barındırma ve DNS → Alan adları. Mevcut `domains` sekmesi kullanılır; bağımsız yönetici ekranı veya yeni dashboard yoktur. Günlük alias ve yayın işlemleri görünürdür; revizyon/iş kimlikleri Teknik yayın bilgileri altında kalır. DNS ve SSL/TLS bağlantıları aynı site içinde sunulur. Önceki rota matrisi SITE/DOMAIN görev konumu korunur; bu tur yeni bir Plesk sürümü veya ekranı araştırılmadı.

## Tamamlanan kaynak işleri

- [x] **UX-PL-04c.1 — `027b664f`:** alias doğrulama ve mevcut API istemcisi; ekle/çıkar için en fazla 20 ad, IDN desteği, duplicate/ana domain kontrolü. Başka site/Website/sunucu, eski revizyon veya yanlış SSL etkisi doğrulanmazsa işlem ilerlemez. Gönderilen changes yalnız aliases içerir.
- [x] **UX-PL-04c.2 — `e3ac0fc9`:** ortak bileşenlerle görünür alias listesi, taslağa ekle/çıkar, iptal, gerçek önizleme ve Kaydet. Çıkarma veya SSL bağlantısının ayrılması ana domain yazılarak onaylanır. DNS/mail hesabı veya yeni SSL otomatik oluşturulmaz.
- [x] **UX-PL-06d.1:** mevcut stage/activate job'ları kullanıcıya tek Yayına uygula eylemi olarak bağlandı. İş hedefi/kimliği ve bitişi, ardından domain kaydı kontrol edilir. Kaydedildi ile uygulandı ayrıdır. Kayıp/başarısız cevap otomatik tekrarlanmaz; güncel kayıt kontrolü gerekir ve taslak korunur.
- [x] **UX-PL-06d.2 — bu tur ek düzeltme:** aynı routing sürümünde dışarıdan tamamlanan yayın veya askı durumu artık formun yayın özetine yansır. Daha eski/farklı yönlendirme sürümü benimsenmez; kullanıcının aliases/input taslağı refresh sırasında değiştirilmez.
- [x] **Mevcut site bağlantısı:** SiteDetailPage içindeki eski DomainOperations import'u yeni bileşene taşındı (2 satır ekleme / 1 silme). Dosyanın diğer içeriği aynı; ApplicationOperations ve SslOperations eski modülden gelir. Eski export uyumluluk için durur; dosya/SSL motorları yeniden yazılmadı.
- [x] **Kaynak aktarımı ve seçili kontroller:** altı kaynak/test dosyası GitHub blob SHA'larıyla yerelde sınanan içerik bakımından eşleşti. Aşağıdaki 49 test yeniden çalıştırıldı. Önceki 44 test bu sayıya dahildir; ayrı ilerleme diye toplanmaz.
- [ ] **Üst UX-PL-04/06 ve üretim kabulü:** gerçek React/HTTP/browser/host, paylaşılan job polling iptali ve backend writer/tenant yarışları açık. Web alias yönetimi, Plesk'in bütün alias DNS/mail/SSL otomasyonunun tamamlandığı anlamına gelmez.

## Test kanıtı ve sınır

Ortam: **Node v22.16.0 / npm 10.9.2**. GitHub/npm DNS çözümlemesi bu container'da başarısız; tam checkout ve bağımlılık kurulumu yok. Projenin Node/npm gereksinimleri değiştirilmedi.

```sh
node --test apps/web/test/domain-alias-client.test.js apps/web/test/domain-alias-ui.test.js
```

**49 geçti / 0 başarısız / 0 atlandı.** İstemci/model dosyasında 40 test; UI dosyasında 1 hata mesajı davranışı ve 8 kaynak bağlantısı kontrolü. Önceki pakete göre yeni 5 kontrol yayın durumunun güvenli yenilenmesini sınar. Diğer SSL/kart/Files/reseller testleri bu tur yeniden çalıştırılmış sayılmaz.

Model ve istemci fonksiyonları gerçekten yürütüldü; API kayıtları ve job yürütücüsü kontrollü fixture'dır. Mevcut domain-registry-base.js ve shared/domain.js sözleşmesi okunarak doğrulandı fakat gerçek Domain registry, HTTP listener, cookie/CSRF/MFA veya host işlemleri testte çalıştırılmadı. DomainOperations.jsx ve SiteDetailPage.jsx hazır yerel ayrıştırıcıyla JSX'ten JS'e çevrildi; çıktılar node --check ile geçti. Bu kontrol React render, import çözümleme, Vite build veya görsel kabul değildir. Yeni dependency, TypeScript kaynak veya tema eklenmedi.

## API ve güvenlik sınırı

Mevcut POST `/domains/:id/update-preview`, PATCH `/domains/:id`, stage ve activate yolları kullanılır. Alias değişiminde backend mevcut sertifika bağlantısını ayırabilir; bu etki onaydan önce gösterilir. Sertifika dosyası silinmiş gibi sunulmaz. Kaydetme yanıtı ve tekrar okunan kayıt doğrulanmadan başarı verilmez. Yayın kaydının eşleşmesi dış DNS/HTTPS sağlığının kanıtı değildir.

Site/kullanıcı/oturum değişiminde sonraki istemci mutation adımları durur; başlamış sunucu işi iptal edilmiş sayılmaz. Mevcut ortak waitForJob döngüsü bu tur değiştirilmedi; tam polling cancellation açık kalır. İstemci içi tek-iş koruması, farklı API/CLI süreçleri için atomik backend kilidi değildir. Mevcut session/CSRF/tenant/preview/job korumaları gevşetilmedi.

## T-DEV-DOMAIN-ALIASES — gerçek ortam TODO

- [ ] Node >=24.11.1/npm >=11 tam checkout: npm ci ve npm run check; yeni iki testle beraber mevcut SSL, SiteOperations, Files ve site gezinme regresyonları. Gerçek React/Vite import/build doğrulaması.
- [ ] Owner/Site A/Site B: doğru site içinde alias ekle/çıkar/iptal, IDN, duplicate, 20 sınırı, başka site conflict, yanlış ID, stale, aktif domain/sertifika işi ve askıdaki domain. Frontend kontrolü backend yetki kanıtı değildir.
- [ ] SSL ayrılma etkisi görünür olmalı; çıkarma/SSL etkisinde ana domain onayı istenmeli. Kaydet henüz canlı yayın değildir. DNS ve posta otomatik oluşturulmamalı; gerçek DNS/HTTPS/sertifika kapsamı izinli hedefte ayrı doğrulanmalı.
- [ ] PATCH/job yanıt kaybı, başarısız stage/activate, yarım uygulama, refresh, korunmuş taslak ve çift tıklama. Başarılı bir job tek başına yeterli sayılmamalı; aynı kayıt revizyonunun uygulanması doğrulanmalı. Belirsiz sonuçtan sonra kör mutation yok.
- [ ] Aynı sürümde dışarıdan yayın/askı güncellemesi form özetine yansısın; kaydedilmemiş aliases/input değişmesin. Eski refresh yeni kaydedilmiş sürümü geri almasın. Sayfa/oturum değişimi, logout/izin iptali, browser blocker ve ortak job polling cancellation ayrıca sınansın.
- [ ] Chromium/Firefox, 320/390/834/1440 px, %200 zoom, klavye/ekran okuyucu; ortak modal, uzun alias, hata/retry, geri/ileri/reload ve bağımsız site kapsamları. Ember tema ve görünür global/site Files girişleri korunsun.
- [ ] API/web aynı build/commit üzerinde gerçek kabul kaydı. Canlı deploy yapılmadı; `.44` sunucusu hiçbir amaçla kullanılmaz. Farklı writer yarışları ve bütün tenant erişimleri mevcut RS/PROD kapılarıyla doğrulanır.

Bu liste kök todo.md ve docs/ux/development-todo.md kabullerini tamamlar; önceki açık işler korunur. plan.md ve ui-plan.md kaynak aktarımını tamamlandı olarak işaretler; gerçek kabul kutuları açık kalır. Yalnız development, küçük [skip ci] commitleri; main, Actions, canlı host ve dağıtım işlemi yoktur.
