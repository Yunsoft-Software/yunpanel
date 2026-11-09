# YunPanel — Devir notu (projeyi devralan buradan başlasın)

Güncelleme: 2026-11-07 · senior: Claude Code. Bu belge özet ve yol göstericidir. Bağlayıcı kurallar `agents.md` ile `docs/orkestra/KURALLAR.md` + `PROJE.md`'dedir; çelişkide onlar geçerlidir.

## 1. Proje nedir
Yunsoft'un kendi hosting paneli: Plesk Obsidian'ın ekran düzeni, iş akışları ve özelliklerinin Node/React ile işlevsel karşılığı. Günlük merkez Web Siteleri ve Alan Adları. Dosya, veritabanı, SSL, posta, DNS, çalışma ortamı (PHP / Node Passenger / Python / statik / Docker), yedek ve erişim aynı site bağlamında yönetilir.

| Klasör | İçerik |
|---|---|
| `apps/api` | Node arka uç (root yetkisi yalnız burada). Giriş `src/index.js`, testler `test/`. |
| `apps/web` | React/JSX arayüz (Vite). Ortak bileşenler `src/workspace/PanelKit.jsx`. |
| `packages/host-runtime` | Sunucu adaptörleri (nginx, PHP-FPM, posta, DNS, kullanıcı…). |
| `packages/config-templates`, `protocol`, `shared` | Şablonlar ve ortak kod. |
| `e2e/ozellik` | Gerçek test sunucusunda koşan özellik testleri (Playwright). |
| `e2e/live-audit` | Ayrı ayarla koşan canlı denetim (`playwright.live-audit.config.js`). |
| `e2e/tools` | Test sunucusu bakım araçları (bkz. bölüm 7). |
| `orkestra/`, `tasks/`, `docs/gorevler/` | Görev panosu ve ajan düzeni (bkz. bölüm 3). |
| `scripts/` | Paket (`build-deb.sh`), lint (`validate-repository.mjs`), kurtarma araçları. |

## 2. Şu anki durum (07-11-2026)
- **Dal:** `09-11-2026` (GitHub'daki en güncel dal `07-11-2026`; bugünkü dal yerelde). Her gün o günün tarihiyle (GG-AA-YYYY) yeni dal açılır, bir önceki günün dalından. `main`'e yazılmaz; `main` çok geride ve bilerek öyle.
- **Test sunucusu (`.28`):** Paket `0.3.0-2026110701` kurulu; son iki haftanın bütün düzeltmeleri bu pakette. Servisler sağlıklı; phpMyAdmin girişi ve site kurulumu paketle doğrulandı.
- **Son iki haftada yapılanlar:** `docs/yapilanlar.md` (her iş tek satır, en yeni üstte).
- **Testler:** `npm test` ve `npm run lint` geçiyor.

## 3. Çalışma düzeni (orkestra)
- **Senior** (Claude Code): planlar, görev yazar, inceler, zor işleri ve sunucu kurulumlarını yapar.
- **Junior** (Antigravity/Gemini, 4 yuva): `/orkestra-devam` ile görev alır, yapar ve birbirinin işini inceler. Juniorlar push etmez, paket kurmaz, panel servislerini yeniden başlatmaz.
- **Görevler:** `docs/gorevler/*.md` (en yenileri `VQ-bulgular.md` sonunda). Durum dosyalarla tutulur: `tasks/claims`, `review`, `done`, `blocked`.
  - `python3 orkestra/tasks.py status` · `ready` · `show T123` · `lint`
  - Senior işi: `tasks.py claim T123 SENIOR` → `tasks.py done T123 SENIOR` → raporu `tasks/review/T123.md`'ye yaz. İnceleme junior'da.
  - Görevin `Dosyalar` satırı gerçekten değişen dosyaları yazmalı; `tasks.py lint` aynı dosyaya yazan görevlerin sırasını `Bağımlı` ile ister.
- **Doğrulama:** `python3 orkestra/orchestrator.py verify --quick` (lint + birim testleri). Tam `verify` buna derlemeyi ekler. Tam canlı e2e (yaklaşık 465 test, 1,5–2 saat) **rutin değildir**; yalnız değişikliğin etkilediği `e2e/ozellik` dosyaları koşulur (İNSAN kararı, 06-11).
- **Push:** yalnız `python3 orkestra/orchestrator.py push`, yalnız İNSAN istediğinde. Commit mesajları `[skip ci]` ile biter.
- **Yarım kalan iş:** Antigravity T880'in ortasında kapandı. T880 yeniden açık. Yarım değişiklikler incelenmemiş haliyle iki yerde saklı: GitHub'daki `wip-T880-07-11` dalında (`e2e/live-audit/04,06,07,runtime.js`) ve bu makinede `tasks/recovery/T880-yarim-07-11.patch`. T880'i alan ya buradan devam eder ya da baştan yapar; dal olduğu gibi birleştirilmez.

## 4. Test sunucusu (`.28`)
- Panel: `https://server.cryptoraichu.website`. SSH takma adı `yunpanel-test` (root). Adres ve giriş bilgisi yalnız `.local/test-server.env` ve `.local/yunpanel-owner-password-only.json`'da; Git'e, rapora veya loga yazılmaz.
- **`.44` (gerçek Plesk sunucusu): yasak.** Juniorlar hiç girmez. Senior yalnız İNSAN'ın açtığı oturumda, salt okunur.
- **Kilitler:** Canlı işten önce boş bir `sunucu-28-1/2/3` kilidi alınır (`bash orkestra/lock.sh acquire sunucu-28-1 AGENT_n`). API yeniden başlatmak, paket kurmak veya sunucu genelinde iş yapmak için `sunucu-28-genel` ile birlikte **dört kilidin hepsi** alınır, yoksa çalışan testler kesilir. Kilitler yalnız `lock.sh` ile alınıp bırakılır.
- Yerleşim: API `/usr/lib/yunpanel` (127.0.0.1:3001), web arayüzü `/usr/share/yunpanel/web` (**`apps/web/dist` değil**), kayıtlar `/var/lib/yunpanel/control-plane/*.json`, gizli ayarlar `/etc/yunpanel`.
- Nöbetçi (`yunpanel-sentinel.timer`) API 2 kontrol üst üste yanıt vermezse sahibine gerçek e-posta atar.

## 5. Sunucuya kurulum
- **Paket (tercih edilen):**
  1. Yerelde `COPYFILE_DISABLE=1 git archive --format=tar.gz -o source.tar.gz HEAD`.
  2. Arşivi sunucuda `/root/yunpanel-deploy-YYYYMMDD/` altına koy ve oradaki `build.sh`'yi çalıştır. Örnek: `/root/yunpanel-deploy-20261107/build.sh`; sırasıyla sha kontrolü, `npm ci`, lint, derleme, `fetch-elfinder-vendor.sh`, `build-deb.sh <sürüm>`.
  3. Sonra `apt-get install ./packages/yunpanel_<sürüm>_amd64.deb`.
  4. Sürüm biçimi `0.3.0-YYYYMMDDnn`. Önceki paketler geri dönüş için aynı klasörlerde durur.
- **Tek dosya (acil düzeltme):** Değişen dosyayı `/usr/lib/yunpanel/...` altına kopyala (önce `/root/<ad>.before-<zaman>` yedeği al) ve `systemctl restart yunpanel-api`. Arayüz değiştiyse `apps/web` derlenip `/usr/share/yunpanel/web`'e konur; macOS'ta arşiv `COPYFILE_DISABLE=1 tar --no-xattrs` ile yapılır.
- Her kurulumdan sonra: servisler, `curl 127.0.0.1:3001/api/health`, API journal'ında hata yok, sunucudaki dosyaların hash'i dalla aynı, gerçek siteler 200, ilgili canlı testler.
- Kurulum İNSAN onayıyla yapılır.

## 6. Bilinen tuzaklar (yaşandı, tekrarlanmasın)
- **Panelin arkasından sunucuya dokunma.** Testlerin kullanıcı, nginx, PHP veya cron dosyasını elle silmesi, panelin kaydıyla sunucuyu uyumsuz bırakıp siteleri silinemez yaptı. `npm run lint` artık bunu `e2e/ozellik`'te reddediyor. Kayıt dosyalarına elle yazmak da aynı sebeple yasak; bir bozuk kayıt panelin açılmasını engelleyebilir.
- **Elle Unix kullanıcısı silinecekse** önce o kullanıcının PHP-FPM havuzları (`/etc/php/8.3/fpm/pool.d/*<kullanıcı>*.conf`, elFinder dahil) kaldırılır, sonra `php-fpm8.3 -t` çalıştırılır. 07-11'de unutuldu; PHP-FPM yeniden yükleme yapamaz hale geldi ve bütün site silmeleri durdu.
- **Site kurulumu sunucuda tamamlanır.** Sonuç ekranından sonra arka plan işçisi bitirir (T864). Kurulum sürerken alan adı ve barındırma ayarı değişikliği 409 ile reddedilir (T868). Test site kurup hemen ayar değiştirecekse önce `waitForWebsiteSetup(page, domainId)` (`e2e/helpers.js`) çağırır.
- **Node `fetch()` `Host` başlığını değiştiremez.** Vhost'u IP üzerinden test ederken `node:http` kullan; yoksa varsayılan sunucuya gidip 502 görürsün (WEB-08'deki `vhostGet` gibi).
- **`live-audit` yalnız kendi ayarıyla ve her seferinde yeni bir run klasörüyle koşar.** Varsayılan Playwright koşusu bu klasörü atlar. `.local/browser-audit/current` eski bir koşuya aittir.
- **Junior raporlarını doğrula.** "Kalıntı yok" iddiası birkaç kez yanlış çıktı, bir kez senior kilidi elle kaldırıldı. Junior aynı klasörde commit atarken senior'un commit'lenmemiş dosyalarını kendi commit'ine aldı; Antigravity çalışırken senior ayrı bir worktree'de çalışmalı.
- **Hata dosyalarında parola.** Playwright'ın hata dosyaları owner parolasını gizler (`e2e/redacting-reporter.js`). İz (trace) arşivi temizlenemediği için kapalıdır; `PW_TRACE=1` ile açılır, paylaşılmaz.

## 7. Test sunucusu temizliği
- Test sitelerinin adı `t<alan><nn>[ek]-…` (örn. `tweb05-a3-…`, `tweb05nossl-a4-…`) ya da `ypaudit-…` biçimindedir.
- Listele: `node e2e/tools/remove-test-sites.mjs` · sil: `--apply` (isteğe bağlı ad öneki: `--apply tweb05`). Araç panelin kendi silme akışını kullanır. Alan adı yönlendirmesi sapmış siteleri önce panelin `stage` + `activate` adımlarıyla onarır.
- Silmeden önce bir `sunucu-28-*` kilidi al; junior'un çalışan bir görevine ait siteleri silme (o görev kendi temizler).
- **Şu an `.28`'de 22 test sitesi var:**
  - 14 eski `tweb06e-`/`tweb05nossl-` sitesi. Önceki temizliklerin ad kalıbı bunları kaçırdı; silinebilir.
  - 8 `ypaudit-` sitesi, yarım kalan T880'e ait.
- Bilerek bırakılan: `yunapp-f8c9dd81395d` Unix kullanıcısı (uygulama kaydı duruyor). 07-11 sahipsiz kayıt temizliğinin yedeği: `/root/backup-orphans-202611071117`.

## 8. Açık işler ve kararlar
- **T880** (junior, açık): değişiklik yapan `live-audit` testleri. Yarım hali `wip-T880-07-11` dalında (bölüm 3).
- **Website Copying:** sıradaki özellik. Tasarım görüşmesi başladı, karar yok. Plesk'teki gibi bir siteyi aynı sunucudaki başka bir siteye kopyalama; dosyalar ve isteğe bağlı veritabanları.
- **Uyarı e-postaları spama düşüyor:** gönderen alan adında DKIM yok, sunucunun ters DNS'i uyuşmuyor. İNSAN "şimdilik kalsın" dedi.
- **Plesk eksikleri:** `docs/plesk-eksikler.md` (başındaki 07-11 notu neyin yapıldığını söyler) ve `docs/plesk-feature-parity.md`.
- **Eski notlar:** `plan.md`, `todo.md`, `ui-plan.md` ve `docs/checkpoint-2026-10-12.md` 9–12 Ekim durumunu anlatır. İçerikleri (özellik ve kabul listeleri) hâlâ başvuru, ama "güncel durum" satırları eskidir.

## 9. Kişiler ve iletişim
- İNSAN (proje sahibi) kullanıcıyla Türkçe konuşulur. Kod, tanımlayıcılar ve kod yorumları İngilizcedir.
- Ekip görev panosu: https://github.com/orgs/Yunsoft-Software/projects/1, komutu `~/.yunsoft/gorev` (kurulumu `Yunsoft-Software/ai-kit` reposunda). Biten elle tutulur iş tek kart olarak yazılır; toplu kart açılmaz.
