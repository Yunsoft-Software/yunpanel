# YunPanel — Gerçek Ortam / Kabul TODO

Bu dosyada yalnız kaynak testleriyle güvenilir biçimde tamamlanamayacak gerçek Ubuntu, package, browser, DNS/provider, mail delivery, storage ve rollback kabulleri tutulur. Kod işleri `plan.md`, hedef mimari `docs/architecture.md`, bağlayıcı kurallar `agents.md` içindedir.

IP adresi `.44` ile biten Plesk sunucusu kesinlikle kapsam dışıdır. Bütün SSH/package/deploy testleri yalnız repo dışı `.local/test-server.env` içindeki açık YunPanel test sunucusunda, hedef adresin `.44` olmadığı doğrulandıktan sonra yapılır. Secret/parola/cookie/MFA/private key ekran görüntüsü, rapor, log veya repoya yazılmaz.

## T-DEV-SSL-RENEW — SSL yenileme sonucu ve gerçek sertifika kabulü (2026-09-24)

SR-01–04 kaynağı `development` dalında; [kaynak/test raporu ve sınırlar](docs/ux/ssl-renewal-result-flow.md). Aynı seçili Node22 koşusunda **73 geçti / 0 başarısız / 0 atlandı**: 59 yenileme davranışı + 8 koleksiyon yenileme davranışı + 6 kaynak bağlantısı. Sekiz kaynak/test blob'u eşleşti; üç JSX sözdizimi/dönüşüm kontrolü gerçek React veya tarayıcı kabulü değildir.

- [ ] Node24/npm11 tam checkout/npm ci/lint/test/build. Yeni `ssl-renewal.test.js`, `ssl-job-refresh.test.js`, `ssl-renewal-wiring.test.js` ile mevcut SSL formu, koleksiyon, job, certificate registry/reconciliation testlerini birlikte çalıştır. Doğrudan Git erişimi bu ortamda DNS çözümleme hatasıyla başarısız oldu; tam checkout ve hedef bağımlılıklarla build yapılmadı.
- [ ] Gerçek React/SessionProvider/router/StrictMode ve HTTP/auth/CSRF: gerçek yenileme, dry-run, aynı sertifika, failed/cancelled ve gecikmiş kalıcı kayıt. İş başarılı olsa bile fingerprint/tarih eşleşmeden yenilendi denmesin; aynı sertifikanın süresi yapay olarak uzamasın. Site listesi/Genel Bakış/SSL kalan gün bilgisi yenilensin; JobDrawer kapalıyken de takip edilen işin terminal geçişini test et.
- [ ] Kayıp POST, yanlış job/sertifika/site kimliği, sertifika seçimi veya Website bağının değişmesi, logout/login ve yetki iptali: eski onay yeni hedefe yazmasın. Bilinen iş GET ile izlensin; bilinmeyen yanıt yeni renewal POST ile telafi edilmesin. Uzun iş ve metadata takip sınırından sonra elle yeniden okuma yalnız GET olsun.
- [ ] Gerçek TLS bağlantısında sunulan sertifika ile panelin kayıtlı fingerprint/validFrom/validTo değerlerini karşılaştır. Nginx/mail reload, DNS/provider hatası, süreçler arası kaynak kilidi ve restart ayrıca doğrulansın. Panel metadata eşitliği canlı TLS kanıtı değildir; ilk issuance sonrası mail identity/stage/activate kısmi sonuçları PROD-06 kapsamında açık kalır.
- [ ] Mobil, klavye, modal odağı, koyu tema, eski API cevabı ve mevcut issuance formu regresyonları. `.44` hariç yalnız izinli hostta güncel API/web sürümüyle kabul; GitHub Actions veya canlı deploy bu tur yapılmadı. Üst BUG-06/production kapıları açık.

## T-DEV-MR-SINGLE / T-DEV-ADMIN-LAYOUT — 2026-09-24 güncel kabul

Tek posta kutusu için alan adı kapatma şartı kaynakta kaldırıldı; eski genel kapatma notları mailbox kapsamı için geçerli değildir. [MS-01–04 kaynak ve sınırlar](docs/ux/mailbox-single-removal.md), [BUG-07 kaynak ve görsel kabul](docs/ux/site-admin-field-alignment.md). Aynı son Node22 koşusunda 109 test geçti: 105 mail + 4 form kaynağı. Bu gerçek React/SMTP/IMAP/webmail kabulü değildir; önceki turların toplamı da değildir.

- [ ] Node24/npm11 tam checkout/npm ci/lint/test/build; yeni mailbox-access-preparation, mailbox-access-guard, admin-layout testleriyle mevcut mailbox-removal/API/worker/delete-manager/finalizer/site-scope grupları birlikte çalışsın. Burada Git/raw erişimi DNS hatasına takıldı; tam checkout ve üretim bağımlılıklarıyla build yapılmadı.
- [ ] Aynı etkin mail domain içinde A'yı kapat/uygula/yedekle/sil; B'nin SMTP/IMAP/webmail kullanımı sürsün. A'nın mevcut Dovecot oturumları, yeni auth/teslimat reddi, önceden authenticate SMTP oturumları, devam eden LMTP ve webmail HTTP oturumları ayrı doğrulansın. Domain veya B hesabı disable edilmemeli; önceden kapalı domain otomatik açılmamalı.
- [ ] Gerçek Dovecot/Postfix sürümünde field-only lookup, yokluk exit/çıktısı, cache flush, seçilen kullanıcı kick/who; hata veya unmanaged config yokluk kabul edilmesin. Ortak config apply sırasında başka kaydedilmiş bekleyen düzenlemelerin önizlenmesini ve reload etkisini doğrula. Eski API/worker cevabı için tüm domaini kapatma workaround'u kullanma.
- [ ] Kayıp PATCH/apply/delete/finalize cevabı, iki hızlı onay, eski yedek veya başka iş kimliğini resume etme, oturum/yetki değişimi; yanlış kanıtla yeniden yazma olmamalı. Worker mutation anında alias/yeniden etkinleştirme/yeni mesaj yarışı, süreçler arası kilit ve yedekten gerçek geri dönüş zorunludur.
- [ ] BUG-07: gerçek font/React/Ember CSS ile 320/390/834/1440 px ve yüzde200 zoom; label/input hizası, uzun yardım/validation metni, email/parola autofill, klavye ve aria-describedby. Dört kaynak testi gerçek piksel hizası ölçümü değildir. `.44` hariç yalnız izinli host; canlı deploy bu tur yapılmadı.

## T-DEV-MAILBOX-REMOVE — Posta kutusu silme (2026-09-24)

MR-01–04 kaynak bağlantısı `development` dalında; [kaynak, test kanıtı ve sınırlar](docs/ux/mailbox-removal-flow.md). Seçili Node22 koşusunda **53 geçti / 0 başarısız / 0 atlandı**: 35 frontend davranışı + 12 backend helper/impact davranışı + 6 kaynak bağlantısı. Bunlar gerçek React/HTTP/posta hostu kabulü değildir; dokuz kaynak/test blob'u eşleşti. Önceki test sayıları eklenmez.

- [ ] Node >=24.11.1/npm >=11 tam checkout/npm ci/lint/test/build. `mailbox-removal.test.js`, `mailbox-removal-wiring.test.js`, `mailbox-alias-references.test.js` ile mevcut mailbox/mail-client/impact/data/finalizer/site-scope regresyonları. Doğrudan Git erişimi DNS hatasıyla engellendiğinden burada tam checkout ve hedef build yapılmadı; eski impact testinin eşitliği doğrulanmayan yerel kopyası raporlanan 53'e dahil edilmedi.
- [ ] Gerçek SessionProvider/React/router/StrictMode ve HTTP/auth/CSRF ile Owner/Site A/Site B: başka posta kutusu/alan adı/backup/job kimliği reddi, logout/login, yetki iptali ve eski cevap/onayın yeni hedefe taşınmaması.
- [ ] Gerçek doğrulanmış yedek → veri silme işi → mailbox finalize; 202/failed/cancelled ve veri silinmiş-kayıt kalmış durumlarında tam başarı gösterilmesin. Kayıp POST, iki hızlı onay, mevcut job kimliğiyle yalnız GET devamı ve finalize yanıtı kaybı/404 uzlaştırması; aynı yazma kör tekrarlanmasın.
- [ ] Güncel MS-01–04 ile tek-kutu silmede alan adı açık kalsın; yalnız seçilen hesabın gerçek SMTP/IMAP/Postfix/Dovecot/Roundcube erişimi denetlensin. Domain-scope toplu silmenin kendi domain disabled şartı korunur. Disabled kayıt tek başına canlı kapanma kanıtı değildir; ayrıntılı kabul yukarıdaki T-DEV-MR-SINGLE içindedir.
- [ ] Yerel/yabancı alias referansları, kota/forwarding, eşzamanlı yeni mesaj ve çalışan iş engelleri; yabancı alias kimliği sızmasın. İki tarayıcı/proses yarışı, backend mutation anı yetkisi, yedekten gerçek geri dönüş ve kalan hesapların yeniden çalışması doğrulansın. Mobil/klavye/odak/koyu tema; `.44` hariç yalnız izinli host. GitHub Actions ve canlı deploy bu tur yapılmadı.

## T-DEV-ADMIN-RESULT — Site yöneticisi hesap sonucu (2026-09-24)

Kaynak ADMIN-RESULT-01–04 ile `development` dalında tamamlandı; [kaynak/test raporu](docs/ux/site-admin-result-flow.md). Seçili Node22 koşusunda 39 test geçti; gerçek auth/Argon2/SQLite/React/host kabulü değildir. Rota testindeki engine/planner/guard/store bağımlılıkları açık fixture'dır.

- [ ] Node >=24.11.1/npm >=11 ile tam checkout/npm ci/lint/test/build. Yeni `site-admin-provisioning.test.js`, `site-create-mount-contract.test.js`, `site-admin-result.test.js` ile mevcut create/user/auth/form/provisioning regresyonlarını birlikte çalıştır; gerçek app.js import ve HTTP/auth/CSRF zincirini doğrula.
- [ ] Gerçek kullanıcı deposunda hesap yaratılmasını bekle; normalize kullanıcı adı, actorId audit'i, site_manager rolü, aktiflik ve yalnız beklenen Website bağı doğrulansın. Yeni hesapla gerçek giriş ve Site A→Site B erişim reddi denensin.
- [ ] Hesap çakışması/hash/store hatası, eksik bağımlılık ve eski/bozuk API cevabında site kaydı ile hesap sonucu ayrı görünsün. Host planı tamamlanınca hesap uyarısı kaybolmasın. Replay mevcut hesabı yeniden yaratmasın, parolasını veya site yetkisini değiştirmesin; kalıcı operation→user uzlaştırmasını ayrıca tamamla.
- [ ] Hash sırasında yetki iptali/Website silme, iki süreç yarışı ve hesap sonrası provisioning registry yazma hatalarını test et. Atomik yetki/kilit ve kalıcı sonuç kaydı bu kaynak dilimiyle kapanmadı. Gerçek React/router/mobil/klavye/koyu tema ve mevcut kullanıcı yönetimi/Genel Bakış/Dosyalar bağlantılarını doğrula. `.44` kesinlikle hariç; canlı deploy bu tur yapılmadı.

## T-DEV-RECOVERY — Manuel kurulum kurtarma (2026-09-23)

Kaynak `development` dalında RECOVERY-01–04 ile tamamlandı; [güncel kaynak ve test raporu](docs/ux/provisioning-recovery-flow.md). Son koşu 71 geçti / 0 başarısız / 0 atlandı: önceki 70 yeniden koşuldu + 1 optional compensation testi. Node22 seçili davranış/kaynak testleri gerçek React/API/host kabulü değildir. GitHub DNS hatası nedeniyle burada tam checkout alınamadı.

- [ ] Node >=24.11.1/npm >=11 tam lint/test/build. Yeni `provisioning-recovery-controller.test.js`, `provisioning-recovery-wiring.test.js`, `provisioning-recovery-optional.test.js` ile korunan `provisioning-recovery.test.js` ve mevcut create/autoAdvance/session regresyonlarını birlikte çalıştır. Gerçek SessionProvider/React/router/StrictMode kullan.
- [ ] Owner/Site A/Site B ve oturum/yetki/Website geçişlerinde eski GET/POST sonucu veya onay yeni hedefe taşınmasın. Stale/error sırasında mutation kapalı; 401/403'te eski kayıt temizlenmiş olsun. Gerçek backend tenant yetkisi ayrıca doğrulansın.
- [ ] Onay açıkken işlem/adım/yetenek değişimi ve iki hızlı onay; yalnız aynı güncel hedefte tek POST. 409/429/5xx/yanıt kaybında otomatik tekrar olmasın. Durumu yenile yalnız GET yapsın; yeni mutasyon açık onay istesin. İki tarayıcı/prosesin ortak kaynakta yarışını backend atomik kilidiyle doğrula; istemci preflight yeterli kanıt değildir.
- [ ] Gerçek continue/retry/compensate, kalıcı durum, idempotency, ownership ve restart. Yüksek eski deneme sayısı sunucunun izin verdiği manuel retry'yi istemcide engellemesin. İsteğe bağlı geri alma ile zorunlu adım readiness ayrışsın; failed/blocked/compensation_failed başarı sayılmasın.
- [ ] Gerçek mobil/klavye/modal odağı/koyu tema ve hata/teknik bilgi görünürlüğü. Abort host rollback sayılmasın. `.44` dışında yalnız izinli test hostunda güncel API/web sürümüyle kabul yap. Güvenli otomatik retry/backoff/kalıcı bütçe ve site-admin hata yayılımı `plan.md` içinde açık backend işleridir.

## T-DEV-CREATE-RESULT — Site oluşturma sonucu sürekliliği (2026-09-23)

Kaynak `development` dalında CREATE-RESULT-01–04 ile tamamlandı; [kaynak/test raporu ve ayrıntılı kabul](docs/ux/site-create-result-flow.md). Bu tur 62 seçili Node22 testi ve iki JSX sözdizimi kontrolü çalıştı; gerçek React/API/host kabulü değildir. Önceki test sayıları eklenmez.

- [ ] Node >=24.11.1/npm >=11 tam checkout, npm ci, lint/test/build. `site-create-submission.test.js`, `site-create-result-wiring.test.js` ve mevcut form/create/provisioning/session regresyonları birlikte çalışsın. GitHub/npm DNS hatası nedeniyle burada tam checkout ve hedef bağımlılık kurulumu yapılamadı.
- [ ] Gerçek create 201/200 sonrasında provisioning hatası, timeout, yanlış/bozuk cevap ve blocked/failed/interrupted sonucu: oluşturulmuş site kartı, adımlar ve doğru Domain-ID Genel Bakış/Dosyalar bağlantıları korunsun. Kayıt başarısı çalışır site/SSL/mail/site-admin başarısı diye sunulmasın.
- [ ] Create POST yanıt kaybı, 401/403/409/429/5xx ve çift gönderimde aynı form kör create tekrarı yapmasın. Önizleme hatası düzeltilebilir kalsın. Belirsiz sonucu mevcut site listesinden/backend kaydından uzlaştır; otomatik cleanup veya yeni site oluşturma yapma.
- [ ] Gerçek React StrictMode, logout/login, yetki değişimi, unmount/abort ve yeni form bağlamında eski yanıt sızmasın. Parola alanının temizlenmesini, sonuç odağı/ekran okuyucu/mobil/klavye/koyu tema ve mevcut shared-site açık onayını doğrula. `.44` dışında yalnız izinli test hostunu kullan. Manuel recovery istemci kaynağı RECOVERY-01–04 ile tamamlandı, gerçek kabulü yukarıda açık; backend site-admin hata yayılımı ve güvenli retry kaynak işleri `plan.md` içinde açık kalır.

## T-DEV-JOB-UX — İşlem durumu ve kurulum ilerletme (2026-09-23)

Aktif çalışma dalı `development`; aşağıdaki eski tarihli `main` ifadeleri bu dilimin hedefi değildir. Kaynak ve ayrıntılı kabul: [job-progress-retry-flow.md](docs/ux/job-progress-retry-flow.md). Seçili Node22 testleri gerçek ortam kabulünü kapatmaz.

- [ ] Node >=24.11.1/npm >=11 tam checkout'ta `npm ci` ve tam lint/test/build. `job-presentation.test.js`, `provisioning-advance.test.js`, `job-progress-wiring.test.js` ve mevcut job/provisioning/session regresyonlarını birlikte çalıştır. Bu ortamda GitHub DNS çözümlemesi başarısız olduğundan tam checkout yapılamadı; 74 seçili test ve iki JSX sözdizimi kontrolüyle sınırlı kalındı.
- [ ] Gerçek React/Vite ile İşlem geçmişi, site içi işler ve detay penceresi: failed/cancelled 3/3 veya yüzde yüz görünmesin; gerçek 0 deneme korunsun, eksik/bozuk bilgi sıfır sayılmasın. Kaynak/log/iptal bağlantıları, mobil ve klavye korunsun.
- [ ] Gerçek HTTP/auth/CSRF ile başarılı adım zinciri, zaten tamamlanmış işlem, 401/403/409/429/5xx, yanıt kaybı, yanlış işlem/site sonucu, logout/login ve abort. Belirsiz POST otomatik tekrarlanmamalı; sunucudaki kaynak güncel kayıtla uzlaştırılmalı. İlerlemenin durması host işini iptal etmek değildir.
- [ ] Yaratılmış site sonrasında ilerletme hatasında yeni site oluşturmadan mevcut sonuca/Genel Bakış recovery'ye dön. Manuel continue/retry/compensate, stale kayıt, çift tıklama, oturum kaybı, ortak kilit, idempotency ve restart kabulünü tamamla. Otomatik hata tekrarı bu dilimde güvenli durduruldu; backend sınıflandırmalı bounded retry/backoff ve limit sonrası manuel retry kaynak/host işi `plan.md` BUG-01 içinde açık.
- [ ] `.44` kesinlikle hariç izinli test hostunda güncel API/web build kimliğiyle doğrula. Files/hosting/alias ve önceki SSL formu kabulleri ayrıca açık; eski test sayılarını bu turun sonucuna ekleme.

## T-EMBER — 2026-09-22 görsel dil ve gerçek tipografi kabulü

Güncel görsel karar ve test sınırları: `docs/history/ember-visual-language-2026-09-22.md`. Grafit/mandalina/kırık beyaz dil, önceki lacivert/mavi renk hedefinin yerini alır; UX ve güvenlik kriterleri değişmez. Bu turdaki 14 kaynak testi ve 45 temsilî HTML görsel kontrolü production React/host kabulü değildir. Önizlemelerde font indirmesi engellendiğinden Lato yedek fontu kullanılmıştır.

- [ ] Node >=24.11.1/npm >=11 ile gerçek checkout'ta `npm ci`, `npm run fonts --workspace @yunpanel/web`, `npm run fonts:check --workspace @yunpanel/web`, lint/test/build çalıştır. İlk font hazırlığı sabit upstream'e erişmeli; internetsiz build için `YUNPANEL_FONT_CACHE_DIR` ile doğrulanmış dosyalar sağlanmalı. Bozuk/eksik dosyada başarılı font kurulumu bildirilmemeli. OFL lisansları fontlarla birlikte build çıktısında bulunmalı.
- [ ] Üretim Vite çıktısında Manrope ve Outfit font isteklerinin same-origin 200 döndüğünü, doğru font MIME/CSP ile açıldığını ve tarayıcıda gerçekten kullanıldığını doğrula. Türkçe İ/ı/Ğ/ğ/Ş/ş/Ç/ç/Ö/ö/Ü/ü, sayılar, font-weight ve ilk yükleme kayması kontrol edilsin. Kod editörü/terminal monospace kalmalı. Sadece computed font-family ismi gerçek font render kanıtı sayılmaz.
- [ ] Mevcut bütün CSS katmanları ve gerçek component ağacıyla dashboard, siteler, site dosyaları, DB, mail, DNS, SSL, Docker, Ayarlar ve AI ekranlarını 320/390/834/1440 px açık/koyu temada aç. Yeni çizgisiz yüzeylerin veri yoğunluğu ve seçili/hover/disabled/error ayrımı; tablo ve uzun dosya/domain adları; modal, dropdown/Diğer menüsü ve mobile drawer clipping kontrol edilsin.
- [ ] Gerçek Manrope/Outfit ile yüzde200 zoom, klavye focus, Chromium/Firefox, ekran okuyucu, reduced-motion ve forced-colors/touch kabulünü tamamla. Seçili 26 renk çiftinin sayısal testi tüm etkileşimlerin erişilebilirliğinin yerine geçmez.
- [ ] Yalnız izin verilen test hostunda yeni build'i dağıt; commit/asset/font hash ve cache yeniliğini doğrula. UX akışları, rol/scope ve mevcut phpMyAdmin kısıtı görsel tema yüzünden değişmemeli. Gerçek uygulamadan ekran görüntüleri üret; bu turun temsilî HTML/yedek-font görüntülerini canlı ekran diye sunma. İkinci Dribbble referansı erişilebilir dosya olarak geldiğinde görsel nüansları ayrıca değerlendir.

## T-SITE-WORKSPACE — 2026-09-22 Dosyalar / site içi e-posta ve veritabanı

Kaynak kapsamı, yerel testlerin sınırı ve açık phpMyAdmin kaynak işi: `docs/history/site-workspace-files-mail-db-2026-09-22.md`. 32 Node ve 42 örnek-verili bileşen kontrolü production/host kabulü değildir. `plan.md` YP-04 ve geniş UI hedefleri kapanmadı.

- [ ] Node >=24.11.1/npm >=11 ve üretim React/Vite bağımlılıklarıyla tam lint/test/build çalıştır. `apps/api/src/app.js` artık değişmeden taşınmış `management-app.js` uygulamasını site yetki katmanıyla sarar; eski route-mount metin beklentileri iç uygulamayı izlemeli, sınır kaldırılmamalı. İki gerçek site_manager ve bir Owner ile gerçek Express/auth/CSRF zincirini test et.
- [ ] Site A hesabıyla `/websites/<Domain-A>/files`, `/databases`, `/mail` reload/back/forward akışları; Site B'nin Domain/Website/binding/credential/mailbox/alias/job kimliklerini doğrudan API isteğine yerleştirme, body ile sahiplik taklidi, eksik veya yeniden atanmış registry ilişkileri doğrulansın. Global mail/DB envanteri ve başka siteye ait job sonucu/konfigürasyon/artifact metadatası sızmamalı. Salt okunur kullanıcı mutation yapmamalı.
- [ ] Dosya yöneticisinin klasör ağacı, deep path, symlink, Unicode/uzun dosya adı, 1000+ kayıt, liste/ızgara, gizli dosyalar, seçim, silme ve yeniden adlandırma işlemlerini site Unix kullanıcısı altında gerçek filesystem ile dene. Editörün değişmiş dosyaya yazmayı reddetmesi, draft uyarısı, büyük dosya ve kesilen upload sonrası yalnız kalan dosyaların yüklenmesi; Website değişiminde eski istek/state taşınmaması doğrulansın.
- [ ] Site içinden veritabanı credential create/apply, mevcut kullanıcı apply, parola rotation, revoke, doğrulanmış backup, restore ve delete/finalize zincirlerini gerçek MariaDB ile dene. API/job/grant kapsamı yalnız seçilen Website olmalı; failed/cancelled/timeout başarı gibi gösterilmemeli. Yeni bağımsız schema oluşturma bu turun kapsamına dahil değildir.
- [ ] Site yöneticisi phpMyAdmin geçişi güncel kaynakta kasıtlı olarak kapalıdır: `phpmyadmin_site_session_binding_required`. YP-04'teki panel-session + güncel Website yetkisi bağlı gateway/SQL session kaynak işi tamamlandıktan sonra gerçek PHP/Nginx ile Owner→Site A→Site B hesap değişimi, mevcut vendor cookie, logout/login, session rotation, kaldırılan Website yetkisi, cookie/capability replay ve doğrudan vendor URL testleri geçsin. Yalnız role bakarak gate açma; scoped handoff tek başına sonraki SQL oturumunu bağlamaz. Owner'ın mevcut akışı ayrıca regresyon testinden geçsin.
- [ ] E-posta site ekranında gerçek MailboxesPanel/MailAliasesPanel ile oluşturma, kota, parola ve yönlendirme işlemlerini; site scoped config-preview/apply ve durable job gözlemini test et. Disabled mail alan adı sırf hesap değişikliği uygulanıyor diye etkinleşmemeli; global mail domain veya artifact ayrıntıları site hesabına dönmemeli. Gerçek SMTP/IMAP teslimi ve Roundcube oturumu ayrı doğrulansın; örnek-verili webmail kartı bunların kanıtı değildir.
- [ ] Üretim bundle'ında 320/390/834/1440 CSS px, %200 zoom, Chromium/Firefox, klavye ve ekran okuyucuyla dosya ağacı/editör/modal, Diğer site menüsü, mail ve DB tablolarını doğrula. Mobil tablonun kendi kaydırması tüm sayfayı taşırmamalı. Eski açık tema tercihi korunurken Gece temasının güncel Ember grafit/mandalina referansına uyumu kullanıcıyla karşılaştırılsın.
- [ ] Yalnız izin verilen test hostuna API ve web sürümlerini birlikte dağıt; çalışan commit ve servis edilen asset hash'lerini doğrula. Yeni gerçek masaüstü/tablet/mobil ekran görüntülerini üret. Bu turdaki 15 örnek-verili bileşen ekranını canlı veya tam üretim bundle'ı kanıtı olarak gösterme.

## T-DB-UI — 2026-09-22 canlı veritabanı ve yetki kabulü (Antigravity)

- [ ] `.local/test-server.env` hedefinin `.44` olmadığı doğrulandıktan ve kod güvenli dağıtıldıktan sonra Owner ile `/databases` yenile: mevcut `roundcube` ve varsa `roundcube_*`/`roundcubemail*` satırı, toplam adet/boyut ve silme/backup/restore seçimlerinde görünmesin; doğrudan API istekleri reddedilsin, fiziksel altyapı şeması varlığını ve Roundcube oturumunu korusun. Bu turdaki kaynak testleri canlı sunucu doğrulaması değildir.
- [ ] Bağımsız ana Website yaratma/yenileme: site-admin e-posta/parola, mail ve MySQL kimlikleri ayrı; site-admin silme site yaşarken API'de de 409; Owner e-posta/parola düzenleyebilsin; site-admin başka Website'in DB/phpMyAdmin içeriğine erişemesin, kendi DB credential rotasyonu ve grant uygulaması canlı hostta çalışsın. Önceden var olan Website migrasyonu ve rollback veri kaybı olmadan gözlensin.
- [ ] Yeni ana site için local DNS, mail ve shared Roundcube webmail/SSL adımlarını gerçek hostta yarat, başarılı/blocked/partial/failure progress ve API yeniden giriş sonrası state'i tarayıcıda doğrula. Subdomain/alias yeni zone/mail/Roundcube kurmasın. Dış NS delegation, SMTP/IMAP teslimi, webmail oturumu ve sertifika erişimi ayrı doğrulansın. Hata enjeksiyonuyla üçüncü otomatik denemede durma, manuel retry, restart/idempotency ve compensation kanıtlansın.
- [ ] Owner kurtarma mailiyle tek kullanımlık reset, expired/used token, eski oturum iptali, rate-limit ve olmayan adres için aynı yanıt gerçek mail tesliminde doğrulansın; SMTP yokken başarı mesajı verilmesin. SSL formunda etkin kullanıcı e-postası gelsin, genel ACME varsayılanı ayrı kalsın; secret/URL/audit sızıntısı olmasın.

## T-VISUAL — 2026-09-22 tarayıcı görsel kabulü (Antigravity)

- [ ] Açık `/dashboard`, `/settings`, `/databases`, `/websites/new` sekmeleri ile kaynak sonrası Chromium/Firefox karşılaştırması yap: Ayarlar sekmeli/deep-link'li ve yalnız düzenlenebilir değerler içerir; mimari/sürüm bilgisi Sunucu > Tanılama'dadır. `[object Object]` yoktur, bilinmeyen servis hazır görünmez; servis ve terminal yalnız Sunucu, İşlemler/Denetim Ayarlar/Tanılama erişiminde bulunur.
- [ ] Genel bakışta Website listesi kaldırılıp sayısı/linki yerleşir; CPU/RAM/disk halkaları gerçek yüzdeyi doğru yay ve erişilebilir metinle yansıtır. 0, bilinmiyor, 91%, hata ve yüksek doluluk durumlarını; mobil, klavye, ekran okuyucu, reduced-motion ve koyu temayı test et. Uzun job ve loglar arayüzü taşırmaz; ilgili detay/kayıtlara erişim sürer.

### Onaylanan koyu konsol — 2026-09-22 kaynak sonrası kabul

Güncel kaynak ve kanıt sınırları: `docs/history/console-ui-component-validation-2026-09-22.md`. Yerelde 54 örnek-verili bileşen kontrolü ve 15 kaynak/model testi geçti. Tarayıcı harness'i React 18.2.0 kullandı; bu sonuç production React 19, tam build, auth veya gerçek sunucu kabulü değildir. Aşağıdakiler geçmeden bütün UI tamamlandı veya canlıya hazır denmez.

- [ ] Son `main` için Node >=24.11.1/npm >=11 ve repodaki gerçek React/Vite sürümleriyle `npm ci`, `npm run lint`, `npm test`, `npm run build` çalıştır. Yeni kaynak regresyon testleri dahil olsun. Teknik KeyValues alanları kapalı tanılamada korunur; yalnız eski yerleşimi bekleyen bir test yüzünden veritabanı arama/erişim/modal tasarımını topluca geri alma. Bileşen davranışını gerçek üretim bundle'ıyla doğrula.
- [ ] Yalnız izin verilen test hostuna normal dağıtım yoluyla güncel web build'ini dağıt; çalışan sürüm/commit ve tarayıcıya sunulan CSS/JS asset'lerinin güncel olduğunu doğrula. Yalnız repo commit'i veya örnek-verili görüntü canlı dağıtım kanıtı değildir.
- [ ] Yalnız izin verilen test hostunda `/dashboard`, `/websites`, `/databases` ve gerçek bir sitenin overview/node/deploy/domains/dns/ssl/resources/files/logs/terminal/settings deep linklerini 320, 390, 834 ve 1440 CSS px genişlikte Chromium ve Firefox'ta aç. Uzun domain, derin subdomain, boş liste, 100+ kayıt, stale/403/500 ve %200 zoom durumlarında sayfa taşması, kesilen işlem ve görünmez içerik olmamalı. Site/DB mobil satırlarının ekran okuyucudaki tablo ilişkileri korunmalı.
- [ ] Yeni tarayıcı profili Gece temasını açmalı; daha önce açık/sistem tema kaydeden kişinin tercihi değişmemeli. Sol menü > Görünüm tercihleri üzerinden tema/yoğunluk değişimi, depolama engeli ve iki sekmede storage event senkronu doğrulansın. Mobil üst çubukta arama, menü, AI ve aktif işler erişilebilir kalmalı.
- [ ] `/databases` satırında credential varsa phpMyAdmin aynı site kullanıcısıyla mevcut korumalı handoff üzerinden açılmalı. Credential yoksa erişim yapılandırma açıklaması ve doğru Domain-ID tabanlı site Kaynaklar bağlantısı; site bağı yoksa site seçimi görünmeli. Eksik paket, popup engeli, expired handoff ve backend retleri görünür hata üretmeli; root bypass, düz URL token'ı veya yanlış Website geçişi oluşmamalı.
- [ ] Veritabanı oluştur/sil işlemi failed veya cancelled biterse modal ve girilmiş veri korunmalı; succeeded olunca kapanmalı. Liste yenilenirken veya stale/error durumunda mutation/phpMyAdmin kapalı kalmalı. Arama, erişim filtresi, sayfalama ve geri/ileri URL davranışı gerçek oturumda doğrulansın.
- [ ] Dashboard grafiği gerçek API yenilemeleriyle büyüsün; aynı timestamp yeni ölçüm sayılmasın. Sayfa yeniden açıldığında olmayan 24 saatlik veri gösterilmesin. Bilinmeyen CPU/RAM/disk sıfır yapılmasın; oturum geçmişi kapsamı açık kalsın.
- [ ] `/mail` arama/mod filtreleri ve sayfalama; mail detayındaki altı bölüm gerçek alt panellerle doğrulansın. Sekmeler arası geçişte kullanıcı taslağı ve durable job gözlemi korunmalı; alan adı değişiminde eski state taşınmamalı. SMTP/DKIM/Roundcube/alias/konfigürasyon eylemlerini gerçek oturumda test et; üst-bileşen stub testi bu işlevlerin kabulü değildir.
- [ ] Site ana/alt menülerinin eski URL ve application query'sini koruduğunu; runtime'a göre desteklenmeyen araçların görünmediğini; Site Ayarları'na taşınan izolasyon audit/migration/rollback ve overview'de kalan provisioning recovery akışlarının erişilebilir olduğunu doğrula.
- [ ] Mobil menü ve görünüm details alanında Tab/Shift+Tab/Escape; native modal odağı ve dönüş odağı; reduced-motion ve forced-colors davranışlarını test et. Mail/Docker/DNS/SSL/AI/terminal/dosya sayfalarının ortak tema altında kalan eski sabit renkleri ve geniş tablolarını gerçek tarayıcıda kontrol et; vendor iframe içeriğini CSS filter ile değiştirme.
- [ ] Son kullanıcı onayı için gerçek üretim bundle'ından masaüstü/tablet/mobil ekran görüntüleri üret. Önceden üretilen tasarım kolajını veya bu turdaki açıkça örnek-verili bileşen görüntülerini canlı sunucunun görüntüsü olarak kullanma. Bu turda production deploy veya canlı ekran kabulü yapılmadı.

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