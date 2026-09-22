# YunPanel — Gerçek Ortam / Kabul TODO

Bu dosyada yalnız kaynak testleriyle güvenilir biçimde tamamlanamayacak gerçek Ubuntu, package, browser, DNS/provider, mail delivery, storage ve rollback kabulleri tutulur. Kod işleri `plan.md`, hedef mimari `docs/architecture.md`, bağlayıcı kurallar `agents.md` içindedir.

IP adresi `.44` ile biten Plesk sunucusu kesinlikle kapsam dışıdır. Bütün SSH/package/deploy testleri yalnız repo dışı `.local/test-server.env` içindeki açık YunPanel test sunucusunda, hedef adresin `.44` olmadığı doğrulandıktan sonra yapılır. Secret/parola/cookie/MFA/private key ekran görüntüsü, rapor, log veya repoya yazılmaz.

## T-DB-UI — 2026-09-22 canlı veritabanı ve yetki kabulü (Antigravity)

- [ ] `.local/test-server.env` hedefinin `.44` olmadığı doğrulandıktan ve kod güvenli dağıtıldıktan sonra Owner ile `/databases` yenile: mevcut `roundcube` ve varsa `roundcube_*`/`roundcubemail*` satırı, toplam adet/boyut ve silme/backup/restore seçimlerinde görünmesin; doğrudan API istekleri reddedilsin, fiziksel altyapı şeması varlığını ve Roundcube oturumunu korusun. Bu turdaki kaynak testleri canlı sunucu doğrulaması değildir.
- [ ] Bağımsız ana Website yaratma/yenileme: site-admin e-posta/parola, mail ve MySQL kimlikleri ayrı; site-admin silme site yaşarken API'de de 409; Owner e-posta/parola düzenleyebilsin; site-admin başka Website'in DB/phpMyAdmin içeriğine erişemesin, kendi DB credential rotasyonu ve grant uygulaması canlı hostta çalışsın. Önceden var olan Website migrasyonu ve rollback veri kaybı olmadan gözlensin.
- [ ] Yeni ana site için local DNS, mail ve shared Roundcube webmail/SSL adımlarını gerçek hostta yarat, başarılı/blocked/partial/failure progress ve API yeniden giriş sonrası state'i tarayıcıda doğrula. Subdomain/alias yeni zone/mail/Roundcube kurmasın. Dış NS delegation, SMTP/IMAP teslimi, webmail oturumu ve sertifika erişimi ayrı doğrulansın. Hata enjeksiyonuyla üçüncü otomatik denemede durma, manuel retry, restart/idempotency ve compensation kanıtlansın.
- [ ] Owner kurtarma mailiyle tek kullanımlık reset, expired/used token, eski oturum iptali, rate-limit ve olmayan adres için aynı yanıt gerçek mail tesliminde doğrulansın; SMTP yokken başarı mesajı verilmesin. SSL formunda etkin kullanıcı e-postası gelsin, genel ACME varsayılanı ayrı kalsın; secret/URL/audit sızıntısı olmasın.

## T-VISUAL — 2026-09-22 tarayıcı görsel kabulü (Antigravity)

- [ ] Açık `/dashboard`, `/settings`, `/databases`, `/websites/new` sekmeleri ile kaynak sonrası Chromium/Firefox karşılaştırması yap: Ayarlar sekmeli/deep-link'li ve yalnız düzenlenebilir değerler içerir; mimari/sürüm bilgisi Sunucu > Tanılama'dadır. `[object Object]` yoktur, bilinmeyen servis hazır görünmez; servis ve terminal yalnız Sunucu, İşlemler/Denetim Ayarlar/Tanılama erişiminde bulunur.
- [ ] Genel bakışta Website listesi kaldırılıp sayısı/linki yerleşir; CPU/RAM/disk halkaları gerçek yüzdeyi doğru yay ve erişilebilir metinle yansıtır. 0, bilinmiyor, 91%, hata ve yüksek doluluk durumlarını; mobil, klavye, ekran okuyucu, reduced-motion ve koyu temayı test et. Uzun job ve loglar arayüzü taşırmaz; ilgili detay/kayıtlara erişim sürer.

### Onaylanan koyu konsol — 2026-09-22 kaynak sonrası kabul

Uygulama kapsamı ve sınırlar: `docs/ui-console-2026-09-22.md`. Bu seri GitHub bağlantısıyla yazıldı; tam checkout/bağımlılık kurulumu, Node 24 build ve canlı oturum bu ortamda çalıştırılmadı. Aşağıdakiler geçmeden bütün UI tamamlandı veya canlıya hazır denmez.

- [ ] Node >=24.11.1 ve npm >=11 ortamında güncel `main` için `npm ci`, `npm run lint`, `npm test`, `npm run build` çalıştır. Mevcut frontend source-contract testlerini de kontrol et; başarısız testi körlemesine kaldırma. Yeni `apps/web/src/workspace/ui/console-model.test.js` yerel seçili kaynak kopyalarında 8/8 geçti; bu, bütün monorepo testlerinin geçtiği anlamına gelmez.
- [ ] Yalnız izin verilen test hostunda `/dashboard`, `/websites`, `/databases` ve gerçek bir sitenin overview/node/deploy/domains/dns/ssl/resources/files/logs/terminal/settings deep linklerini 320, 390, 834 ve 1440 CSS px genişlikte Chromium ve Firefox'ta aç. Uzun domain, derin subdomain, boş liste, 100+ kayıt, stale/403/500 ve %200 zoom durumlarında sayfa taşması, kesilen işlem ve görünmez içerik olmamalı. Site/DB mobil satırlarının ekran okuyucudaki tablo ilişkileri korunmalı.
- [ ] Yeni tarayıcı profili Gece temasını açmalı; daha önce açık/sistem tema kaydeden kişinin tercihi değişmemeli. Sol menü > Görünüm tercihleri üzerinden tema/yoğunluk değişimi, depolama engeli ve iki sekmede storage event senkronu doğrulansın. Mobil üst çubukta arama, menü, AI ve aktif işler erişilebilir kalmalı.
- [ ] `/databases` satırında credential varsa phpMyAdmin yeni sekmede aynı site kullanıcısıyla açılmalı. Credential yoksa erişim yapılandırma açıklaması ve doğru Domain-ID tabanlı site Kaynaklar bağlantısı; site bağı yoksa site seçimi görünmeli. Eksik paket, popup engeli, expired handoff ve backend retleri görünür hata üretmeli; root bypass, düz URL token'ı veya yanlış Website geçişi oluşmamalı.
- [ ] Veritabanı oluştur/sil işlemi failed veya cancelled biterse modal ve girilmiş veri korunmalı; succeeded olunca kapanmalı. Liste yenilenirken veya stale/error durumunda mutation/phpMyAdmin kapalı kalmalı. Arama, erişim filtresi, sayfalama ve geri/ileri URL davranışı gerçek oturumda doğrulansın.
- [ ] Site ana/alt menülerinin eski URL ve application query'sini koruduğunu; runtime'a göre desteklenmeyen araçların görünmediğini; Site Ayarları'na taşınan izolasyon audit/migration/rollback ve overview'de kalan provisioning recovery akışlarının erişilebilir olduğunu doğrula.
- [ ] Mobil menü ve görünüm details alanında Tab/Shift+Tab/Escape; native modal odağı ve dönüş odağı; reduced-motion ve forced-colors davranışlarını test et. Mail/Docker/DNS/SSL/AI/terminal/dosya sayfalarının ortak tema altında kalan eski sabit renkleri ve geniş tablolarını gerçek tarayıcıda kontrol et; vendor iframe içeriğini CSS filter ile değiştirme.
- [ ] Son kullanıcı onayı için gerçek tarayıcıdan masaüstü/tablet/mobil ekran görüntüleri üret. Önceden üretilen tasarım kolajını çalışan kodun ekran görüntüsü olarak kullanma. Bu turda production deploy veya canlı ekran kabulü yapılmadı.

## T-TOOLS — P0 ttyd, yerli dosya yöneticisi, phpMyAdmin/pgAdmin gateway

- [ ] PostgreSQL/pgAdmin açıldığında aynı Website role/scope, gateway auth ve çapraz-site reddi gerçek PostgreSQL ile doğrulansın.

## T-DOCKER-PYTHON-MIGRATION — P2

- [ ] Portainer adapter'ı açılırsa yalnız authenticated Owner gateway'i, local endpoint ve secret-safe session ile erişilsin; direct port public olmasın.

## T-AI — AI yönetim katmanı gerçek provider/host kabulü

- [ ] Repo dışında saklanan gerçek provider credential'larıyla en az iki provider adapter'ında tool-call, streaming, timeout, rate-limit ve provider-error roundtrip doğrulansın; credential plaintext frontend response, conversation persistence, generic job/audit/log veya ekran görüntüsüne düşmesin.
- [ ] Yalnız açık YunPanel test hostunda (`.44` kesinlikle hariç) gerçek Owner session üzerinden read diagnostics ve reversible write doğrulansın; AI write işlemleri mevcut durable job/resource-lock/idempotency/recovery/audit yollarını kullanmalı, ikinci root transport veya raw shell oluşturmamalı.
- [ ] AI tarafından tetiklenen en az bir durable mutation host mutation sınırında process/API kill veya timeout ile kesilsin; restart mevcut root-private operation evidence'ından inspect-first reconcile etsin, duplicate side-effect üretmesin. State drift/restart sonrası eski AI preview/confirmation fail-closed kalmalı.
- [ ] Prompt-injection kabulü gerçek modelle doğrulansın: untrusted log/domain/mail/application içeriği yeni tool ekleyememeli, policy override edememeli, credential reference/plaintext sızdıramamalı ve raw shell/filesystem escape üretememeli; modele yalnız bounded available + policy-allowed tool şemaları görünmeli.
- [ ] Gerçek Chromium/Firefox Owner UI'da global/contextual AI, streaming cancel/reconnect, confirmation card, uzun durable job progress/recovery ve destructive restore için güncel exact confirmation akışları doğrulansın.

## T-UI — Son kabul

- [ ] Günlük navigasyonda uygulamalar yalnız ait oldukları Website altında görünsün; global Application ekranı yalnız Owner tanılama envanteri olsun.
- [ ] Gerçek Chromium/Firefox, mobil viewport, klavye ve ekran okuyucu ile deep-link/reload/back-forward, loading/error/missing dependency, modal confirmation ve uzun job progress davranışı doğrulansın.


## Yayın kuralı

Repoda adapter veya test bulunması canlı kabul anlamına gelmez. İlgili bölümün gerçek Ubuntu/package/browser/DNS/mail/storage/rollback kanıtı tamamlanmadan capability production-ready gösterilmez. GitHub Actions kullanılmaz.
