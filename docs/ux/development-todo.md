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

## T-DEV-RESELLER — RS-02a/b/c kaynak sonrası (ca40a2ae / 524b0627 / e1bd0edb)

Kaynak kapsamı ve kalan kod: `docs/ux/plesk-full-scope.md` RS-02–05; kanıt `docs/history/reseller-auth-storage-2026-09-23.md`. Aynı auth DB içinde sürümlü profil/limit deposu ve mevcut kullanıcı deposu bağlantısı eklendi. **Yeni login rolü, HTTP/UI veya Website provisioning bağlantısı açılmadı; hostta migration/deploy yapılmadı.** İlk sürüm için paket/abonelik motoru kurulmaz.

Bu tur seçili kaynaklar ve gerçek SQLite üzerinde 97 geçti / 0 başarısız / 1 atlandı (Node22.16.0). Son müşteri kontenjanına iki bağımsız bağlantı testi geçti; ayrıca 5 tekrar başarılı. Bu sonuç native auth/HTTP/host kabulü değildir; kaynak kodu işleri planda işaretlidir, aşağıdaki gerçek kabul kapıları açıktır.

- [ ] Node >=24.11.1/npm >=11 gerçek checkout'ta `npm ci` ve `npm run check`. Yeni `node --test apps/api/test/hosting-account-*.test.js apps/api/test/user-admin-store.test.js` ile önceki `reseller-scope.test.js` / `reseller-limits.test.js` yeniden çalıştırılsın. Tam depo/JSX build burada çalıştırılmadı.
- [ ] Özellikle `hosting-account-native-auth.test.js` hedef Node'da **atlamadan** geçsin: gerçek Argon2 setup/login, profil bağlamada eski oturum iptali, Owner oturumunun korunması ve yeni girişin site_manager + boş site kapsamı olarak kalması. Test Node22'de native Argon2 yokluğundan bilinçli atlandı; shim kullanıp native auth geçti denmesin. Gerçek MFA/challenge, uzun bağlantılar ve mevcut auth/login/user-admin testleriyle birlikte doğrula.
- [ ] İzinli test hedefinin doğrulanmış auth yedeğinde yeni yan şemanın ilk açılışı, ikinci açılışı ve geri dönüşü; eski users/ID/parola/MFA/session/Website üyelikleri korunmalı. Boş şema rollback'i yerelde geçti; veri içeren migration/rollback ayrıca tasarlanıp test edilmeli. Profil mevcut site_manager üyeliklerinden otomatik üretilmesin. İkinci login deposu kurulmasın.
- [ ] RS-02 kalan Website state/provisioning kilidi ve sahiplik bağlantısı: actor/hesap/site/usage güncel depodan yüklensin; request body veya sayfalanmış liste kaynak olmasın. `registered_ownership` sayımı tüm host sitelerinin ölçümü diye sunulmasın. Gerçek site kotası, site ekleme/silme/başarısız provisioning/restart durumlarıyla sınansın.
- [ ] API/host entegrasyonu sonrasında son kontenjana paralel müşteri/site create, parent suspend ve limit azaltma yarışları; check + insert aynı transaction/kilitte. Yerel müşteri-profili yarış testi geçti ama Website ve lifecycle yarışlarının yerine geçmez.
- [ ] RS-03/04 API/UI sonrası: server-side filtreleme, mass-assignment/rol/parent/transfer engeli, revizyon, audit ve bağlı kaynakta silme engeli. Genel `/api/users` üzerinden profilli hesapta rol/active/site grant/silme bypass denemeleri kontrollü hata vermeli; normal parola/isim ve profilsiz kullanıcılar çalışmalı. Reseller kendi limitini veya Owner hesabını değiştirememeli.
- [ ] Owner, iki bayi, her bayide iki müşteri ve doğrudan Owner müşterisiyle API/list/job/log/AI/Files/DB/backup/tool/gateway/WebSocket tenant izolasyonu. Rol, müşteri veya bayi askıya alma ardından mevcut oturum ve açık bağlantılar yeniden yetkilendirilsin/iptal edilsin. Kayıt transaction'ında audit veya MFA iptal hatası yarım kayıt bırakmamalı.
- [ ] Gerçek tarayıcı: Owner Bayiler/Müşteriler; bayi Müşterilerim/Sitelerim; müşteri kendi site araçları. Files iki girişi, hata/retry, reload/back, yanlış ID ve oturum değişimi. Paket/abonelik açtırılmasın; henüz bağlanmamış eylem çalışıyor gösterilmesin.
- [ ] Entegrasyon/test bitmeden reseller login'i açma ve production'a dağıtma. Sonucu güncel commit/build kimliğiyle kaydet; kaynak testini canlı kabul sayma. Şema/legacy geçiş korumalarını bütün erişim yolları bağlanmadan kaldırma.

## T-DEV-PARITY — korunmuş uzun vadeli kapsam

- [ ] Envanterdeki satırlara mevcut YunPanel dosya/API/servis kanıtı ve rol bazlı canlı kabul bağla; checkbox sayısından tamamlanma yüzdesi üretme. Sade reseller için RS-00–05 geçerli; tam paket/abonelik/overselling/markalama sonraki fazdır ve MVP engeli değildir.
- [ ] Marketplace envanterini vendor/version/OS/lisans ve alt özellik düzeyinde tamamla (EKL-07); ilk reseller uygulamasına araştırma önkoşulu yapma.
- [ ] Sade Owner→isteğe bağlı Reseller→Customer→Website modelinin migration/rollback kabulü yukarıdaki T-DEV-RESELLER'de; tam provider/subscription/plan hattını ayrı sonraki faz olarak tut.
- [ ] Açık kaynak taban seçimi ayrıca kabul edilirse, temiz izolasyonlu hedefte lisans/bağımlılık ve ortak iş senaryosu karşılaştırması yap. Aynı hostta iki panelin aynı konfigürasyonu yönetmesine izin verme; mevcut canlı siteyi deney ortamı yapma.
