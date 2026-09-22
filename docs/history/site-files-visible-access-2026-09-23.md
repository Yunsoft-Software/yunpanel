# Site Dosyalar erişimi — 2026-09-23

Dal: development. Kaynak tabanı: 256d991fa1637198b839556919cedf00021091ce. Eşzamanlı 1e81ab86 doküman değişiklikleri korunarak ilerletildi. Main değiştirilmedi.

## Uygulanan kaynak dilimi

- Global /files girişinden sonra site içi Files sekmesinin de Website yükleme/ilişki/runtime hatasında sessizce kaybolması kaldırıldı. Sekme canManage izniyle görünür; bu görünürlük yeni filesystem yetkisi vermez.
- SiteFilesPanel mevcut FilesPanel'i yalnız güncel ready Domain/Website envanteri, tekil explicit bağ, aynı server ve desteklenen runtime doğrulanınca mount eder.
- Domain ID ile Website ID ayrımı korunur. Eksik/duplicate/yanlış sunucu/unsupported/stale/forbidden durumları ayrı gösterilir; başka siteye fallback yapılmaz. Website değişiminde child key değişir.
- Owner'ın mevcut LegacyWebsiteRepair akışı korunur; yeni dosya motoru, bağımlılık, CSS/renk/radius değişimi veya backend izin gevşetmesi yoktur.

## Çalıştırılan kontrol

GitHub'dan okunmuş SiteDetailPage tabanı yerelde yeniden oluşturuldu ve git blob SHA'sı cc4df4cbe002aea2b6f749c021320de582be6fb7 ile birebir doğrulandı; yalnız dört hedef değişikliği uygulandı.

Node v22.16.0: `node --test apps/web/test/site-files-access.test.js` — **22 geçti, 0 başarısız**. Bunlar saf model ve kaynak bağlantısı testleridir; React render, tam build, API yetki veya gerçek host kabulü değildir.

## Açık kabul / Codex

Container git clone denemesi github.com DNS çözümlemesi olmadığı için başarısız oldu. Bu tur tam checkout/npm ci/üretim Node >=24.11.1/npm >=11 lint-test-build, gerçek React/browser ve host dosya işlemleri çalıştırılmadı. SSH/deploy yapılmadı, .44 hedefi kullanılmadı, GitHub Actions kullanılmadı.

- [ ] Gerçek checkout'ta hedef Node/npm ile yeni test ve önceki files-entry-model testlerini tam suite içinde çalıştır.
- [ ] Owner ve Site A/B kullanıcılarıyla /files ve /websites/<DomainID>/files reload/back/forward; direct link, loading/stale/403, eksik bağ, unsupported runtime, site/oturum değişimi kabulü.
- [ ] Dosya listele/yükle/oluştur/düzenle/rename/delete, taslak korunması, site değiştirmede eski verinin temizlenmesi ve API çapraz-site reddini gerçek izinli test hostunda doğrula.
- [ ] Yeni UI bundle/asset hash'ini doğrula; kaynak testi canlı ekran kanıtı sayılmaz. UX-PL-01 ve DOS-01 üst kabulü bu kontroller geçmeden kapanmaz.
