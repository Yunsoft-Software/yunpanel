# T-DEV-PLESK-NAV — gerçek React/host kabulü

2026-09-23; `development`, kaynak commitleri `aa41cc24` ve `6b755b28`. Bu ek, kök `todo.md` ve `docs/ux/development-todo.md` yerine geçmez. Önceki Files, reseller, silme ve production kabulleri açık kalır. `.44` hiçbir amaçla kullanılmaz; bu tur hiçbir canlı hosta bağlanılmadı.

## Burada yapılan kontrolün sınırı

Node v22.16.0/npm 10.9.2 ile 49 seçili test geçti; JSX bağlantıları kaynak metni üzerinden denetlendi. React render, Vite, tam lint, cookie/CSRF/MFA, API yetkilendirmesi veya host işlemi çalıştırılmış değildir. GitHub/npm DNS erişimi olmadığından tam checkout ve bağımlılıklar alınamadı. Dört JS kaynak ve üç JS test dosyası `node --check` ile geçti; bu JSX parser değildir. Önceki 31/22 Files ve 70 removal testleri bu tur yeniden çalıştırılmış sayılmaz.

## Codex / gerçek ortam kontrolleri

- [ ] Node >=24.11.1/npm >=11 tam checkout: `npm ci`, `npm run check`. `plesk-navigation.test.js`, `site-tool-entry-model.test.js`, güncellenen `workspace-resources.test.js` ve mevcut Files/site/UI testleri birlikte geçsin. Eski nav metnine bakan testleri yeni sözleşmeye uyarlarken gerçek davranış kontrollerini kaldırma. Yeni paket veya backend motoru gerekmiyor.
- [ ] Üretim bundle'ında `/` → `/websites`. Reload/deep-link/back/forward: `/tools-settings`, `/settings/users`, `/files`, `/mail`, `/databases` ve bütün eski site sekmeleri. Web server'ın SPA fallback/auth yönlendirmesi de sınansın; yalnız router kaynağı yeterli değil.
- [ ] Owner menüsü: Web Siteleri ve Alan Adları → Posta → Dosyalar → Veritabanları → Araçlar ve Ayarlar → Kullanıcılar. Dashboard/Docker/uygulama envanteri/denetim erişimi araç merkezinde kaybolmasın. Araç merkezindeki DNS/güncelleme/hesap linkleri gerçek alt sayfayı açsın. Olmayan istatistik veya backup placeholder'ı çalışan araç gibi eklenmesin.
- [ ] Site A / Site B hesapları: global Posta ve Veritabanları Owner konsolunu mount etmesin; mevcut site paneline doğru Domain ID ile gitsin. Tek site, çok site, tek Website'e bağlı birden fazla domain, eksik bağ, yanlış/boş `?site=`, duplicate, farklı server, 401/403, stale ve oturum değişimi. Eski `/mail/:mailDomainId` dahil doğrudan API/URL yetkisi ayrıca doğrulansın; yeni seçici bütün eski erişim yollarının güvenlik denetimi değildir.
- [ ] Site grupları Genel Bakış / Barındırma ve DNS / Posta. Dosya/DB/SSL/runtime/Git/günlükler ve DNS/hosting/alan adı/terminal görünür konumlarından açılıp geri dönülsün. `/resources` eski DB girişi çalışsın. Desteklenmeyen veya yüklenmeyen hedef başka siteye düşmesin; mevcut mail/DB runtime/loading boşlukları tamamlanmış sayılmasın.
- [ ] Genel bakış: araçlar uzun provisioning bilgisinden önce; başarısız provisioning/hata mesajı hâlâ görülebilir. Site ayarlarında kayıt kimliği değil anlaşılır barındırma bilgisi önce. Barındırma bilgisi ekranı düzenleme formu diye sunulmasın; gerçek hosting düzenleme açık kaynak işidir.
- [ ] 320/390/834/1440 px, %200 zoom, açık/koyu tema, Chromium/Firefox, klavye ve ekran okuyucu: üç aile ile alt araçlar sarılsın, yatay taşma/örtüşme olmasın; aktif aile/araç belirgin olsun. Ember renk/font/radius/focus kontrastı korunsun. CSS kaynak kontrolü gerçek ekran kanıtı değildir.
- [ ] Global menü/mobil focus trap, Escape, Ctrl+K, AI ve iş çekmecesi, kaydedilmemiş dosya/form taslağı, uygulama seçimi query'si, geri/ileri ve logout. Görünüm tercihleri varsayılan kapalıdır ama değerleri/klavye erişimi korunmalıdır. Önceki UX-PL-01f taslak kaybı işi bu tur kapanmadı.

## Sıradaki açık UX kaynak işleri

- [ ] UX-PL-04: Plesk'e yakın genişleyen domain kartları veya eşdeğer görev zengini liste; domain/subdomain/alias üst eylemleri ve mevcut arama/filtre/sayfalama korunarak direkt araçlar. Bu tur mevcut WebsitesPage tablosu yeniden yazılmadı.
- [ ] UX-PL-05/06/07: gerçek hosting/PHP/cron/backup/istatistik girişlerinin mevcut API'lerle tamamlanması; teknik apply/revision adımlarının kullanıcı görevine çevrilmesi. Sadece gezinmenin taşınması bu işlevleri tamamlamaz.
- [ ] Aynı API/web commit ve asset kimliğiyle gerçek kabul kaydı. Kaynak commit'i deploy edilmiş sayılmaz; kaynak alt kutuları üst UX/production kutularını kapatmaz.
