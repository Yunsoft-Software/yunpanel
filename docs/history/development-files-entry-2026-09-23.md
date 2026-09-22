# Development — Dosyalar girişinin geri kazanılması, 2026-09-23

Dal `development`; taban `main@1a45ded8697d640b87c149143613454fac1fa94d`. Bu dilim yalnız Files erişimi/rota/navigasyon ve kaynak testidir; canlı deployment değildir.

## Tamamlanan kaynak işleri

- [x] Owner ve mevcut yönetim yetkili site hesabına görünür `/files` menüsü.
- [x] `/files` için yalnız Website ve Domain envanteri talebi; mevcut API scope/auth korunur.
- [x] Tek site için mevcut dosya ekranına geçiş, birden fazla site için seçim.
- [x] `?site=<WebsiteID>` ile seçilmiş hedef; eski `/websites/<DomainID>/files` sözleşmesi korunur.
- [x] Hatalı/kaldırılmış seçim, duplicate kimlik, farklı server, eksik ilişki, eski veya yetkisiz veri için başka siteye otomatik düşmeme.
- [x] Desteklenmeyen runtime veya eksik ilişki için açıklama ve siteye dönüş; yeni file engine yok.
- [x] Komut aramasında Dosyalar girişi.
- [x] 31 Node model/kaynak-bağlantı testi: 31 geçti, 0 hata.

## Doğrulama sınırı

Komut: `node --test apps/web/test/files-entry-model.test.js`. Bu ortam Node v22.16.0 / npm 10.9.2 sağladı. Projenin hedef Node >=24.11.1/npm >=11 sürümü düşürülmedi; testler yalnız bu bağımlılıksız model dosyaları ve kaynak bağlantı kontrolleridir. Tam checkout/React/Vite bağımlılıkları ve ağ erişimi olmadığından npm ci, tam lint/test/build, JSX render ve gerçek tarayıcı/host kabulü yapılmadı. Kaynak bağlantı regex testi güvenlik veya tarayıcı testi değildir.

Mevcut FilesPanel, backend endpointleri, dosya worker'ı, gateway, Unix izolasyonu, CSS/font/radius, paket ve workflow dosyaları değiştirilmedi. Domain tabının yükleme/eksik ilişki sırasında kaybolması, doğrudan dosya yolu ve editör taslağı korunması gibi UX-PL-01/05/08'in kalan geniş kabulü açık.

## Açık kabul — TODO-T-FILES-ENTRY

- [ ] Hedef Node/npm ile tam lint/test/build; route ve mevcut UX kaynak testleri regresyonu.
- [ ] Gerçek Owner ve iki site_manager: sol menü → Files → doğru Website → klasör/liste/upload/edit/rename/delete. Yanlış Website/Domain ID, permission revoke, 403, stale ve reload/back/forward.
- [ ] API'nin aynı kullanıcıyla diğer Website dosyasını reddettiğini doğrula. Kaynak resolver testi backend authorization kanıtı değildir.
- [ ] Gerçek JSX/React 19 üretim bundle'ı, Chromium/Firefox, mobil/masaüstü ve klavye; global ve site Files girişleri kaybolmamalı.
- [ ] `.local/test-server.env` içindeki izinli hedefte API/web sürüm eşleşmesi; `.44` sunucusuna hiçbir bağlantı yok. Bu commit canlıya dağıtılmadı.
