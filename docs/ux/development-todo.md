# Development — gerçek ortam ek TODO

Bu dosya kök `todo.md` ve T-PL kabul listesini tamamlar; eski açık kabulleri kaldırmaz. Aktif dal `development`. `.44` Plesk hostu her amaçla yasak; yalnız `.local/test-server.env` içindeki izinli hedef teyit edilerek kullanılabilir.

## T-DEV-FILES — 256d991f ve 72a16712 kaynak sonrası

Kaynak kanıtı: `docs/history/development-files-entry-2026-09-23.md` ve `docs/history/site-files-visible-access-2026-09-23.md`. Global giriş ve site sekmesinin görünürlüğü kaynakta uygulandı. Node22 model/kaynak testleri gerçek dosya işlemi veya React render kabulü değildir.

- [ ] Node >=24.11.1/npm >=11 ile gerçek checkout'ta npm ci ve tam lint/test/build. `files-entry-model.test.js` ve `site-files-access.test.js` dahil olsun. Bu ortamın Node22 model testleri hedef sürümün veya JSX/React'in yerine geçmez.
- [ ] Chromium/Firefox üretim bundle'ında Owner ve iki site_manager: global Dosyalar menüsü ve mevcut domain File Manager. Tek site otomatik geçişi, çok site seçimi, `?site=<WebsiteID>` ve eski Domain-ID rota farklılığı.
- [ ] 403/401/500, yavaş/stale veri, eksik ilişki, yanlış/duplicate/site silinmiş ID, izin iptali. Yanlış hedef başka siteye düşmemeli; backend diğer siteye erişimi bağımsız reddetmeli. 72a16712 sonrasında site Files sekmesi bu durumlarda kaybolmamalı; gerçek neden/retry görünmeli ve doğrulanmayan FilesPanel mount edilmemeli.
- [ ] Gerçek site kullanıcısıyla liste/klasör/upload/create/edit/rename/delete/download, symlink/path izolasyonu. Bu tur mevcut file engine değişmedi ama girişten uçtan uca erişim kanıtlanmalı.
- [ ] Reload/back/forward, globalden siteye geçiş, dosya yolu/taslak, mobil/klavye, uzun liste. Özellikle manuel/arka plan refresh, stale→ready, site/oturum değişimi ve yetki iptalinde kaydedilmemiş editör içeriğinin sessiz kaybı veya başka siteye taşınması olmamalı. Gerekli draft koruma kaynak işi UX-PL-01f/08'de açıktır; görünür sekme tek başına kabul değildir.
- [ ] Yalnız izinli hostta API/web build kimliği ve asset tazeliği; bu kaynak commit'i dağıtılmış sayılmaz. UX-PL-01/DOS-01 üst kutuları gerçek kabul geçmeden kapanmaz.

## T-DEV-RESELLER — RS-01 kaynak sonrası (cd89f8d8 / 87a23c2a)

Kaynak kapsamı ve kalan kod: `docs/ux/plesk-full-scope.md` RS-02–05. Yalnız iki saf politika modülü ve testleri eklendi; **mevcut auth rolleri, DB şeması, router, UI ve host değiştirilmedi.** İlk sürüm için paket/abonelik motoru kurulmaz.

- [ ] Node >=24.11.1/npm >=11 gerçek checkout'ta `npm ci` ve `npm run check`. `node --test apps/api/test/reseller-scope.test.js apps/api/test/reseller-limits.test.js` yeniden çalıştırılsın. Yerel Node22 koşusu 107/107 geçti; tam depo veya hedef sürüm kanıtı değildir.
- [ ] RS-02 kodu: mevcut auth/user/Website depolarına sürümlü, küçük ilişki katmanı; idempotent migration + geri dönüş. Eski ID/Unix kullanıcı/sertifika ve site_manager erişimleri korunsun. Aynı kullanıcı için ayrı login deposu kurulmasın.
- [ ] RS-02/03 kodu: actor/hesap/site/usage yalnız güncel depodan yüklensin; request body, rol etiketi veya sayfalanmış UI listesi yetki/kullanım kaynağı olmasın. Site toplamı bayinin bütün müşterilerini ve askıdaki kayıtları kapsasın.
- [ ] Limit dolmadan iki paralel create: check + insert aynı transaction/kilit içinde; yalnız izin verilen sayı başarılı. Parent askıya alma, müşteri/site ekleme ve limit azaltma yarışları da sınansın. Saf helper bu yarışları çözmüş değildir.
- [ ] RS-03/04 kodu: basit hesap API'si, server-side filtreleme, mass-assignment/rol/parent/transfer engeli, revizyon, audit, bağlı kaynakta silme engeli; mevcut liste/form/site UI'sine bağlama. Reseller'ın kendi limitini veya Owner hesabını değiştirme yolu olmasın.
- [ ] Owner, iki bayi, her bayide iki müşteri ve doğrudan Owner müşterisiyle API/list/job/log/AI/Files/DB/backup/tool/gateway/WebSocket tenant izolasyonu. Rol, müşteri veya bayi askıya alma ardından mevcut oturum ve açık bağlantılar yeniden yetkilendirilsin/iptal edilsin.
- [ ] Gerçek tarayıcı: Owner Bayiler/Müşteriler; bayi Müşterilerim/Sitelerim; müşteri kendi site araçları. Files iki girişi, hata/retry, reload/back, yanlış ID ve oturum değişimi. Paket/abonelik açtırılmasın; henüz bağlanmamış eylem çalışıyor gösterilmesin.
- [ ] Entegrasyon/test bitmeden reseller login'i açma ve production'a dağıtma. Sonucu güncel commit/build kimliğiyle kaydet; kaynak testini canlı kabul sayma.

## T-DEV-PARITY — korunmuş uzun vadeli kapsam

- [ ] Envanterdeki satırlara mevcut YunPanel dosya/API/servis kanıtı ve rol bazlı canlı kabul bağla; checkbox sayısından tamamlanma yüzdesi üretme. Sade reseller için RS-00–05 geçerli; tam paket/abonelik/overselling/markalama sonraki fazdır ve MVP engeli değildir.
- [ ] Marketplace envanterini vendor/version/OS/lisans ve alt özellik düzeyinde tamamla (EKL-07); ilk reseller uygulamasına araştırma önkoşulu yapma.
- [ ] Sade Owner→isteğe bağlı Reseller→Customer→Website modelinin migration/rollback kabulü yukarıdaki T-DEV-RESELLER'de; tam provider/subscription/plan hattını ayrı sonraki faz olarak tut.
- [ ] Açık kaynak taban seçimi ayrıca kabul edilirse, temiz izolasyonlu hedefte lisans/bağımlılık ve ortak iş senaryosu karşılaştırması yap. Aynı hostta iki panelin aynı konfigürasyonu yönetmesine izin verme; mevcut canlı siteyi deney ortamı yapma.
