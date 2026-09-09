# YunPanel — Codex / Gerçek Ortam TODO

Yalnızca kalan ortam bağımlı işler, somut araç engelleri ve doğrulamalar burada tutulur. Ürün/kod işleri `plan.md`, bağlayıcı kurallar `agents.md` içindedir. Tamamlanan alt madde çıkarılır; güvenli test kanıtı/tarih commit veya doğrulama raporunda kalır. Secret, parola, cookie ve kişisel veri repoya yazılmaz.

Güncel `main` ve iki plan dosyasını oku. Kullanıcı ayrıca istemedikçe yeni branch oluşturma; doğrudan main'de küçük commitler kullan. GitHub Actions kullanma. Bu ortamda canlı panel/SSH/deployment yapılmadı. Yeni routed UI'nin kapsamı `docs/website-workspace.md`, son veri yükleme/görünüm değişiklikleri ve 40 testin sınırları `docs/ui-runtime.md` içinde; auth/MFA/parent modelinin önceki sınırları ilgili runbook'lardadır. Yeni görünüm; eksik user-admin, Website migration, agentless backend veya terminalin tamamlandığı anlamına gelmez.

## T-USER — P0: Kullanıcı yönetimi yazma engeli ve entegrasyon

- [ ] `plan.md` A'daki kullanıcı yaşam döngüsünü yetkili geliştirme ortamında tamamla. Bu turda `user-admin-store.js` için GitHub blob yazımı araç tarafından engellendi; alternatif action/encoding ile tekrar gönderilmedi. Yerel taslak, parola-helper ayrıştırması ve testleri main'de yok; varmış gibi import ekleme. Yeni UI'de kullanıcı CRUD ekranı da açılmış değil. Son devam turunda yapılan tek blob yazma denemesi de engellendi; o turdaki kullanıcı deposu taslağı test edilmedi veya commitlenmedi.
- [ ] Native Argon2 ile kullanıcı oluşturma, mevcut Owner/MFA kontrolü, son aktif Owner invariant'ı, optimistic revision, username çakışması, devre dışı bırakma/silme ve oturum/challenge iptalini gerçek auth-store ile birlikte uygula. Yerel taslağın 16 testlik sonucu yalnız native SQLite/Argon2 ve kontrollü session adapter'ını kapsadı; HTTP/MFA login/rol UI entegrasyonu yerine geçmez.
- [ ] Yeni user-admin API'lerini mevcut management/Owner MFA sınırından geçir; `/api/auth/*` self-service istisnasına koyma. Anonymous, Read Only ve unenrolled Owner reddi; CSRF/Origin; hashing sırasında actor logout/demotion/MFA reset; eşzamanlı son-Owner değişikliği; eski revision ile edit/delete senaryolarını test et.
- [ ] Kullanıcı ekranında oluşturma, rol/aktivite düzenleme, etkisi açık teyitli silme, last-Owner hatası ve değişiklik sonrası hedef oturumların kapanmasını gerçek tarayıcıda doğrula. Parola/hash/token/MFA secret listelere, audit'e veya telemetry'ye düşmemeli. Bu katman tamamlanmadan kullanıcı yönetimini bitmiş sayma.

## T-UI — P1: Yeni routed arayüzün gerçek kabulü

- [ ] Tam repo üzerinde Node 24.11.1+ / npm 11+ ile bağımlılıkları kur; yeni `react-router@8.3.0` dahil manifest çözümünü doğrula. Filtre olmadan `npm run check` ve Vite production build çalıştır. Bu ortamın 22 model testi native Node 24 ile geçti fakat tam bağımlılık kurulumu/build yapılamadı; küçük kaynak alt kümesini tam workspace sayma.
- [ ] Built React uygulamasını gerçek tarayıcıda aç. Bu ortamda yerel preview `ERR_BLOCKED_BY_ADMINISTRATOR` nedeniyle render etmedi; gerçek ekran görüntüsü, mobil/focus veya gezinme kabulü yapılmış değil. JSX transpilation/CSS parse sonucunu tasarım kabulü sayma.
- [ ] `AuthGate -> App -> WorkspaceApp` zincirini doğrula. Gizli sekmede login öncesi koleksiyon/management istekleri çalışmamalı; unenrolled Owner zorunlu MFA'da kalmalı. Yeni kullanıcı/senaryo, logout/parola/MFA değişimi, eski yanıt ve tekrar login sonrası önceki kaynak verisi görünmemeli. Router state'inde korunan loader verisi olmamalı.
- [ ] `/dashboard`, `/websites`, `/websites/new`, `/websites/:id/:tab`, `/applications`, `/applications/new`, `/domains`, `/servers`, `/jobs`, `/settings` için doğrudan URL, reload, back/forward ve yanlış route testlerini yap. HTTPS reverse proxy SPA fallback ve statik assetler API auth'unu atlamadan çalışmalı. Domain ID kullanan mevcut route'u kalıcı Website migration kabulü sayma.
- [ ] Domain/alias araması, URL type/status/sort filtreleri, grup sayfalama, nested parent context ve collapse davranışını dene. Child kayıt parent'tan ayrı sayfaya düşmemeli. Uzun isimler, çok kayıt, filtre temizleme ve browser history testlerini yap. Gelişmiş eski domain araçları erişilebilir kalmalı.
- [ ] Ana domain ve seçili parent üzerinden yeni site akışını test et. Çoklu sunucuda açık seçim, Node uygulamasından doğru port, static/proxy hedefi ve HTTPS tercihi korunmalı. Eksik applications API'si statik tür seçimini kilitlememeli. Kayıt taslak olmalı; DNS/SSL/mail otomatik yapılmış gösterilmemeli.
- [ ] Aynı sunucu/port eşleşmesiyle site Node sekmesinde doğru uygulama seçilmeli; çoklu adayda otomatik atama yapılmamalı, başka sunucu aday olmamalı. Deploy/restart/status/rollback işlemini düşük riskli fixture'da gerçek API ile yap. Kalıcı Website/application bağı henüz yok; statik/Docker bağlantısını varsayma.
- [ ] Env listeleme/masking, save/delete ve typed confirmation testlerini yap. Hatalı istekte form korunmalı; kaydedilmesi çalışan sürece uygulandı anlamına gelmemeli. Yeni site/uygulama/env/SSL formlarında route veya query değişimi, back/forward ve sayfa kapatma dirty uyarılarını dene. Eski advanced formların kalan guard işleri plan D'de açık.
- [ ] Nginx stage/activate, ACME staging/production issue, dry-run/production renewal akışlarını test et. Yanlış DNS veya config'i başarılı gösterme; çalışan ana vhost ve diğer siteleri koru. Production doğrulama/yenileme gereksiz tekrarlanarak ACME limitleri tüketilmemeli.
- [ ] Job dialogunda queued/running/terminal ayrımını, gecikmiş liste yanıtı, kapatıp yeniden açma, network kesintisi, 401/403/404, malformed response ve kaynak kilidi senaryolarını dene. Eski queued yanıtı completed işi geri almamalı; dialog kapanınca iş sunucuda sürmeli. Kuyruk iptali gerçek backend'in durum kontrolüne uymalı; ham payload/result secretları ekrana dökülmemeli.
- [ ] 401/403/404/409 ve network/missing-data hallerini her koleksiyonda oluştur. Yetki kaybında cache silinmeli; sadece network hatasında tarihli stale görünüm kalmalı. Tek tablo hatası diğer veriyi silmemeli; bilinmeyen ölçüm sıfır/yanlış yeşil SSL olmamalı. Tüm bunları actual React etkileşimiyle kontrol et.
- [ ] 1440×900, 1920×1080, 1280×800 ve 390×844 boyutlarında Dashboard/Websites/site Node/SSL/forms/jobs ekranlarını incele. Desktop sidebar, mobil focus trap/Escape/inert/backdrop, Cmd/Ctrl+K arama, skip link, modal focus restore, contrast/okunurluk, uzun tablolar ve taşmayı düzelt. MFA/enrollment ekranında sidebar yokken hesap çubuğu boşluk bırakmamalı.
- [ ] Paket build'inde yeni workspace dosyaları, router dependency ve assets bulunduğunu doğrula; API/web sürümlerini karıştırma. Güncelleme guard'ı development modunda korunmalı. Gelişmiş enrollment, domain/certificate ve APT araçlarını regresyondan geçir. Candidate install/rollback ve auth/deep-link kabulü geçmeden canlıyı değiştirme.

## T-UI-RUNTIME — P1: Son veri yükleme ve görünüm değişiklikleri

- [ ] `docs/ui-runtime.md` içindeki beş dosyanın 40 testini desteklenen Node 24.11.1+ ortamında, ardından tam workspace/build ve gerçek tarayıcıyla doğrula. Bu tur Node 22.16.0 kaynak alt kümesiyle çalıştı; 28 yeni kontrol + 12 mevcut model testi, React render/HTTP/kripto kabulü değildir.
- [ ] Network panelinde yalnız gereken koleksiyonların okunduğunu, sekme/route değişince gereksiz polling'in durduğunu ve etkin/izlenen job takibinin sürdüğünü doğrula. Kaynak değişiminin ilk render'ında eski env/site verisi görünmemeli; kapalı kaynağın geç yanıtı veya önceki refresh nesli yeni kaydı dolduramamalı.
- [ ] İşlem penceresini kapat/aç, farklı iş seç, cevabı geciktir ve yanlış job ID/bozuk cevap/401/403/404 üret. Yeniden açılış doğrulanana kadar detay göstermemeli; erişim reddi eski detayları kaldırmalı, ağ hatası yalnız doğrulanmış veriyi uyarıyla korumalı; kapatılan pencerenin isteği sonradan UI'yi güncellememeli.
- [ ] Web Siteleri tablosunda rahat/sık ve 10/25/50 grup boyutunu; reload, URL filtreleri/sayfa geri-ileri, iki sekmede storage event, bozuk/engelli localStorage ve dört hedef ekran boyutuyla doğrula. Parent/child grupları ayrılmamalı; yalnız density/perPage/version saklanmalı, domain/account ID, arama, env veya credential saklanmamalı. Kolon ve kalıcı collapse tercihleri henüz yok.

## T0 — P0: Canlı panel ve erişim koruması

- [ ] `cryptoraichu.website` adresinde mevcut paket/commit'i, bütün menüleri, network/console hatalarını ve Nginx/web/API/agent unitlerini salt okunur karşılaştır. Maskeli görsel/HTTP kanıtı kaydet; repo kodundan canlı koruma veya deployment sonucunu çıkarma.
- [ ] Oturum/yetki, IP kısıtı, endpoint yokluğu, servis eksikliği ve OS hatasını ayır. Kalan güvenlik kabulüne kadar IP/erişim korumasını kaldırma. Anonim yönetim gerçekten açıksa SSH/console erişimini koruyarak yalnız panel yüzeyine geçici IP/proxy auth uygula; hosted siteleri kısıtlama.
- [ ] Geçişten önce `/etc/yunpanel`, `/var/lib/yunpanel`, anahtarlar, paket/unitler, Nginx/vhost, release/symlink ve ilgili veri yedeğini al. Bağımsız SSH/provider-console ve restore/rollback adımlarını doğrula; yedekler public web root dışında kalmalı.

## T1a — P0: Auth tam workspace ve paket kabulü

- [ ] Node 24.11.1+/npm 11+ tam repo üzerinde auth ve mevcut Express/deploy/rollback/ACME/job testlerini birlikte, `npm run check` ile çalıştır. Tarihsel odaklı test sayılarını güncel tam regresyon sonucu sayma; GitHub Actions kullanma.
- [ ] Gerçek React production build'de ilk Owner, login/yanlış parola, Hesabım, parola değişimi, session listesi/logout, iki sekme, loading/error, modal/focus ve süre dolumunu dört hedef ekran boyutunda test et.
- [ ] Aday `.deb` oluşturup test hostunda install/upgrade/rollback yap. Auth CLI pakette bulunmalı; preinst native Argon2/SQLite olmayan runtime'ı reddetmeli. Yeni APT sürümü kullan; mevcut release dosyasını ezme.
- [ ] API/web için aynı exact `YUNPANEL_PUBLIC_ORIGIN=https://cryptoraichu.website` (son slash yok), production NODE_ENV, TLS proxy ve loopback listenerları doğrula. Eksik origin ile fail-closed beklenir; development veya IP filtresi kaldırma workaround'u kullanma.
- [ ] Gerçek `YUNPANEL_SERVER_STORE`/`YUNPANEL_AUTH_DB` yolunu belirle. Halen `yunpanel` servis kullanıcısıyla `/var/lib/yunpanel/control-plane` altında private auth yolu kullan; CLI aynı absolute DB'ye erişmeli. Dizin 0700, DB/WAL 0600 ve doğru owner; genel chmod/chown yok.
- [ ] Runbook'a göre yerel setup token üretip Owner kur. Süre/tek kullanımlılık, default/public kayıt yokluğu ve CLI parola kurtarmasını izole hesapta doğrula. API restartı olmadan eski session iptal edilmeli; parola/token/recovery verileri repo dışında kalmalı.
- [ ] SQLite tutarlı yedeği için yazıcıları durdur veya desteklenen online-backup kullan; aktif WAL varken yalnız ana dosyayı kopyalama. Kopyada restore + paket rollback yap; geri gelen eski parola/session riskini iptal/kurtarma prosedürüyle kapat.
- [ ] Gerçek paketle login -> enrollment -> site/application okuma -> düşük riskli işlem -> logout zincirini dene. Agent heartbeat/sonuçları ve hosted siteler etkilenmemeli; shared bootstrap tokenına yönetim geri dönüş yolu açılmamalı.

## T1b — P0: MFA ve oturum akışları

- [ ] Native Argon2, gerçek SQLite/OTPAuth ile tüm auth/MFA store/HTTP/CLI, session/cookie ve core/domain testlerini çalıştır. Önceki Node22/mock veya compatibility testlerini native tam kabul sayma. `otpauth` ve güncel frontend aynı pakette olmalı; API gerçek index.js girişinden çalışmalı.
- [ ] Auth schema v1 -> v2 geçişini yedekli kopyada test et; kullanıcı/parola/session/domain/application ilişkilerini koru. Eski pakete dönüş için eşleşen DB/master-key yedeğini prova et; sadece PRAGMA sürüm numarasını düşürme.
- [ ] Gerçek cihaz ve HTTPS ile Owner/MFA kurulum -> manuel anahtar -> doğrulama -> 10 recovery kodunu kaydet -> logout -> parola+TOTP giriş zincirini tamamla. QR bekleme; 202 challenge management session sayılmamalı. Cookie host-only/Secure/HttpOnly kalmalı.
- [ ] Yanlış, tekrar kullanılan ve expired TOTP; beş yanlış challenge denemesi; iptal; yeni password challenge'ın limiti sıfırlamaması; recovery kullanımı ve ikinci kez reddi; kod yenilemede eskilerin iptali; factor kaldırma/session rotasyonu testlerini yap. Saat senkronizasyonunu doğrula, tolerans penceresini büyüterek hatayı örtme.
- [ ] İki sekme, gecikmiş401/200, MFA rotasyonunda polling, kayıp mutation response, bfcache/back, modal Escape/focus ve kodları onaylamadan kapatmayı test et. Eski yanıt yeni cookie/session'ı bozmamalı; kayıp yanıtı körlemesine tekrar gönderme, gerçek durumu yeniden doğrula. URL/localStorage/telemetry'de secret olmamalı.
- [ ] Idle/absolute son-iki-dakika uyarısı ve uzatma butonunu test et; background GET süre uzatmamalı, mutlak süre uzatılamamalı, network hatası formu silmemeli. Yeni MFA/Owner ekranlarını dört boyutta incele.
- [ ] Mevcut master key'i değiştirmeden enrollment; eksik/yanlış/kayıp key ile fail-closed TOTP ve parola+geçerli recovery alternatifi; aynı DB/servis kullanıcısıyla `reset-mfa <username> --confirm` testlerini yap. Parola korunmalı, factor/recovery/challenge/session iptal olmalı. Ağ kısıtı altında yeniden enrollment yap; gerçek anahtarları rapora koyma.

## T1c — P0: Zorunlu Owner MFA politikası

- [ ] `owner-mfa-policy`/`owner-mfa-http`/`owner-access` testleri ile gerçek store/gateway enrollment testlerini tam Node24 workspace'te yeniden çalıştır. Önceki 40 testlik controlled-store run'u native/full-build kabulü sayma.
- [ ] Existing ve yeni unenrolled Owner ile HTTPS password login -> self-service -> MFA -> recovery onayı -> management zincirini test et. Önce site/env/job/terminal yolları `403 mfa_enrollment_required`, sonra mevcut yönetim erişimi vermeli. `/api/auth/security` yalnız kendi durumu; anonim401.
- [ ] API key hazır değilken setup prerequisite görünmeli ama management açılmamalı. Local factor reset/panelden disable eski sessionları iptal etmeli; sonraki password login ancak yeniden enrollment ile açılmalı. Çalışan master key'i değiştirme, production'ı development'a alma.
- [ ] Rotasyonda recovery ekranı onay öncesi kaybolmamalı; eksik/malformed security metadata veya API/asset uyuşmazlığında management render edilmemeli. Polling, refresh/back/iki sekme, klavye ve dört boyutu test et.
- [ ] Enrollment istisnası yalnız explicit loopback HTTP geliştime için olmalı; development=true + HTTPS policy'yi aşmamalı. Legacy agent kendi credential sınırında kalmalı. Bu kabul henüz yazılmayan root/socket/PTY'ye otomatik yayın izni değildir.

## T1 — P0: Dış erişim güvenlik kabulü

- [ ] Gizli sekmede ve izinli IP'den login olmadan site/env/job/API verisi alınamadığını doğrula; yeni log/file/export modüllerine aynı testi genişlet. 401/403 ayrımı backend'de olmalı, frontend yönlendirmesi yeterli değil.
- [ ] `/api/panel/*`, raw API, dev, eski bootstrap/enrollment/agent ve alternatif portlarda bypass kontrolü yap. Normal yönetim shared token kabul etmemeli. Agent kaldırılana kadar transport kendi kimliğiyle ve browser yönetiminden ayrı doğrulanmalı.
- [ ] Gerçek HTTPS proxy'de cookie, SameSite/host-only, CSRF/Origin ve trusted-proxy/IP header spoof reddini doğrula. Proxy arkasındaki ortak peer rate-limit kovasının gerçek etkisini ölç.
- [ ] Rate limit, yanlış parola, idle/absolute, refresh/logout, password/role/user-disable senaryolarını test et. Son Owner ve Read Only mutasyon/terminal reddi user-admin eklendiğinde tekrar doğrulanmalı. Gelecekte canlı bağlantı yetkisi de iptal edilmeli.

## T2 — P1: Agentsiz backend ve paket geçişi

- [ ] Yeni agentsiz `.deb`yi Ubuntu24.04 test hostunda install/upgrade et; PTY native bağımlılıkları, Node ABI, ownership ve systemd unitini doğrula.
- [ ] Job drain ve state migration'ı yedekle karşılaştır. Server/application/domain ID, auth SQLite, ciphertext/master key, current release/vhost/sertifika korunmalı. Lokal olmayan server kayıtları bu hosta sessizce taşınmamalı.
- [ ] Yeni backend root olarak gerekli host işlemlerini yapmalı ve yalnız planlanan interface'te dinlemeli. Ayrı agent/enrollment veya işlem başına sudoers/polkit izni gerekmemeli.
- [ ] Agent durmuşken envanter, Nginx test/reload, ACME, deploy/restart/rollback, systemd ve paket akışlarını doğrula; ardından eski agent disable, listener/credential/unit temizliğini kontrollü yap.
- [ ] Build/npm/Git hook, site process/cron/terminal dedicated user ile çalışmalı; başka site env'i, panel key/auth DB/host dosyaları okunamamalı. Root geçişinde auth ve CLI ownership'ini açık taşı; global chmod/chown veya tüm sandbox'ı kaldırma kullanma.
- [ ] Upgrade sırasında job drain, restart reconciliation, duplicate execution ve eski paket/state/unit rollback'ini test et. Reboot sonrası bütün servisler açılmalı; panel dururken hosted trafik sürmeli.

## T3a — P1: Domain parent ve form kabulü

- [ ] Domain-hierarchy runbook'undaki dört test dosyasını desteklenen Node24 ve tam repo testleriyle çalıştır. Eski 29 odaklı test kısmi workspace'ti; güncel Express/Vite kabulü yerine geçmez.
- [ ] Gerçek index -> auth boundary -> app/core/domain route üzerinden Owner parent-aware POST/list testini yap. Missing parent404, invalid relation400, cross-server409, anonymous401, role403 ve CSRF reddi korunmalı. SSL renewal dry-run/deploy/rollback regresyonu çalışmalı.
- [ ] Paket API/core/domain modülleri ve yeni assets birlikte olmalı; farklı sürümleri karıştırma. Subdomain quick-add ve yeni routed formda parent/doğru server/prefix/hedef/HTTPS, başarısız submit sonrası değer/focus/busy durumlarını doğrula.
- [ ] Tree araması, alias eşleşmesi/ancestor context, collapse ve search temizlenince görünüm, uzun isim/çok satır/dört ekran boyutunu test et.
- [ ] Version1 domain kopyasında salt okumada rewrite/parent tahmini olmadığını; yeni explicit parent/ID/alias/target/certificate'in reboot sonrası korunduğunu test et. Eski paketin yeni parent validation'ını uygulamadığını hesaba katarak rollback prova et.
- [ ] Child stage/activate ve bağımsız TLS hedefi ana vhost/sertifikayı veya diğer siteleri bozmamalı. DNS/mail otomatik yaratılmış sayılmamalı. IDN/reparent/kalıcı Website migration'ı hazır varsayma.

## T3 — P1: Website migration ve site ilişkileri

- [ ] Düz domain/application verisini yeni Website modeline yedek kopyada migrate et; count/ID/alias/hedef/root/env/release/certificate'i karşılaştır, tekrar koşuda duplicate olmamalı.
- [ ] Bir ana domain, iki bağımsız subdomain ve alias ile kalıcı parent/target ve ayrı app/env/SSL/log ilişkilerini doğrula; yeni UI'nin port adaylarını kalıcı ilişkilerle değiştir.
- [ ] www/non-www, IDN/punycode, trailing-dot/uppercase, çok parçalı suffix, duplicate/cycle ve dependency-aware delete/reparent preview testlerini yap. Örtülü cascade olmamalı; mailbox/sertifika etkisi görünmeli.
- [ ] Site değiştirme, Node/SSL/Mail, direct URL/reload/history/logout ve loading/empty/error/missing-service/klavye/focus'u dört boyutta test et. Form sırasında refresh/API hatası değerleri veya diğer kaynağın verisini silmemeli.

## T4 — P2: Terminal ve dosya işlemleri

- [ ] Ubuntu/TLS proxy altında WebSocket upgrade, resize, Unicode, Ctrl+C/D ve fullscreen programları test et. Sunucu=root, site=doğru kullanıcı/dizin olmalı.
- [ ] Anonymous, Read Only, başka kullanıcı/session/terminal ID, yanlış Origin ve yetki replay reddini doğrula. Logout/password/role/MFA/user-disable/idle/browser close sonrası yeni komut engellenmeli; PTY/process-group/session limitleri çalışmalı.
- [ ] Yüksek output, kopma/reconnect, backpressure/memory ve sahiplik kontrolünü test et. Raw keystroke/çıktı normal job/audit loguna düşmemeli.
- [ ] Dosya yöneticisinde gerçek fs `../`, symlink kaçışı, upload ownership/boyut, mkdir/rename/edit/delete/download kontrollerini test et. Owner host işleri açık Sunucu bağlamında olmalı.

## T5 — P2: Node/static/Git, secret ve log

- [ ] Custom startup file/npm script kullanan uygulamaları site içinden deploy/restart/rollback et; Node/port/cwd/startup korunmalı, runtime kurulumu panel Node'unu bozmamalı.
- [ ] Unhealthy yeni release ve manuel rollback hedefi; build hatası, port çakışması, stale current için güvenli hata/önceki sürüme dönüşü gerçek hostta doğrula.
- [ ] Private Git/deploy key/webhook secretlarını repo dışında tanımla; site user fetch/build ve imza/branch/replay/duplicate kontrollerini test et.
- [ ] Master key eksikliği fail-closed, rotation, yedek ve ciphertext recovery'yi test kopyasında doğrula. Yeni yerel yürütücüde API/job/unit/argv/log/audit/frontend sızıntısı olmamalı; iki gerçek site fixture'ıyla izolasyon dene.
- [ ] Node/systemd/Nginx/deploy loglarında örnek hassas değerlerle redaction, arama/liveflow/disconnect/boundeddownload testini yap. Gerçek credential'ı testdeğeri kullanma.
- [ ] İlk gerçek Plesk static/Node taşımasında backup -> hosts override -> Git/build -> Nginx/SSL -> DNS cutover -> health/route -> rollback zincirini prova et. Fixture testi gerçek migration yerine geçmez.

## T6 — P2: Nginx, SSL ve DNS

- [ ] Gerçek www/non-www/canonical/alias ve HTTP->HTTPS yönlendirmeleri, bağımsız subdomain hedeflerini doğrula. Hostname kaydı DNS yayını sayılmamalı.
- [ ] Büyük upload/proxy timeout, WebSocket, SPA/cache/header ayarlarını ve agentsiz yürütücüyü gerçek uygulamada regresyondan geçir.
- [ ] Renewal sonrası Nginx test/reload ve yeni sertifikanın sunulduğunu doğrula; staging/dry-run yeterliyken production issuance tekrarları yapma.
- [ ] Yanlış DNS, expired/invalid certificate, hatalı Nginx değişiminde doğru hata/önceki config ve diğer site sağlığını doğrula.
- [ ] DNS-01/wildcard için gerçek provider/credentialları repo dışında hazırla; apex/wildcard/alias kapsamı, key/cert eşleşmesi ve custom certificate'i test et.
- [ ] Taşınacak domainlerde A/AAAA/CNAME, MX/SPF/DKIM/DMARC, TTL ve DNSSEC etkisini doğrula. PTR/rDNS sağlayıcıda uygulanmadan tamamlandı gösterilmemeli.

## T7 — P2: Mail ve Roundcube

- [ ] Plesk mail stack, mailbox/kota, alias/forwarding/catch-all, MX/SPF/DKIM selector/DMARC, Roundcube özelleştirmeleri ve password-hash uyumluluğunu envanterle. Uyumsuz hash için güvenli reset/taşıma belirle.
- [ ] Ayrı test domaininde Postfix, Dovecot IMAP/LMTP, Rspamd, Roundcube install/config; SMTP/IMAP TLS, restart, relay reddi ve provider port sınırlarını test et.
- [ ] Site içinde main/explicit subdomain mail alanı, mailbox enable/create/delete/password/quota/alias/forwarding'i dene. Ana mailboxlar otomatik subdomain hesabına dönüşmemeli.
- [ ] MX/SPF/DKIM/DMARC/PTR yayımla/doğrula; imza/header ve Gmail/Outlook ile send/receive yap. SMTP kabulünü inbox garantisi sayma.
- [ ] Roundcube login/send/receive, mail queue, spam davranışı, log ve servicehealth'i doğrula. Mail yedeğini ayrı mailbox'a restore et; içerik/kota/metadata ve başarısız restore/silme rollback'ini kanıtla. Bundan önce production MX taşıma.

## T8 — P3: Docker ve veritabanları

- [ ] Gerçek Engine/Compose/private registry credential yöntemini doğrula; düşük riskli projede build/pull/start/stop/restart, health, Nginx hedefi ve reboot policy testlerini yap.
- [ ] Named volume/bind mount, log ve failed deploy sonrası önceki durumu doğrula; persistent veri kaybolmamalı, DB container backup'ı uygulama-tutarlı dump içermeli.
- [ ] MySQL/MariaDB provisioning'i korumalı backend config'inde hazırla; uygulama DB user'ına host/root yetkisi verme. Gereken remote bind/firewall ayrıca sınırlandırılmalı.
- [ ] DB/user create/delete, grant/revoke, password rotation, size/dump/restore testini ayrı DB'de yap. Integrity, büyük veri disk/süre ve başarısız restore rollback'i doğrula.

## T9 — P3: Backup, cron, ağ ve dayanıklılık

- [ ] Gerçek backup hedefi/credential'ı repo dışında hazırla. Local/S3-compatible veya seçili Restic/remote hedefte appfiles/env/config/DB/volume/mail restore testlerini yap.
- [ ] İzole uygulamayı yalnız backup'tan yeniden kur; checksum/integrity, encryption recovery, retention ve diskfull/targetoutage/yarım restore güvenli hata/rollback'ini doğrula.
- [ ] Cron'u gerçek site user/cwd/env/timezone ile çalıştır; last-run/output/error görünsün. Owner sistem cron'u ayrı bağlamda kalmalı.
- [ ] SSH erişimini koruyarak kalıcı firewall uygula; private/VPN seçildiyse dene. Public API/terminal planlanan TLS girişinden erişilmeli; mail/DB portları ihtiyaca göre, reboot sonrası kurallar doğrulanmış olmalı. Kaldırılmış agent portu açık kalmamalı.
- [ ] Concurrent deploy/restore, Nginx mutation, self-update, kaynak tükenmesi ve process interruption testlerini yap. Job/result/audit tutarlılığı, redaction ve hosted trafik etkisini kaydet.

## T10 — P3: Gerçek Plesk migration

- [ ] Plesk/OS, Nginx/Apache, Passenger/Node, Docker/Compose, DB/ACME/mail envanterini çıkar; Apache/.htaccess bağımlılıklarını ayır.
- [ ] Domain/root/runtime/Git/branch/startup/version/env-name/DB/cron/SSL/mail bağlarını export et. Secret değerini rapora değil korumalı taşıma kanalına koy.
- [ ] Gerçek Passenger/static/Docker vhost/include/interpreter/log/ownership/cache/SPA/volume/network/restart ve özel directive'leri maskeli örneklerle incele. Plesk dışı Passenger adapter'ında interpreter/startup/log/restart/reboot/rollback'i test et.
- [ ] Restore edilebilir backup sonrası düşük riskli static -> stateless Node -> DB/WebSocket Node -> Passenger -> Docker/stateful -> kritik olmayan mail -> kritik servisler sırasıyla kaynak bazlı taşı.
- [ ] Her kaynak için hosts/pre-cutover, DNS/MX, HTTP/HTTPS/önemli route/log, rollback ve gözlem süresini kaydet. Birkaç gerçek workload stabil olmadan Plesk geri dönüşünü kaldırma.

## T11 — Son kapı: Temiz sunucuda Plesksiz kurulum

- [ ] Temiz Ubuntu24.04'te Plesk olmadan agentsiz YunPanel kur; Owner/MFA, Nginx/Node/ACME ve gereken DB/Docker/mail'i panel akışlarıyla hazırla.
- [ ] Main domain + bağımsız subdomain + alias, static/Node/Docker, DB lifecycle, SSL ve mail'i uçtan uca doğrula. Günlük site yönetiminde teknik ID/token/agent izni gerekmemeli.
- [ ] App/DB/volume/mail backup/restore, gerçek TLSrenewal, reboot, root/site terminal ve panel kesintisini test et.
- [ ] Erişim/secret recovery, package rollback ve health kanıtlarını incele. Kritik açık madde varken production-ready deme; günlük yönetim ve kurtarmada Plesk bağımlılığı kalmamalı.
