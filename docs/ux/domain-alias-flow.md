# UX-PL-04c / 06d — Site içinden ek alan adı yönetimi

2026-09-23; başlangıç `development@b83ac3e7`, kapsam commit'i `a77939fc`. Plesk görev yerleşimi, görünür günlük araçlar ve mevcut Ember görsel dili korunur. Hedef Barındırma ve DNS → Alan adları içinde web alias düzenlemesidir; bağımsız Plesk alias DNS/mail senkronizasyonu değildir.

## Teslim durumu — kaynak henüz bu dalda değil

Kaynak dosyalarını yazan GitHub create_tree çağrısı araç güvenlik kontrolünde engellendi. Bu nedenle bu tur yalnız doküman commitleri repoya yazıldı. Aşağıdaki yeni kod/test dosyaları yerelde hazırlanıp test edildi; sohbet eki kaynak/patch paketindedir. **Bu belge, kodun development'a commit edildiği veya arayüzün dalda çalıştığı anlamına gelmez.** Kaynak aktarımı tamamlanana kadar üst uygulama kutusu açık kalır.

- [x] Yerel kaynak: `domain-alias-model.js` ve `domain-alias-client.js`; ek ad doğrulama, 20 alias sınırı, gerçek API sözleşmesine uygun preview/PATCH payload'ı, hedef/revizyon/SSL etkisi doğrulama, kayıt sonrası yeniden okuma ve tüketilen onayın tekrar kullanılamaması.
- [x] Yerel kaynak: `DomainOperations.jsx`; mevcut ortak bileşenlerle alias listesi, taslağa ekle/çıkar, iptal, SSL etkili onay, Kaydet ve ayrı Yayına uygula; teknik bilgiler ayrıntıda. Mevcut SiteDetailPage import'unun iki satırlık değişikliği patch paketindedir. Route ve Files/SSL bileşenleri değiştirilmez.
- [x] Yerel kaynak: aynı stage/activate job API'leriyle tek Yayına uygula eylemi; iş kimliği/hedefi, aşama sonucu ve kayıt revizyonu kontrolü. Başarısız/kayıp cevap otomatik tekrarlanmaz; kısmi sonuç ve yeniden okuma görünür. Yeni kalıcı backend workflow'u değildir.
- [x] Yerel kontroller: **44 geçti / 0 başarısız / 0 atlandı**, Node22.16.0/npm10.9.2. 37 model/istemci davranışı, 7 JSX kaynak bağlantısı kontrolü. Yeni JSX sözdizimi ve JavaScript dönüşümü kontrolü geçti.
- [ ] Kaynak ve testlerin development dalına uygulanması/commit edilmesi. Sohbet paketindeki 01/02/03 patchleri kullanmadan önce güncel dalı ve çakışmaları incele; force push veya main değişikliği yapma. Kaynak aktarımı olmadan UX-PL-04c/06d tamamlandı sayılmaz.
- [ ] Hedef Node24/npm11 tam proje check, gerçek React/Vite, API/oturum/browser/host kabulü ve kalan Plesk alias özellikleri.

## Mevcut API ve etki sınırı

`domain-http.js`: POST `/domains/:id/update-preview`, PATCH `/domains/:id`. PATCH yalnız changes/previewDigest/confirmation alır; bu istemci yalnız `changes.aliases` gönderir. Preview planı ve PATCH `{domain, impact, previewDigest}` yanıtı ayrıdır. `domain-registry-base.js`, alias değişiminde mevcut sertifika bağlantısını ayırır ve yeni kayıt revizyonunu henüz yayına uygulamaz. Bu etki kullanıcı onayından önce görünürdür; sertifika dosyası silinmiş gibi sunulmaz. DNS, posta alan adı, SSL issuance veya yeni Website otomatik oluşturulmaz.

Kaydetme doğrulanınca yalnız kayıt başarısı gösterilir. Yayına uygula, mevcut job motorunu çağırır ve son kayıt durumunu yeniden okur; bu sonuç tek başına dış DNS veya HTTPS sağlığının kanıtı değildir. Farklı kullanıcı/site/session generation'da sonraki mutation adımları durur. Önceden başlamış sunucu işi iptal edilmiş sayılmaz; mevcut paylaşılan waitForJob okuma döngüsünün cancellation davranışı ayrıca kabul bekler.

## Test kapsamı

`node --test apps/web/test/domain-alias-client.test.js apps/web/test/domain-alias-ui.test.js`

Gerçek yeni model ve istemci fonksiyonları çalıştırıldı. API kayıtları ve job yürütücüsü kontrollü fixture'dır; gerçek domain registry, HTTP listener, cookie/CSRF/MFA veya host işlemi çalıştırılmadı. JSX kaynak kontrolleri gerçek React render değildir. Ortamdaki hazır JSX dönüştürücüsü yalnız sözdizimi kontrolü içindir; repo dili/dependency değişmedi. Tam checkout/bağımlılıklar alınamadı (container GitHub DNS çözümlemesi başarısız). Önceki SSL/kart/reseller testleri bu 44'e eklenmedi ve yeniden çalıştırılmış sayılmaz.

## T-DEV-DOMAIN-ALIASES — aktarım sonrası kabul

- [ ] Node >=24.11.1/npm >=11: npm ci ve npm run check; eski SiteOperations SSL/Application davranışı, site kartı/menü/Files testleriyle birlikte gerçek import/build doğrulaması.
- [ ] Owner/Site A/Site B: doğru site içinden alias ekle/çıkar/iptal; IDN, duplicate, 20 sınırı, başka site adı conflict, stale, aktif domain/sertifika job'u ve askıdaki domain.
- [ ] SSL bağlantısının ayrılması önizlemede açık olmalı; çıkarma/SSL etkisinde ana alan adı onayı gerekmeli. Kaydet henüz canlı yayın değildir. DNS/posta otomatik oluşmamalı; gerçek HTTPS ve sertifika kapsamı ayrıca doğrulanmalı.
- [ ] Kaybolan PATCH/job cevabı, başarısız stage/activate, yarım uygulama ve yeniden okuma: tekrar kör mutation yok, taslak sessiz kaybolmaz, başka siteye düşmez. Aynı iş iki kez uygulanmaz. Yerel istemci kilidi süreçler arası atomik backend kilidi değildir.
- [ ] Site/oturum değişimi, logout/izin iptali, sayfadan ayrılma, gerçek browser blocker ve job polling cancellation. Client ara kontrolü tüm API/job/gateway tenant kabulünün yerine geçmez.
- [ ] Chromium/Firefox, 320/390/834/1440 px, %200 zoom, klavye ve ekran okuyucu; ortak modal, uzun alias, hata/retry ve bağımsız site akışları. Ember tema ve global/site Files girişleri korunur.

Kök todo.md ve docs/ux/development-todo.md içindeki önceki kabul kapıları korunur. `.44`, main, GitHub Actions ve canlı deploy kullanılmadı. Bu tur kod yazım engeli açıkça kaydedildi; kod yapılmış veya dağıtılmış gibi işaretlenmedi.
