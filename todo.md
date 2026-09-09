# YunPanel — Codex / Gerçek Ortam TODO

Bu dosyada yalnız bu oturumda güvenilir biçimde çalıştırılamayan gerçek ortam doğrulamaları tutulur. Ürün/kod işleri `plan.md`, bağlayıcı kurallar `agents.md` içindedir. Doğrudan `main` üzerinde küçük commitler kullan; GitHub Actions kullanma. Secret, parola, cookie, MFA secretı veya kişisel veriyi repo/log/screenshot içine yazma.

Bu oturumdaki odaklı Read Only policy/HTTP/client testleri Node 22.16.0 kaynak alt kümesinde 11/11 geçti. Bu sonuç Node 24 tam workspace, native auth, React production build, gerçek browser veya canlı HTTPS kabulü değildir. Master-key rotation testleri repoya eklendi fakat gerekli Node 24/full dependency ortamında henüz çalıştırılmadı.

## T-RUNTIME — P0: Desteklenen runtime ve tam repo kabulü

- [ ] Node 24.11.1+ ve npm 11+ ile temiz dependency install yap; workspace manifestlerini ve native dependencies'i doğrula.
- [ ] Filtre olmadan `npm run check`, bütün workspace testleri ve production build çalıştır. Test/build hatasını runtime gereksinimini düşürerek veya test atlayarak çözme.
- [ ] API/web/package entry pointlerinin aynı committen geldiğini doğrula. Mixed web/API build durumunda privileged UI fail-closed kalmalı.
- [ ] `.github/workflows` ekleme/değiştirme; doğrulamaları yerel/test hostunda çalıştır.

## T-ACCESS — P0: Read Only gerçek kabulü

- [ ] Yeni `panel-access`, owner-MFA capability, Read Only HTTP ve owner-access testlerini tam Node 24 workspace içinde mevcut auth/core testleriyle birlikte çalıştır.
- [ ] Gerçek browserda Read Only hesabıyla Dashboard, Web Siteleri, site detail ve Sunucular ekranlarının açıldığını doğrula. Jobs, Users, Settings, Applications management, Domains management, create ekranları ve diğer mutation yüzeyleri görünmemeli/mount edilmemeli.
- [ ] Network panelinde Read Only oturumunun yalnız izin verilen `GET/HEAD /api/{servers,applications,domains,certificates}` list/detail isteklerini yaptığını doğrula. `/jobs`, `/users`, application env/status, nested system inspection veya herhangi bir mutation otomatik/polling olarak üretilmemeli.
- [ ] Raw API'de Read Only ile jobs/users/env/status/system inspection ve bütün mutation isteklerinin core management handlerına ulaşmadan `403` kaldığını doğrula. URL yazarak veya client payload değiştirerek izin genişletilememeli.
- [ ] Owner + MFA management görünümünün eski işlevlerini regresyondan geçir. Read Only capability metadata'sına `*` veya bozuk mode enjekte edildiğinde UI ve API fail-closed kalmalı.
- [ ] Role change / disable / delete / logout sonrası açık Read Only ekranlarında eski kaynak cache'i kalmamalı; yeni session gelmeden stale privileged veri render edilmemeli.

## T-KEY — P0: Secret master-key rotation kabulü

- [ ] Node 24 full workspace'te `apps/api/test/secret-master-key-rotation.test.js` çalıştır. Active MFA, pending MFA, application secret, public env value, wrong-current-key preflight, same-key reject, backup tamper, target-path binding, absent pre-rotation env-store ve rollback senaryolarının tümü geçmeli.
- [ ] Test hostunda packaged service ile `docs/secret-master-key-rotation.md` runbook'unu birebir prova et: bağımsız console/SSH erişimi -> yedek -> `yunpanel-api.service` stop -> rotation -> `api.env` root key update -> service start -> health/functional validation.
- [ ] Rotation sonrası Owner password + TOTP login, recovery akışı ve secret application environment materialization çalışmalı. API/frontend secret value'yu maskeli tutmalı; loglarda `mfa_key_unavailable` / `secret_decryption_failed` benzeri hata olmamalı.
- [ ] Rotation backup directory'nin 0700, snapshot/key dosyalarının 0600 ve public web root dışında olduğunu doğrula. Manifest raw key/plaintext secret içermemeli; generated key hiçbir argv/log/audit çıktısına düşmemeli.
- [ ] Rollback tatbikatı yap: API stop -> aynı live store pathleriyle rollback -> önceki `YUNPANEL_SECRET_MASTER_KEY` geri yükle -> API start -> MFA + application secret validation. Old-data/new-key veya new-data/old-key ile servis açma.
- [ ] Process kill/power-loss benzeri kesinti noktasını kontrollü test hostunda simüle et; backup/manifest ile deterministik recovery yapabildiğini doğrula. Bu prova tamamlanmadan production root key rotate etme.
- [ ] Debian/package çıktısında `scripts/rotate-secret-master-key.mjs`, root `npm run secret-key`, `.env.example` ayarları ve runbook'un bulunduğunu doğrula.

## T-USER — P0: Kullanıcı yönetimi native ve browser kabulü

- [ ] Native Argon2/SQLite ile user-admin store/HTTP/client testlerini mevcut auth/MFA/gateway/core testleriyle birlikte çalıştır.
- [ ] Gerçek `index.js -> authenticated API -> core/domain` zincirinde `/api/panel/users` CRUD'u doğrula. Anonymous, Read Only ve MFA enrollment'ı eksik Owner reddedilmeli; CSRF/Origin/body-limit korunmalı.
- [ ] Ayrı SQLite bağlantıları/process'leriyle son-Owner disable/demotion/delete, username/revision yarışları ve login sırasında account/session değişimini test et. Transaction/audit failure yarım lifecycle bırakmamalı.
- [ ] Auth DB upgrade/migration, repeated startup, unknown schema rejection, consistent backup/restore ve old-package rollback davranışını test et.
- [ ] Browserda `/settings/users`: create/edit/role/active/password reset/delete, typed confirm, son Owner hatası, pagination, dirty-form, double-submit, delayed/malformed/network response ve back/forward/reload davranışlarını dört hedef viewportta test et.
- [ ] User disable/delete/role/password/MFA değişikliğinin ilgili sessions, pending enrollment ve login challenges üzerinde beklenen revoke etkisini gerçek MFA ile doğrula. Hash/token/MFA secret list/audit/URL/localStorage/telemetry'ye düşmemeli.

## T-AUTH — P0: MFA, session ve gerçek HTTPS zinciri

- [ ] React production buildde first Owner setup, login/wrong password, MFA enrollment/verify/recovery, Account dialog, password change, session list/logout/logout-all, idle timeout ve absolute timeout akışlarını gerçek browserda test et.
- [ ] İki browser tabında delayed request, stale 200/401, login cookie rotation, page restore (`pageshow`), lost MFA response ve keep-alive yarışlarını test et; eski response yeni login/session'ı bozmamalı.
- [ ] Exact `YUNPANEL_PUBLIC_ORIGIN=https://cryptoraichu.website` (trailing slash yok), TLS reverse proxy, loopback API listener ve Origin/Sec-Fetch/CSRF enforcement'ı doğrula.
- [ ] Auth DB/path ownership: service-owned private directory 0700, DB/WAL/SHM 0600; CLI ve service aynı absolute DB'yi kullanmalı. Genel chmod/chown yapma.
- [ ] Current IP/proxy protection'ı auth kabulü tamamlanmadan kaldırma. Trusted-proxy/client-IP/rate-limit spoof davranışı ayrı kabul edilmeden public yüzeyi genişletme.

## T-UI — P1: Routed workspace gerçek browser kabulü

- [ ] Built React uygulamasını gerçek browserda aç; `AuthGate -> App -> WorkspaceApp` zincirinde login öncesi management collection requesti olmadığını doğrula.
- [ ] `/dashboard`, `/websites`, `/websites/new`, `/websites/:id/:tab`, `/applications`, `/applications/new`, `/domains`, `/servers`, `/jobs`, `/settings`, `/settings/users` için direct URL, reload, back/forward, invalid route ve reverse-proxy SPA fallback testlerini yap.
- [ ] Domain/alias search, URL filters/sort, group pagination, parent/child context, collapse/density/per-page preferences, multi-tab storage event ve bozuk/engelli localStorage davranışını test et.
- [ ] New site, application, env, domain/SSL ve job flows için delayed/401/403/404/409/network/malformed response üret. Dirty form ve uncertain mutation sonucunda kullanıcı verisi sessizce kaybolmamalı/kör retry olmamalı.
- [ ] Job drawer/dialog: queued/running/terminal, delayed list/detail, close/reopen, wrong ID, stale response, network cut ve permission loss. Dialog kapanınca server job devam edebilmeli; raw secret payload/result render edilmemeli.
- [ ] 1440×900, 1920×1080, 1280×800 ve 390×844 viewportlarda Dashboard/Websites/site detail/forms/jobs/users/MFA ekranlarını kontrol et. Sidebar, mobile focus trap/Escape/inert/backdrop, Cmd/Ctrl+K, skip link, modal focus restore, contrast, long hostnames/tables ve overflow'u düzelt.
- [ ] Package build'in bütün workspace/router/assets dosyalarını içerdiğini ve update/rollback sonrası deep-link/login'in çalıştığını doğrula.

## T-LIVE — P0/P1: Canlı panel, package ve rollback kapısı

- [ ] `cryptoraichu.website` üzerinde deploy edilen commit/package sürümünü salt okunur doğrula; menüler, console/network errors, Nginx/web/API/agent unitleri ve mevcut erişim korumasını repo varsayımıyla değil gerçek hosttan kaydet.
- [ ] Production değişikliğinden önce `/etc/yunpanel`, `/var/lib/yunpanel`, auth DB, master key config, package/unit, Nginx/vhost, cert ve release state için geri döndürülebilir backup al; restore'u ayrı test hostunda kanıtla.
- [ ] Aday `.deb` install/upgrade/rollback çalıştır. Required Node/native dependencies, auth CLI, rotation CLI/runbook, systemd ownership/sandbox ve service restart davranışı doğrulanmalı.
- [ ] Hosted sitelerin panel restart/upgrade sırasında çalışmaya devam ettiğini doğrula. Panel management arızasını hosted traffic arızasına dönüştürme.

## T-MIGRATION — P1+: Agentless / Website / Plesk gerçek ortam kabulü

Bu bölüm yalnız ilgili kod `plan.md` içinden tamamlandıkça çalıştırılır.

- [ ] Ubuntu test hostunda agent kapalıyken local root backend ile inventory, Nginx test/reload, Node deploy/restart/rollback, SSL, package management ve root terminali doğrula; site workload'larının dedicated Unix user altında kaldığını kontrol et.
- [ ] Agentless migration için backup -> job drain -> state migration -> new backend health -> old agent disable -> rollback sırasını gerçek package üzerinde test et. IDs, auth DB, master key, vhost, cert, release ve users korunmalı.
- [ ] Kalıcı Website migration'ında apex + iki independent subdomain + alias, explicit parent, app binding, cert ve rollback'i gerçek DNS/test domainiyle doğrula. Domain-ID compatibility ekranını migration başarısı sayma.
- [ ] Plesk importer/migration geliştirildikten sonra external-managed inventory, Passenger/static/Node/DB/Docker/domain/cron/mail ve per-resource rollback'i izole Plesk fixture/test hostunda doğrula.

## Yayın kuralı

Bir maddenin kodunun repoda bulunması kabulün geçtiği anlamına gelmez. Node 24/full workspace, gerçek browser, HTTPS proxy, package/test-host ve gerektiğinde DNS/Ubuntu/Plesk doğrulaması yapılmadan ilgili özelliği production-ready sayma. Çalıştırılmayan testi geçmiş gibi yazma; GitHub Actions kullanma.
