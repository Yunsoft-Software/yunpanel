# Plesk → YunPanel Rota ve İşlev Eşleme Matrisi

**Tarih / taban:** 2026-09-23; mevcut kaynak `80f3d1c4`. Hedef [kullanım sözleşmesidir](plesk-ux-spec.md). Bu matris canlı test sonucu değildir. Dosya veya route varlığı tamamlanmış özellik anlamına gelmez.

**İşaretler:** `R` mevcut yüzey yeniden yerleştirilecek/bağlanacak; `N` yeni giriş veya arayüz akışı gerekiyor; `V` mevcut motor/API kapasitesi ayrıca doğrulanacak; `X` Plesk'e birebir denk olmayan açık kapsam farkı. Bir satır birden fazla işaret taşıyabilir. Kaynak R01–R17 [atlas](plesk-reference-atlas.md#resmi-kaynak-kaydi) içindedir.

## 1. Kimlik ve route sözleşmesi

Mevcut `/websites/:websiteId/:tab?` rotasında parametre adı yanıltıcıdır: `SiteDetailPage` önce `domain.id` ile arıyor, gerçek Website kaydını `domain.websiteId` üzerinden buluyor. Aşağıdaki tabloda bu eski segment **`:domainId`** diye yazılır; URL'ler taşınmış veya backend ID'leri değiştirilmiş değildir.

Yeni `/files` ana girişi bir disk erişim motoru değil, scope çözücüdür. `?site=<WebsiteID>` varsa API'den güncel yetkili Website ilişkisi doğrulanır; eski `/websites/<DomainID>/files` aynı dosya ekranına domain ilişkisi üzerinden ulaşır. `site` veya `path` query'si tek başına yetki değildir. Bir kaynağın iki meşru girişi olması iki ayrı state/motor kurulmasını gerektirmez.

Önerilen yeni URL'ler **henüz uygulanmadı**. Route adını geliştirici değiştirirse bu matris ve uyumluluk testi aynı committe güncellenir. Kullanıcıya görünen Plesk görev yeri değiştirilmez.

## 2. Ana navigasyon

| ID | Plesk görevi / kaynak | Mevcut YunPanel | Hedef yol / yer | Rol ve kapsam | İş / kapanış |
| --- | --- | --- | --- | --- | --- |
| NAV-01 | Websites & Domains, R01/R02 | `/websites`, WebsitesPage | Aynı URL; varsayılan `/` → `/websites` | İzinli tüm siteler | R; kart/liste, arama, aç/kapat ve reload |
| NAV-02 | Mail, R07 | `/mail`, `/mail/:mailDomainId` | Aynı yollar; site filtresi, gerçek hesap görevleri | Yetkili site maili; Owner bütün izinli envanter | R; global/site giriş aynı sonucu üretir |
| NAV-03 | **Files**, R01/R05 | **Global route ve nav yok** | **Yeni `/files`** → bağlam çözücü → mevcut dosya yüzeyi | Dosya yetkisi verilen Website'ler | N; ilk teslim, T-PL-02/04 |
| NAV-04 | Databases, R08 | `/databases`, DatabasesPage | Aynı URL; site filtreli DB ve kullanıcılar | Site scope, Owner; altyapı DB gizli | R/V; schema/credential ayrımı, phpMyAdmin gate |
| NAV-05 | Statistics, R01 | Ana menüde ayrı karşılık yok | Yeni `/statistics`; site filtresi; mevcut rapor adapter'ları | Yetkili site; host ölçümü ayrı | N/V; gerçek veri, unknown/stale ayrımı |
| NAV-06 | Tools & Settings, R01/R16 | `/servers` ve `/settings` bölünmüş | Yeni `/tools-settings`; eski linkler alt görevlerine uyumlu | Owner | N/R; yalnız kabuk birleştirme, sunucu seçici eklenmez |
| NAV-07 | Users, R01 | `/settings/users`, UsersPage | Yeni `/users` veya uyumlu alias; sol menü Kullanıcılar | Owner; sınırlı role yeni yetki otomatik verilmez | R; eski link çalışır, son Owner korunur |
| NAV-08 | My Profile / Account, R03 | AccountDialog/MFA bileşenleri; bağımsız route yok | Üst kullanıcı menüsü + `/profile` önerisi | Kendi hesabı | R/N; parola/e-posta/oturum/MFA ayrı görevler |
| NAV-09 | Extensions / toolkit | Global Docker ve bazı ayar yüzeyleri | Gerçek kurulu entegrasyonlar için araç yönetimi; sahte katalog yok | Owner veya mevcut scoped tool yetkisi | V/X; yerleştirme kapasiteye bağlı |
| NAV-10 | Plesk Applications kataloğu | `/applications` runtime envanteri | Katalogla eşlenmez; runtime site aracında, legacy inventory Tanılama'da | Owner legacy envanter | X; label değiştirerek yanlış eşleme yapılmaz |
| NAV-11 | Server overview | `/dashboard` | İşlevler korunur; Plesk uyumlu genel/server durum alanı | Yetkili ölçümler | R; eski route boşaltılmaz, yeni ana giriş değildir |
| NAV-12 | YunPanel AI ve işler | AiDrawer, JobDrawer, `/jobs`, `/audit` | Üst açık kısayol; kaynak içi iş bağlantıları; audit Owner/güncel role göre | Mevcut API yetkisi | R/X; Files'ın yerine chat konulmaz |

## 3. Site görevleri

| ID | Plesk konumu | Mevcut URL / bileşen | Hedef akış | Fark / işaret | Kabul |
| --- | --- | --- | --- | --- | --- |
| SITE-01 | Add Domain, R02 | `/websites/new`, NewWebsitePage | Websites & Domains üst eylem → tür/alan/ilişki → oluşturma | R; yaratılan şey Website mi Domain mi açık | T-PL-03/06 |
| SITE-02 | Add Subdomain / Alias, R02 | `/websites/new?parent=...`, DomainOperations ve advanced domains | Ayrı anlamlı eylemler; parent hazır; shared/bağımsız farkı korunur | R/V; alias yeni mailbox/runtime sanılmaz | T-PL-06 |
| SITE-03 | Domain card Dashboard | `/websites/:domainId/overview`, SiteDetailPage | Genişleyen kartta site araçları; deep link korunur | R; öncelik teknik recovery değil günlük görev | T-PL-03 |
| SITE-04 | **File Manager / document root**, R03/R06 | `/websites/:domainId/files`, FilesPanel | Bir açık eylemle aynı Website dosya kökü | R; canManage/runtime/binding filtresi incelenir | **T-PL-04/05** |
| SITE-05 | Dashboard → Databases, R08 | `/websites/:domainId/databases`, SiteResourcesPanel | Aynı DB liste/işlemleri hazır site filtresiyle | R/V; global envantere savurma yok | T-PL-08 |
| SITE-06 | Mail tab → mail accounts/settings, R07 | `/websites/:domainId/mail`, SiteResourcesPanel/MailboxesPanel | Liste → create/edit/alias/forward/quota/delete → sonuç | R/N; mailbox delete UI eksik kaynak bulgusu | T-PL-07 |
| SITE-07 | Dashboard → SSL/TLS Certificates, R09 | `/websites/:domainId/ssl`, SslOperations | Özet → issue/renew/test → gerçek sonuç → domain | R; BUG-04/05/06 | T-PL-09 |
| SITE-08 | Hosting & DNS → DNS, R03/R10 | `/websites/:domainId/dns`, DnsPanel | Record list → add/edit/delete → açık apply/verify | R; dış DNS/local ayrımı | T-PL-10 |
| SITE-09 | Hosting & DNS → Hosting, R11 | `/websites/:domainId/settings`, DomainOperations teknik bilgileri | Gerçek düzenlenebilir hosting formu; kimlik JSON'u değil | R/N/V; backend ayar kapsamı teyit edilir | T-PL-10 |
| SITE-10 | Hosting/access → SFTP counterpart | WebsiteIsolationPanel, site resource/access adapter'ları | Ayrı görünür bağlantı/kimlik/anahtar ve izinli kök | R/V/X; FTP yokken SFTP etiketi | T-PL-05/12 |
| SITE-11 | Dashboard → Node.js, R12 | `/websites/:domainId/node`, ApplicationOperations/EnvironmentPanel | Root/startup/mode/version/env/install/script/restart | R/V; mevcut destek ve yeni gerekli akış ayırt | T-PL-11 |
| SITE-12 | Dashboard → PHP, R11 | Runtime/adapter varlığı planlarda; ayrı PHP route mevcut router'da yok | Yeni `/websites/:domainId/php` araç yüzeyi önerisi | N/V; hazır PHP-FPM adapter'ı, sahte Apache yok | T-PL-11 |
| SITE-13 | Dashboard → Git, R13 | `/websites/:domainId/deploy`, ApplicationOperations | Git ekranı; repo/branch/hedef/deploy, release/rollback | R/V; URL korunabilir; gerçek repo desteği görünür | T-PL-11 |
| SITE-14 | Dashboard → Logs | `/websites/:domainId/logs`, LogsPanel | Kaynak/servis filtreleri, takip, indir, işe geri bağlan | R/V; HTTP log vs job/audit ayrı | T-PL-11 |
| SITE-15 | Scheduled Tasks, R14 | Website cron backend/önceki kabul; router'da ayrı site cron tabı yok | Yeni `/websites/:domainId/scheduled-tasks` önerisi | N/V; site user/timezone, existing cron motoru | T-PL-11 |
| SITE-16 | Dashboard → Backup & Restore, R03/R15 | Root `/backups` CapabilityPage; backend restore işleri mevcut | Yeni site `/websites/:domainId/backups`; global Owner ayrı | N/V; mevcut site backup motoru, gerçek restore | T-PL-11 |
| SITE-17 | Web Statistics | Site logs/GoAccess ve mevcut metrics | `/statistics?site=<WebsiteID>`; site kartından scope hazır | R/N/V; ayrı motor yok | T-PL-11 |
| SITE-18 | Domain remove / suspend | Backend removal/suspension lifecycle; site settings esasen metadata | Domain eylemi → etki → onay → job → liste | N/R; backend guard'lar korunur, BUG-02 | T-PL-06 |
| SITE-19 | Website status/actions | DomainOperations stage/activate | Kullanıcı dilinde konfigürasyon/yayın; teknik aşama ayrıntıda | R; üç elle komut normal workflow olmasın | T-PL-06/13 |
| SITE-20 | Terminal / SSH counterpart | `/websites/:domainId/terminal`, LazyTerminalPanel | Site erişim aracı; host/root ayrı Owner tool | R/X; gerçek destekli site runtime'ları | T-PL-12 |
| SITE-21 | Python / Docker runtime | Python adapter; `/docker/:dockerProjectId` | Site Dashboard bağlı runtime aracından scoped geçiş | R/V/X; doğrulanmamış Plesk birebirliği iddia edilmez | T-PL-11/12 |

## 4. Owner araçları

| ID | Plesk yeri | YunPanel eşlemesi | Açık iş / korunacak sınır |
| --- | --- | --- | --- |
| SYS-01 | Tools & Settings → Security → Firewall | Firewall gerçek durum/port/CrowdSec yönetimi | PROD-01–05; global flush, özel SSH portu, unknown ve rollback |
| SYS-02 | Tools & Settings → Services Management | Mevcut managed-service install/control/inspect | Yeni motor yok; serviceEnabled talep değil gerçek sonuç |
| SYS-03 | Tools & Settings → DNS Settings | Server DNS template / identity | Domain DNS ekranından ayrı; tek hostu iki bağımsız NS gösterme |
| SYS-04 | Tools & Settings → Mail Server Settings | Mevcut mail service/config/readiness | Domain mailbox parolası ile sunucu identity karışmasın |
| SYS-05 | Tools & Settings → Database Servers | MariaDB servis ve güvenlik envanteri | Global kullanıcı DB listesi değil, altyapı şeması müşteriye sızmaz |
| SYS-06 | Tools & Settings → Backup Manager / Updates | Mevcut restic/rclone, package/update adapter'ları | Site backup ayrı; schema/asset/build uyuşması; PROD-08–10 |
| SYS-07 | Tools & Settings → panel/profile/notifications | Mevcut SettingsPage/account/AI settings | Gerçek form; YP-11 reset, PROD-07 teslim, güvenli tokenlar |
| SYS-08 | Host terminal / diagnostics | Owner terminal, jobs/audit ve build kimlikleri | Root açık etiketli; .44 ve uzak sunucu seçimi yok |

## 5. Kaybolmama / izin modeline ilişkin sözleşme

Bir UI permission boolean bütün araçları gizlemek için kullanılmaz. İlgili görev durumları en az `loading`, `available`, `not_configured`, `dependency_missing`, `unsupported`, `forbidden`, `failed`, `stale` olarak ayrılır. Kullanıcının bilmemesi gereken başka site kaynağı gösterilmez. Kendi izinli site aracının yükleme veya setup hatası, menüyü silme gerekçesi değildir.

`capabilities` gibi merkezi görünüm çözümü uygulanacaksa mevcut auth'un alternatifi değildir; API yine yetkiyi her istekte kontrol eder. Salt okunur role file-read açılması gerektiğinde bu gerçek yeni yetki ayrı değerlendirilir; sadece buton açmak kabul değildir. Plesk yerleşimini eşlemek güvenlik kontrollerini atlatma yetkisi vermez.

## 6. Eski URL uyumluluk listesi

- `/websites/<DomainID>/files`, `/ssl`, `/dns`, `/node`, `/deploy`, `/logs`, `/settings`, `/mail`, `/databases`, `/terminal`, `/resources`, `/overview`: işlev ve kimlik korunur. UI tabları değişse de eski deep link çalışır veya doğru yeni göreve tek güvenli yönlendirme yapar.
- `/settings/users`: Kullanıcılar'a alias; kullanıcı rolü korunur.
- `/servers`, `/settings`: yeni Tools & Settings'in doğru alt konumuna eşlenir; gizli eski ekran ve farklı config writer bırakılmaz.
- `/dashboard`: mevcut sağlık kapasitesi korunur; `/` giriş değişimi ayrı açık karardır.
- `/applications`, `/domains`: Owner gelişmiş envanter olarak erişilebilir kalır; günlük Plesk kartı yerine kullanılmaz.
- `/backups`: Owner scope korunur; query eklenince site kullanıcısına global backup açılmaz.
- `returnTo`, arama, sayfa, site ve path query'leri allowlist/encoding ile işlenir; açık yönlendirme veya dosya yetkisi üretmez.

## 7. Kapanışın kanıtı

Matris satırı ancak yeni girişten yapılan gerçek işlem, eski link, rol/scope ve geri dönüş kabulü birlikte geçince tamamlanır. Kod tarafı hazır fakat host/browser kanıtı yoksa `V — dış kabul bekliyor` kalır. Screenshot'a araç çizmek, route dosyası eklemek veya 200 JSON görmek 'çalışıyor' demek değildir. Kabul ID'leri [T-PL listesine](plesk-browser-acceptance.md) gider.
