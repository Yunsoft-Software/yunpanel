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

## T-DEV-PARITY — hedef kapsam

- [ ] Tam Plesk envanterindeki her satıra mevcut YunPanel dosya/API/servis kanıtı ve rol bazlı canlı kabul bağla; checkbox sayısından tamamlanma yüzdesi üretme.
- [ ] Marketplace envanterini vendor/version/OS/lisans ve alt özellik düzeyinde tamamla (EKL-07).
- [ ] Provider/reseller/customer/subscription/plan veri modelini migrasyon + rollback ile test et; bu tur bu işlerin implementasyonu yok.
- [ ] Açık kaynak taban seçimi ayrıca kabul edilirse, temiz izolasyonlu hedefte lisans/bağımlılık ve ortak iş senaryosu karşılaştırması yap. Aynı hostta iki panelin aynı konfigürasyonu yönetmesine izin verme; mevcut canlı siteyi deney ortamı yapma.
