# T883 gerçek kapsam ve sonraki öncelikler — 12 Kasım 2026

**Durum: çalışma sürüyor. Bu belge henüz nihai kabul raporu değildir.** T883 yeniden açık; başarılı kaynak kontrolleri veya tek bir yeşil koşu tüm davranışların kabulü sayılmaz.

## Kapsam ve sürüm

Kullanıcı önce T883 kapsam açığının gerçek `.28` sonuçlarıyla kapatılmasını, ardından site kopyalama ve kalan işler için öncelikli plan istedi. Bu dilim yeni özellik uygulaması veya dağıtım içermez. Yerel dal `12-11-2026`, taban `a2fdc8c1`. Kurulu native paket `0.3.0-2026111001` ve ürün kaynağı `a2fdc8c1`; yeni testler yerel Playwright üzerinden bu gerçek pakete gider.

İlk bağımsız kaynak/assertion denetimi: 32 literal test çağrısı parametrelerle **38 mantıksal senaryo** olur. Eski ayarda Chromium38 + Firefox21 = **59 koşu** vardı; 59 farklı özellik yoktur. Önceki T883 matrisi kabul kanıtı olarak kullanılmaz. Silinen kaynaklar `ba33f4a8^` içinde korunur. Denetimde tam karşılık0, kısmi22, eksik16 bulundu; bu sayılar canlı sonuç değildir.

## Başlangıç davranış matrisi

Aşağıdaki her satır eski davranışın assertion kapsamıdır. Güncel test başlığı ve iki gerçek koşu / bulgu / açık kanal sonucu çalışmalar tamamlandığında eklenecek. Koşuldan atlanan veya upstream hata nedeniyle çalışmayan assertion geçmedi.

| Eski senaryo | Korunacak davranış | Önceki karşılık | Gerçek test karşılığı | Nihai canlı kabul |
|---|---|---|---|---|
| 13.1 | Static normal form, actual upload/HTTP/no Git | Kısmi | [13-native-source-mutation.spec.js](../e2e/live-audit/13-native-source-mutation.spec.js): `@mutation source three-step form creates an uploaded static site without Git and serves the actual uploaded HTML` | Bekliyor |
| 13.2 | phpMyAdmin repair actual applied gateway health | Kısmi | [13-native-source-mutation.spec.js](../e2e/live-audit/13-native-source-mutation.spec.js): `@mutation @managed-repair source managed phpMyAdmin repair stages actual templates and verifies the native gateway` | Bekliyor |
| 13.3 | Static removal all3 identities and PHP sibling | Kısmi | [13-native-source-mutation.spec.js](../e2e/live-audit/13-native-source-mutation.spec.js): `@mutation source uploaded static Website removal completes its real lifecycle and preserves the PHP sibling` | Bekliyor |
| 13.4 | Interrupted orphan Domain recovery | Eksik | [13 kaynağındaki açık kabul kaydı](../e2e/live-audit/13-native-source-mutation.spec.js); eski orphan fault bu kanalda üretilmedi | Bekliyor |
| 13.5 | One DB form + binding/grants + application SQL query | Kısmi | [13-native-source-mutation.spec.js](../e2e/live-audit/13-native-source-mutation.spec.js): `@mutation source one database form creates real schema, binding, grants and an application query` | Bekliyor |
| 13.6 | phpMyAdmin real SQL-file import + app row + own table DROP | Eksik | [13-native-source-mutation.spec.js](../e2e/live-audit/13-native-source-mutation.spec.js): `@mutation source SQL import uploads a real SQL file through phpMyAdmin, verifies the database row and removes only its table` | Bekliyor |
| 13.7 | Actual changed PHP version + FPM settings persistence | Kısmi | [13-native-source-mutation.spec.js](../e2e/live-audit/13-native-source-mutation.spec.js): `@mutation source PHP settings change the actual FPM runtime and persist at the installed version` | Bekliyor |
| 13.8 | WordPress install/admin login/password rotation login | Kısmi | [13-native-source-mutation.spec.js](../e2e/live-audit/13-native-source-mutation.spec.js): `@mutation source WordPress installs in Turkish against the real site DB and authenticates in a fresh browser` + [13-native-source-mutation.spec.js](../e2e/live-audit/13-native-source-mutation.spec.js): `@mutation source WordPress administrator password rotates through the UI and authenticates in a fresh browser` | Bekliyor |
| 13.9 | Mail domain + two mailbox UI forms and applied service | Kısmi | [13-native-source-mutation.spec.js](../e2e/live-audit/13-native-source-mutation.spec.js): `@mutation source mail domain and mailbox forms apply the actual service before closing` | Bekliyor |
| 13.10 | Unique SMTP message read by authenticated recipient IMAP | Eksik | [13-native-source-mutation.spec.js](../e2e/live-audit/13-native-source-mutation.spec.js): `@mutation source actual IMAP authentication finds the SMTP test message only in the owned recipient` | Bekliyor |
| 13.11 | One snapshot file + SQL + mail configuration + protected environment restore | Kısmi | [13-native-source-mutation.spec.js](../e2e/live-audit/13-native-source-mutation.spec.js): `@mutation source real backup restores file content, SQL, mailbox authentication and the protected environment secret` | Bekliyor |
| 13.12 | WP plugin AND theme lifecycle with HTTP | Kısmi | [13-native-source-mutation.spec.js](../e2e/live-audit/13-native-source-mutation.spec.js): `@mutation source WordPress plugin and theme lifecycle changes real inventory and keeps the actual site responding` | Bekliyor |
| 13.13 | CLI success + broken HTTP refuses and rollback verified | Eksik | [13-native-source-mutation.spec.js](../e2e/live-audit/13-native-source-mutation.spec.js): `@mutation source WordPress refuses CLI success when a plugin breaks actual HTTP and verifies the real backup rollback` | Bekliyor |
| 13.14 | WP core.update durable worker/checksums/HTTP | Eksik | [13-native-source-mutation.spec.js](../e2e/live-audit/13-native-source-mutation.spec.js): `@mutation source WordPress core update verifies real checksums, inventory and HTTP through the current worker` | Bekliyor |
| 13.15 | WP prefix-only uninstall/unrelated preserve + same backup restore | Kısmi | [13-native-source-mutation.spec.js](../e2e/live-audit/13-native-source-mutation.spec.js): `@mutation source WordPress removal removes actual core files and prefix tables, preserves other content, then restores the owned installation` | Bekliyor |
| 15.1 | Blocked exact removal journal resume | Eksik | [15-native-source-removal-mutation.spec.js](../e2e/live-audit/15-native-source-removal-mutation.spec.js): `@mutation source revoking only the initiating session blocks and resumes the exact owned removal journal` | Bekliyor |
| 15.2 | Single UI confirm, browser closure AND real API restart persistence | Eksik | [15-native-source-removal-mutation.spec.js](../e2e/live-audit/15-native-source-removal-mutation.spec.js): `@mutation source one browser confirmation survives browser closure and completes with the same native worker journal` | Bekliyor |
| 16.1 | Recorded owned DNS/health/Nginx-conflict recovery | Eksik | [16-native-hosting-dns-restore.spec.js](../e2e/live-audit/16-native-hosting-dns-restore.spec.js): `@mutation reconciles only the current owned ledger DNS hosting and health artifacts` | Bekliyor |
| 16.2 | Same snapshot DNS/hosting restore twice + failed-health rollback | Eksik | [16-native-hosting-dns-restore.spec.js](../e2e/live-audit/16-native-hosting-dns-restore.spec.js): `@mutation restores actual TXT Nginx bytes and settings twice and rolls back a real failed health check` | Bekliyor |
| 18.1 | Normal Node form + actual Passenger provisioned HTTP | Kısmi | [18-native-application-environment.spec.js](../e2e/live-audit/18-native-application-environment.spec.js): `@mutation normal Node form provisions one dedicated real Passenger application from the current public sample` | Bekliyor |
| 18.2 | Actual running nonroot Node secret process restore twice | Eksik | [18-native-application-environment.spec.js](../e2e/live-audit/18-native-application-environment.spec.js): `@mutation same snapshot restores a secret twice in the actual dedicated running Node process` | Bekliyor |
| 19.1 | Interrupted hosting drafts for PHP/Node/static recovery | Eksik | [19-native-hosting-settings.spec.js](../e2e/live-audit/19-native-hosting-settings.spec.js): `@mutation reconciles only this run ledger hosting draft and removes only its recorded health file` | Bekliyor |
| 19.php | PHP one form header/body/cache actual HTTP | Eksik | [19-native-hosting-settings.spec.js](../e2e/live-audit/19-native-hosting-settings.spec.js): `@mutation php hosting saves once and changes actual response headers body limits and cache` | Bekliyor |
| 19.node | Node one form header/body actual HTTP | Eksik | [19-native-hosting-settings.spec.js](../e2e/live-audit/19-native-hosting-settings.spec.js): `@mutation node hosting saves once and changes actual response headers body limits and cache` | Bekliyor |
| 19.static | Static one form header/body/cache actual HTTP | Kısmi | [19-native-hosting-settings.spec.js](../e2e/live-audit/19-native-hosting-settings.spec.js): `@mutation static hosting saves once and changes actual response headers body limits and cache` | Bekliyor |
| 19.320 | 320px one save/no dialog/overflow/pageerror | Kısmi | [19-native-hosting-settings.spec.js](../e2e/live-audit/19-native-hosting-settings.spec.js): `@mutation hosting settings retain one reachable form at width 320` | Bekliyor |
| 19.390 | 390px one save/no dialog/overflow/pageerror | Kısmi | [19-native-hosting-settings.spec.js](../e2e/live-audit/19-native-hosting-settings.spec.js): `@mutation hosting settings retain one reachable form at width 390` | Bekliyor |
| 19.834 | 834px one save/no dialog/overflow/pageerror | Kısmi | [19-native-hosting-settings.spec.js](../e2e/live-audit/19-native-hosting-settings.spec.js): `@mutation hosting settings retain one reachable form at width 834` | Bekliyor |
| 19.1440 | 1440px one save/no dialog/overflow/pageerror | Kısmi | [19-native-hosting-settings.spec.js](../e2e/live-audit/19-native-hosting-settings.spec.js): `@mutation hosting settings retain one reachable form at width 1440` | Bekliyor |
| 19.reserved | Set-Cookie rejected in UI with zero mutation requests | Kısmi | [19-native-hosting-settings.spec.js](../e2e/live-audit/19-native-hosting-settings.spec.js): `@mutation hosting rejects protocol-managed headers before any preview or write request` | Bekliyor |
| 20.1 | Two reseller customers + direct customer real sites/UID/files/HTTP | Kısmi | [20-native-tenant-sites.spec.js](../e2e/live-audit/20-native-tenant-sites.spec.js): `@mutation tenant normal UI creates three distinct real sites for two reseller customers and a direct customer` | Bekliyor |
| 20.2 | Five actors APIs/jobs/tools/WS/parent revocation | Kısmi | [20-native-tenant-sites.spec.js](../e2e/live-audit/20-native-tenant-sites.spec.js): `@mutation tenant five actors enforce site API job and tool boundaries and real PTYs revoke only the disabled parent chain` | Bekliyor |
| 20.3 | Three normal UI removals + physical roots/Unix/accounts absence | Kısmi | [20-native-tenant-sites.spec.js](../e2e/live-audit/20-native-tenant-sites.spec.js): `@mutation tenant normal UI removes the three owned sites before exact hosting profiles and logins are deleted` | Bekliyor |
| 22.1 | Recorded index/error preferences + exact owned file recovery | Eksik | [22-native-hosting-file-settings.spec.js](../e2e/live-audit/22-native-hosting-file-settings.spec.js): `@mutation reconciles only owned current ledger index and error preferences and exact test files` | Bekliyor |
| 22.php | PHP index/errors preserve403404500502503504 actual statuses | Eksik | [22-native-hosting-file-settings.spec.js](../e2e/live-audit/22-native-hosting-file-settings.spec.js): `@mutation php index and error settings change real content while preserving actual HTTP statuses` | Bekliyor |
| 22.static | Static custom index/403404/direct errorURL404 | Kısmi | [22-native-hosting-file-settings.spec.js](../e2e/live-audit/22-native-hosting-file-settings.spec.js): `@mutation static index and error settings change real content while preserving actual HTTP statuses` | Bekliyor |
| 22.unsafe | Unsafe index/external error URL UI zero mutations | Kısmi | [22-native-hosting-file-settings.spec.js](../e2e/live-audit/22-native-hosting-file-settings.spec.js): `@mutation unsafe index and external error preferences reject before any preview or mutation` | Bekliyor |
| 22.node | Passenger index/error PHP/static controls absent | Eksik | [22-native-hosting-file-settings.spec.js](../e2e/live-audit/22-native-hosting-file-settings.spec.js): `@mutation Passenger hosting excludes PHP and static index and error controls` | Bekliyor |

Yeni kaynak keşfi (henüz nihai koşu sonucu değil): **39 mantıksal test / 61 yapılandırılmış proje koşusu**. Ayrı depo-init regresyonu eklendi; WordPress parola testi kurulumdan ayrıldı, tarihsel orphan kaydı ayrı açık kapıda tutuluyor. Bu yeni payda eski 38 davranışın yerine geçmez.

## Yürütme ve açık bulgular

Ortak yardımcı T885 (`96bf599e`) bağımsız gerçek create/upload/HTTP/UID/removal ve fiziksel yokluk kontrolleriyle kabul edildi. T890 (`28d4aaf5`, kabul `f8e7f89c`) yalnız belgeli preexecution `site_mutation_locked` cevabından sonra aynı durable işlem okunup sınırlı yeniden deneme sağlar; gerçek hata ve belirsiz transport kör tekrarlanmaz. Gerçek API PHP busy dalı ve gerçek UI statik yol ayrıca çalıştı. Sahipli ledger, canonical dört kök, Unix kullanıcı/grup, PHP/elFinder havuz ve socketleri, Nginx ve mount yokluğu API404'ten ayrı ölçülür.

| Bulgu | Gerçek gözlem | Kabul etkisi |
|---|---|---|
| T889 | İlk PHP smoke `php_fpm_apply_unverified`; sonraki yeni PHP denemeleri geçti, neden kanıtlanmadı | Aralıklı kurulum kararlılığı açık |
| T891 | PHP cache120 ayarı preview200/PATCH200, stage400 `invalid_operation_payload`; UI ve taze API ile tekrarlandı | PHP ayarı uygulanmış sayılamaz |
| T892 | T891 sonrası normal silme üç kimliği/Unix/kökleri kaldırıyor, iki bağımsız yaşam döngüsünde aktif Nginx dosyası kalıyor | Fiziksel temizlik kapısı geçmedi; dosyalar elle silinmedi |
| T893 | `initialize:true` depo oluşturma201 fakat `uninitialized`; ayrı regresyon ve init/check hazırlığıyla araştırılıyor | Depo hazır ve restore çalıştı diye yazılamaz |
| T894 | Normal hosted UI409 sonrası hata durumunda; aynı gerçek işlem hazır ve10zorunluadım başarılı; Chrome ve Firefox tekrarı | UI kabulü geçmedi; rol testleri bundan bağımsız çalıştırılıyor |
| T897 | Ayrı statik site kaldırıldıktan sonra daha önce çalışan PHP/WordPress kardeş root HTTP502 verdi | Kardeş sürekliliği açık; neden henüz kanıtlanmadı |

WordPress parola503 henüz güvenli hata kodu ve durable request okunarak ayrıştırılıyor; henüz kök neden veya başarı iddiası yok. İlk debuglardaki UI selector, Playwright independent context storageState ve yardımcı continuation çakışmaları test kusuru olarak ayrıldı; ürün hatası diye yazılmadı.

## Açık kabul kanalları

- `.28` üzerinde yalnız PHP8.3 kurulu. PHP ayarlarının fiziksel uygulanması ayrı; farklı iki PHP sürümü arasında geçiş henüz kanıtlanamaz.
- Gerçek panel API servis restart testi bu çalışma kanalında yapılmaz. Browser kapanışı ve aynı removal journal worker tamamlanması ayrı gerçek testtir; restart eşdeğeri değildir.
- Eski Ekim candidate'ının hardcoded orphan/DNS/draft kayıtları geri kurulmaz. Normal güncel own-ledger reconciliation ve tarihsel kesinti-recovery assertionları ayrı gösterilir; açıklanmayan satır silinmez.
- T892'nin testlere ait iki Nginx artığı exact ledger/readback ile kayıtlıdır; kayıtları silinmiş kaynağın dosyasına panel arkasından müdahale edilmedi. Bu durum toplam temiz kabulüne engeldir.

## Öncelik önerisi — nihai test sonuçları bekleniyor

1. **P0: veri güvenliği ve doğru sonuç.** T891/T892, depo initialization tutarlılığı T893, native kurulum görünümü T894 ve PHP sürekliliği T889/T897 önce kapanmalı. Kırmızı gerçek senaryolar aynı sürümde tekrar geçmeden genel kullanılabilirlik iddiası yok. Yeni kopyalama, bu motorların güvenilirliği üzerine kurulacak.
2. **P1: aynı sunucuda genel site kopyalama.** İlk dilim ayrı Unix kullanıcısına sahip boş hedefe statik/PHP dosyaları ve isteğe bağlı ayrı DB. Kaynak korunur; dolu/aynı/yetkisiz hedef reddedilir. Önizleme, iki tarafta yetki ve kilit, kaynak/hedef revizyonu, dosya hash ve sahipliği, kalıcı işlem, kayıp cevap/çift tık/kesinti ve normal temizlik kabulün parçasıdır. DNS/SSL/posta/cron ve sırlar için taşıma tercihleri ayrı ve açık olmalı.
3. **P1: WordPress klon/staging kabulü.** `wordpress-clone-service.js` zaten var: ayrı hedef DB/kullanıcı, prefix tabloları, serialized search-replace, home/siteurl ve staging noindex/cron davranışı yeniden yazılmadan gerçek test edilir. Genel site kopyalama mevcut değildir. Mevcut WP klon sınırları tek dosya16MiB, toplam256MiB, SQL16MiB; büyük site/multisite/non-root URL kapsamı ayrıca tasarlanır. Kısmi hedef için güvenli devam/temizlik de kabul edilir.
4. **P2: günlük barındırma.** PHP çoklu sürüm/retirement; Node/Python Git deploy/restart/rollback ve çalışan süreç ortamı; Docker/Compose port/subpath proxy ve kalıcı volume temizliği; dosya/DB/posta içerikli site silmede kardeş korunması. Her motor için gerçek içerik ve yetki sınırı ölçülür.
5. **P2: DNS/SSL/posta/yedek.** Shared zone/DNSSEC koruma, disk sertifika-SNI eşitliği, Roundcube/SMTP/IMAP, tek mailbox silerken kardeş teslimat, gerçek seçici restore/aynı snapshot iki kez/health rollback ve planlı yedek. Eski bildirime ait DKIM/rDNS kararı otomatik değiştirilmez.
6. **P3: kullanım ve geçiş.** Mobil/klavye/rol görevleri; site+mail import/migration; wildcard, ek FTP, PHP eklentileri, hotlink ve Nginx cache. Önce 07-11 tarihinde yapılmış denen yönlendirme/şifreli dizin/bildirim/live log/smarthost/otomasyonAPI kanıtları karşılaştırılır; eski checkbox yüzünden baştan geliştirilmez.
7. **Ayrı faz:** Ubuntu/Debian/RHEL sürüm matrisi ayrı gerçek hostlarda; Windows/IIS/.NET/MSSQL ayrı hat. Ertelenmiş reseller paket/faturalama/login-as ve premium ürünler ilk Linux panelinin kabulüne karıştırılmaz.

Bu plan öneridir; kopyalama özelliği uygulanmadı. Son kapsam ve kabul kapıları yeni sonuçlarla kesinleştirilecek. Kaynaklar: `docs/DEVIR.md`§8, `docs/plesk-eksikler.md`07-11 notu, `docs/plesk-feature-parity.md`, `apps/api/src/wordpress-clone-service.js` ve güncel görev raporları. Kök eski `plan.md` tarihli durum satırları güncel kabul sayılmaz.
