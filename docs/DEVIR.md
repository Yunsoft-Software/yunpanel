# YunPanel — Devir notu (projeyi devralan buradan başlasın)

Güncelleme: 26 Kasım 2026. Bu belge projenin **şu anki durumu** için tek kaynaktır. Bağlayıcı kurallar [agents.md](../agents.md), [orkestra kuralları](orkestra/KURALLAR.md) ve [proje kuralları](orkestra/PROJE.md) içindedir; çelişkide onlar geçerlidir. 7–9 Kasım sürümü [arşivde](history/devir-2026-11-09.md).

Okuma sırası: bu belge → [plan.md](../plan.md) (açık işler) → [todo.md](../todo.md) (açık canlı kabuller) → [Plesk karşılaştırması](plesk-feature-parity.md) → işle ilgili [görev kaydı](gorevler/).

## 1. Proje nedir

Yunsoft'un kendi hosting paneli. Plesk Obsidian'ın ekran düzeni, iş akışları ve özelliklerinin Node/React ile işlevsel karşılığı. Günlük merkez Web Siteleri ekranıdır. Dosya, veritabanı, SSL, posta, DNS, çalışma ortamı (PHP, Node Passenger, Python, statik, Docker), yedek ve erişim aynı site bağlamında yönetilir.

| Klasör | İçerik |
|---|---|
| `apps/api` | Node arka uç (root yetkisi yalnız burada). Giriş `src/index.js`, modüller `src/<alan>/` (aşağıdaki tablo), testler `test/`. |
| `apps/web` | React/JSX arayüz (Vite). Ortak bileşenler `src/workspace/design-system/` ve `src/workspace/PanelKit.jsx`. |
| `packages/host-runtime` | Sunucu adaptörleri (nginx, PHP-FPM, posta, DNS, kullanıcı…). |
| `packages/config-templates`, `protocol`, `shared` | Şablonlar ve ortak kod. |
| `e2e/ozellik` | Gerçek test sunucusunda koşan özellik testleri (Playwright). |
| `e2e/live-audit` | Ayrı ayarla koşan canlı denetim (`playwright.live-audit.config.js`). |
| `e2e/tools` | Test sunucusu bakım araçları (bkz. bölüm 7). |
| `orkestra/`, `tasks/`, `docs/gorevler/` | Görev kayıtları ve ajan düzeni (bkz. bölüm 3). |
| `scripts/` | Paket (`build-deb.sh`), lint (`validate-repository.mjs`), kurtarma araçları. |
| `docs/yunpanel-docs-0.3.0/` | Yayımlanacak TR/EN ürün dokümanı paketi. Bu klasör elle düzenlenmez. |

Arka uç `apps/api/src` alan klasörleri (T957). Kökte yalnız systemd girişleri kalır: `index.js` (`yunpanel-api.service`) ve `notification-sentinel.js` (`yunpanel-sentinel.service`). Alanın `*-http.js` rota dosyası alanın klasöründedir.

| Klasör | İçerik |
|---|---|
| `http/` | `app.js`, `core-app.js`, `management-app.js` (rota bağlama), `panel-http-guard.js`, `tenant-boundary.js`, `site-resource-boundary.js`, `automation-http.js` |
| `auth/` | Oturum, kullanıcı, MFA, API anahtarı, audit, secret maskeleme |
| `hosting/` | Hosting hesabı, müşteri/reseller kapsamı ve kotaları, tenant site, yetenek kataloğu |
| `websites/` | Website kaydı ve rotaları, silme, askıya alma, izolasyon, cron, cache, SFTP, statik kopya, sağlık |
| `provisioning/` | Site oluşturma (`site-create*`) ve `website-provisioning-*` orkestratörü ile adım işleyicileri |
| `domains/` | Domain kaydı, hiyerarşi, nginx/proxy ayarı, silme ve askıya alma, harici yaşam döngüsü |
| `dns/` | DNS zone, DNSSEC, şablon, PowerDNS |
| `mail/` | Posta alanı, kutu, alias, DKIM, SRS, smarthost, Roundcube |
| `databases/` | Veritabanı, bağlama, kimlik bilgisi, yedek/geri yükleme, phpMyAdmin |
| `applications/` | Uygulama kaydı, Node/Passenger/Python çalışma zamanı ve sürümleri, Git webhook |
| `php/` | PHP araçları ve PHP site kopyası |
| `wordpress/` | WordPress araç seti, klon, seçici aktarım |
| `docker/` | Compose, volume, workload, katalog |
| `files/` | Site dosya yöneticisi ve çalışanı, elFinder, korumalı yollar |
| `terminal/` | Terminal ve ttyd oturumları |
| `certificates/` | Sertifika kaydı, yenileme, reload |
| `backup/` | Yedek planı/çalıştırma, website yedek ve geri yükleme, restic/rclone |
| `migration/` | Plesk içe aktarma, yerel taşıma/kurtarma yedeği, website taşıma |
| `jobs/` | Durable job kaydı, idempotency, `job-running-*` kurtarma |
| `runtime/` | Yerel host yürütücüsü ve işlem listesi, sunucu kaydı, firewall, servisler, watchdog, log |
| `panel/` | Lisans (ve `vendor-entitlement-public.pem`), panel ayarları, bildirimler, ürün bağlantıları |
| `ai/` | AI sohbet, sağlayıcı, araç kataloğu |

## 2. Şu anki durum (26-11-2026)

- **Öncelik:** Yeni özellikten önce kod ve doküman temizliği (İNSAN kararı, [DECISIONS 2026-11-26](orkestra/DECISIONS.md)). Görevler [T951–T966](gorevler/temizlik-20261126.md). T951–T957, T960, T961, T963, T964 bağımsız incelemeden geçti. T956 (görsel: 174 ekranın 159'u piksel aynı, 15'i yalnız canlı veri farkı) ve T958 İNSAN onayında; T959 ve T965 bunlara bağlı. Açık ürün işi: T966. İşi senior'ın başlattığı Claude alt ajanları ayrı worktree'lerde yapar; senior birleştirir ve doğrular.
- **Dal:** Aktif dal günün tarihidir (`26-11-2026`). Her gün bir önceki aktif daldan açılır. `main`'e yazılmaz, merge edilmez.
- **`.28` test sunucusu:** Son kurulan paket `0.3.0-2026112803` (kaynak `a8ebfbe0`, 28 Kasım, T966–T972), geri dönüş `0.3.0-2026112802`. `api.env` içindeki `YUNPANEL_SOURCE_COMMIT` paket kurulumunda güncellenmez; her kurulumdan sonra `build-info.json` commit'ine eşitlenmeli (tanılama `sourceMatchesDeployed`). 28 Kasım'da eski test kalıntıları yedeklenip temizlendi ([kayıt](gorevler/kalinti-temizlik-20261128.md)); yedekler sunucuda `/var/backups/yunpanel-leftovers-20261128/`. Ücretsiz lisans: Premium gerektiren e2e adımları kapıyı doğrulayıp atlanır. 26 Kasım canlı koşuları ve eskimiş spec düzeltmeleri: [T958/T965 kaydı](gorevler/t958-canli-20261126.md). Kurulumda kaynak git bundle ile gönderilir (web derlemesi ve `build-deb.sh` git ister).
- **Contabo test sunucuları:** Debian 12 (`.14`) ve Ubuntu 24.04 (`.212`) üzerinde `0.3.0-2026112104` kurulu. Çapraz işletim sistemi testleri için izinli. Kaynak kapalıyken dış yedekten kurtarma, iki yönlü geri yükleme, posta ve ikincil DNS kabulü 22 Kasım'da geçti.
- **Linux hosting pilotu:** [Plan](../plan.md#20-kasım-2026--onaylanan-linux-hosting-pilotu-ve-plesk-geçişi). Kurtarma, posta, ikincil DNS, WAF ve trafik kotası kabulleri kapandı. Açık olanlar: yetkili gerçek Plesk dışa aktarımı ve son IMAP eşitlemesi, WordPress staging aktarımının yayın kabulü ([todo](../todo.md#linux-hosting-pilotu-ve-plesk-geçişi)).
- **Testler:** Son toplu doğrulama (`orchestrator.py verify`) 28 Kasım'da `6001dc17`'de geçti ([LOG](orkestra/LOG.md)). 24 Kasım Debian 12 geçici çalışma alanında `npm test` 9.088 testten 9.086'sı geçti, 2'si belgeli atlama.
- **Görevler:** `python3 orkestra/tasks.py status`. 28 Kasım'da T883, T966, T967, T968–T972 kabul edildi ve `.28`'de canlı doğrulandı. Açık: T973 (Debian `roundcube-cleandb` zamanlayıcısı YunPanel Roundcube kurulumunda her gün düşüyor; webmail etkilenmiyor).
- **Ürün dokümanı:** TR/EN 0.3.0 paketi güncel arayüzle yunsoft.com'da yayında (26 Kasım, T959, [kayıt](gorevler/yunpanel-docs-premium-transfer-20261124.md#26-kasım-2026--yunsoftcom-yayını-t959)). Ekran görüntüleri `scripts/capture-docs-screenshots.mjs` ile yerel adayda alınır.

## 3. Son çalışmalar (10–26 Kasım)

Her iş tek satır olarak [yapılanlar](yapilanlar.md) içinde. Öne çıkanlar:

- **Site kopyalama:** Statik kopya (T922–T926) ve PHP + MariaDB kopyası (T927–T935). `.28` Chromium ve Firefox kabulü 20 Kasım. [Görevler](gorevler/site-copy.md).
- **WordPress:** Klon (T921), staging'den seçici dosya aktarımı ve 503'te otomatik geri alma, Türkçe kurulum ve kaldırma `.28`'de geçti (19–23 Kasım).
- **Posta ve DNS:** Otomatik yanıt ve spam kuralları panelde (T938, T942–T945). PowerDNS ikincil sunucu (T946). [Kayıt](gorevler/contabo-mail-dns-20261122.md).
- **Yedek ve kurtarma:** İsimli rclone hedefi (T947), özel Restic önbelleği (T940), boş sunucu kurtarma ön kontrolü (T937). [Soğuk kurtarma](gorevler/contabo-cold-recovery-20261122.md), [çapraz geri yükleme](gorevler/contabo-cross-restore-20261122.md).
- **Plesk taşıma hazırlığı:** Çevrimdışı dışa aktarım önizlemesi ve yerel staging (T936, T939, T941).
- **Docker ve Python:** Alt yol proxy'si, tekil volume silme, root olmayan konsol; Python deploy/restart/rollback (20 Kasım, `.28`). [T883 kaydı](t883-coverage-and-priorities-2026-11-12.md).
- **Güvenlik ve kota:** CrowdSec AppSec ([kayıt](gorevler/crowdsec-waf-20261121.md)), aylık trafik ölçümü ve müşteri kotaları ([kayıt](gorevler/trafik-kota-20261122.md)), alıcı gözü inceleme düzeltmeleri ([kayıt](gorevler/buyer-review-20261121.md)).
- **Lisans:** Ed25519 imzalı hak doğrulaması (15 Kasım), 3 aylık Premium kampanyası ve kalıcı hak koruması (24–25 Kasım). [Yapılandırma](license-configuration.md).
- **Arayüz:** 108 ekranın öncesi/sonrası denetimi, ortak modal ve kirli form koruması, dosya editörü kapanışı (24 Kasım, [kayıt](gorevler/ui-ux-files-modal-20261124.md)); üst bar ve menü yenilemesi (25 Kasım).

## 4. Çalışma düzeni (orkestra)

- **Senior** (Claude Code veya Codex): planlar, görev yazar, inceler, zor işleri ve sunucu kurulumlarını yapar.
- **Junior** (Antigravity): `/orkestra-devam` ile görev alır, yapar ve birbirinin işini inceler. Juniorlar push etmez, paket kurmaz, panel servislerini yeniden başlatmaz. T951–T959'u juniorlar almaz.
- **Görevler:** `docs/gorevler/*.md`. Durum dosyalarla tutulur: `tasks/claims`, `review`, `done`, `blocked`, `reopen`.
  - `python3 orkestra/tasks.py status` · `ready` · `show T123` · `lint`
  - Senior işi: `tasks.py claim T123 SENIOR` → `tasks.py done T123 SENIOR` → raporu `tasks/review/T123.md`'ye yaz.
  - Görevin `Dosyalar` satırı gerçekten değişen dosyaları yazmalı; `tasks.py lint` aynı dosyaya yazan görevlerin sırasını `Bağımlı` ile ister.
- **Doğrulama:** Değişen davranışın testi yeterlidir. Toplu doğrulama (`python3 orkestra/orchestrator.py verify`) yayın adayında, risk varsa veya İNSAN isterse bir kez koşulur ([PROJE §Doğrulama](orkestra/PROJE.md#doğrulama)). Tam canlı e2e rutin değildir; yalnız etkilenen `e2e/ozellik` dosyaları koşulur.
- **Push:** yalnız `python3 orkestra/orchestrator.py push`, yalnız İNSAN istediğinde. Commit mesajları `[skip ci]` ile biter.

## 5. Test sunucusu (`.28`)

- Panel adresi, SSH takma adı (`yunpanel-test`, root) ve giriş bilgisi yalnız `.local/test-server.env` ve `.local/yunpanel-owner-password-only.json`'da; Git'e, rapora veya loga yazılmaz.
- **`.44` (gerçek Plesk sunucusu): yasak.** Juniorlar hiç girmez. Senior yalnız İNSAN'ın açtığı oturumda, salt okunur bakar.
- **Kilitler:** Kurallar [PROJE.md](orkestra/PROJE.md) "İzinli test hedefleri" bölümündedir. Canlı işten önce boş bir `sunucu-28-1/2/3` kilidi alınır (`bash orkestra/lock.sh acquire sunucu-28-1 AGENT_n`). Sunucu geneli işler ayrıca `sunucu-28-genel` ister. API yeniden başlatmak veya paket kurmak çalışan testleri keser; o sırada başka canlı iş olmamalı. Kilitler yalnız `lock.sh` ile alınıp bırakılır.
- Yerleşim: API `/usr/lib/yunpanel` (127.0.0.1:3001), web arayüzü `/usr/share/yunpanel/web` (**`apps/web/dist` değil**), kayıtlar `/var/lib/yunpanel/control-plane/*.json`, gizli ayarlar `/etc/yunpanel`.
- Nöbetçi (`yunpanel-sentinel.timer`) API 2 kontrol üst üste yanıt vermezse sahibine gerçek e-posta atar.
- `.28`'de rutin yedek veya snapshot alınmaz (agents.md 11 Ekim kuralı).

## 6. Sunucuya kurulum

- **Paket (tercih edilen):**
  1. Paket temiz bir Git checkout'tan hazırlanır. `.git` içermeyen eski `git archive` akışı doğrulanmış kaynak sayılmaz (T901).
  2. Sunucudaki derleme betiği sırasıyla sha kontrolü, `npm ci`, lint, derleme, `fetch-elfinder-vendor.sh`, `build-deb.sh <sürüm>` çalıştırır.
  3. Sonra `apt-get install ./packages/yunpanel_<sürüm>_amd64.deb`.
  4. Sürüm biçimi `0.3.0-YYYYMMDDnn`. Önceki paketler geri dönüş için saklanır.
- **Tek dosya (acil düzeltme):** Değişen dosyayı `/usr/lib/yunpanel/...` altına kopyala ve `systemctl restart yunpanel-api`. Arayüz değiştiyse `apps/web` derlenip `/usr/share/yunpanel/web`'e konur; macOS'ta arşiv `COPYFILE_DISABLE=1 tar --no-xattrs` ile yapılır.
- Her kurulumdan sonra: servisler, `curl 127.0.0.1:3001/api/health`, API journal'ında hata yok, sunucudaki dosyaların hash'i dalla aynı, gerçek siteler 200, ilgili canlı testler.
- Kurulum İNSAN onayıyla yapılır. Ayrıntı [operasyon belgesinde](operations.md).

## 7. Bilinen tuzaklar (yaşandı, tekrarlanmasın)

- **Panelin arkasından sunucuya dokunma.** Testlerin kullanıcı, nginx, PHP veya cron dosyasını elle silmesi, panelin kaydıyla sunucuyu uyumsuz bırakıp siteleri silinemez yaptı. `npm run lint` bunu `e2e/ozellik`'te reddediyor. Kayıt dosyalarına elle yazmak da yasak.
- **Elle Unix kullanıcısı silinecekse** önce o kullanıcının PHP-FPM havuzları kaldırılır, sonra `php-fpm8.3 -t` çalıştırılır. 7 Kasım'da unutuldu; bütün site silmeleri durdu.
- **Site kurulumu sunucuda tamamlanır.** Kurulum sürerken alan adı ve barındırma ayarı değişikliği 409 ile reddedilir (T868). Test site kurup hemen ayar değiştirecekse önce `waitForWebsiteSetup(page, domainId)` (`e2e/helpers.js`) çağırır.
- **Node `fetch()` `Host` başlığını değiştiremez.** Vhost'u IP üzerinden test ederken `node:http` kullan.
- **`live-audit` yalnız kendi ayarıyla ve her seferinde yeni bir run klasörüyle koşar.**
- **Junior raporlarını doğrula.** "Kalıntı yok" iddiası birkaç kez yanlış çıktı. Junior çalışırken senior ayrı bir worktree'de çalışmalı.
- **Hata dosyalarında parola.** Playwright hata dosyaları owner parolasını gizler (`e2e/redacting-reporter.js`). İz (trace) arşivi kapalıdır; `PW_TRACE=1` ile açılır, paylaşılmaz.

## 8. Test sunucusu temizliği

- Test sitelerinin adı `t<alan><nn>[ek]-…` ya da `ypaudit-…` biçimindedir.
- Listele: `node e2e/tools/remove-test-sites.mjs` · sil: `--apply` (isteğe bağlı ad öneki). Araç panelin kendi silme akışını kullanır.
- Silmeden önce bir `sunucu-28-*` kilidi al; başka görevin sitelerini silme.
- Silme denemelerinde gerçekten çözümlenen bir ad kullan (test sunucusunun IP'siyle `….<ip>.sslip.io`). `.example.internal` gibi adlarda üst alan DNSSEC durumu doğrulanamaz ve silme durur.

## 9. Açık işler

- **Temizlik:** [T951–T959](gorevler/temizlik-20261126.md).
- **T883:** Eski kabul ortamına bağlı live-audit testleri. Kayıt `tasks/reopen/T883.md` ve [T883 kapsam belgesi](t883-coverage-and-priorities-2026-11-12.md). Eski silinen 59 testin "karşılığı var" iddiası doğrulanamadı; bu davranışların başka testlerce sınandığını varsayma.
- **Ürün kabul kapıları:** [todo.md](../todo.md) T-* maddeleri ve [plan.md](../plan.md) YP2 maddeleri.
- **Plesk'te eksik olanlar:** wildcard domain, nginx önbellekleme, ek FTP kullanıcıları, PHP eklenti yönetimi ve diğerleri [Plesk karşılaştırmasında](plesk-feature-parity.md#pleskte-olup-yunpanelde-eksik-olanlar).
- **Uyarı e-postaları spama düşüyordu** (7 Kasım notu): gönderen alan adında DKIM yoktu, ters DNS uyuşmuyordu. İNSAN "şimdilik kalsın" dedi.
- Eski planlar ve raporlar [docs/history/](history/) altında. Güncel durum için kullanılmaz.

## 10. Kişiler ve iletişim

- İNSAN (proje sahibi) ile Türkçe konuşulur. Kod, tanımlayıcılar ve kod yorumları İngilizcedir.
- GitHub görev panosu kullanılmaz; iş takibi orkestra kayıtlarındadır.
