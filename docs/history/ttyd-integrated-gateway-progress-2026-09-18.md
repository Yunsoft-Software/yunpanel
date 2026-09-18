# ttyd IntegratedToolGateway progress — 2026-09-18

Bu kayıt P0.7 ttyd replacement ve reusable IntegratedToolGateway kaynak çalışmasının 2026-09-18 main branch durumunu özetler. Bu çalışma gerçek Ubuntu/browser/TUI acceptance değildir; `todo.md` T-TOOLS kapıları geçmeden ttyd production-ready sayılmaz ve legacy `node-pty`/xterm kaldırılmaz.

## Reusable IntegratedToolGateway

- phpMyAdmin, elFinder ve ttyd için ortak descriptor sözleşmesi eklendi.
- Descriptor tool id, audience, public prefix, live API access path ve private Unix socket/socket-root bilgisini tek kaynaktan tanımlar.
- phpMyAdmin/elFinder `owner` access mode, ttyd `session` access mode kullanır.
- API auth boundary ile public web gateway aynı descriptor kaynağını okur; hardcoded path/socket drift'i azaltılmıştır.
- Session-bound tool için session-specific authorizer yoksa API access gate fail-closed `503` kalır.
- ttyd access gate yalnız exact tool session UUID + current Owner management session/user eşleşmesinde `204` verir.

## ttyd package runtime

- Ubuntu `ttyd` paketi allowlist package manager üzerinden yönetilir.
- `/usr/bin/ttyd` root-owned, regular, non-group/world-writable binary olarak doğrulanır.
- `ttyd --version` bounded output ile doğrulanır.
- Distro `ttyd.service` package install öncesi maskelenir; install sonrasında `mask --now` ile masked + inactive state tekrar doğrulanır.
- YunPanel distro ttyd systemd daemon'ını veya default TCP listener'ını ürün runtime'ı olarak kullanmaz.

## Shared terminal target resolver

- Legacy node-pty ve ttyd aynı Server/Website target resolver'ı kullanır.
- Server terminal target sabit `root` + `/root` + `/bin/bash --login`.
- Site terminal target managed `yunapp-*` identity ve exact `current` release symlink sınırına bağlıdır.
- Static/Node Website shell cwd `.../current`; PHP Website document root `.../current/public` ise cwd server-side `.../current` olarak türetilir.
- Current symlink exact UUID release altına resolve edilmeden terminal açılmaz.
- Caller command, executable, user veya cwd seçemez.
- Source-controlled environment secret-free allowlist'tir.

## One-shot ttyd session manager

- Her session random UUID alır ve private `/run/yunpanel/ttyd/<sessionId>.sock` üzerinden çalışır.
- Socket root `root:yunpanel 02770`; session socket `yunpanel:yunpanel 0660` evidence'ı olmadan public session dönmez.
- Fixed ttyd argv: private `--interface`, `--socket-owner yunpanel:yunpanel`, `--writable`, `--check-origin`, `--max-clients 1`, `--once`, `--signal 1`, fixed cwd/base-path/auth-header/terminal type.
- URL argument, ttyd Basic Auth credential veya public TCP port kullanılmaz.
- Site ttyd daemon'ı native `--uid/--gid` ile exact Website UID/GID'ye düşer; child shell doğrudan `/bin/bash --noprofile --norc -i` çalıştırır.
- Root terminal ttyd process'i root kalır ve `/bin/bash --login` çalıştırır.
- Startup deadline 60 saniye, absolute lifetime 4 saat, global session limit 20, Owner başına 5'tir.
- HTTP page load session'ı connected saymaz; startup deadline yalnız authenticated WebSocket access geçince iptal edilir.
- Live-session revoke, explicit close, startup timeout, lifetime timeout, shutdown veya process failure SIGHUP + bounded SIGKILL cleanup zincirine girer.
- Session socket process exit sonrası kaldırılır.

## Capability -> ttyd session bridge

- Existing `POST /api/terminal/capabilities` kısa ömürlü tek-use Owner/session-bound terminal capability üretmeye devam eder.
- New `POST /api/terminal/ttyd-sessions` body olarak yalnız exact `{ capability }` kabul eder.
- Capability aynı Owner session/user için consume edilmeden ttyd session başlamaz.
- Public ttyd session response yalnız protocol/audience/sessionId/verified target/basePath/expiresAt taşır.
- Private `.sock` path, internal ttyd auth header veya raw capability public response'a çıkmaz.
- `DELETE /api/terminal/ttyd-sessions/:sessionId` yalnız current Owner session/user'ın exact session'ını kapatır ve mutable close argument kabul etmez.

## Public HTTP/WebSocket gateway

- Public browser route yalnız `/tools/ttyd/<uuid>/...` şeklidir.
- Invalid UUID, traversal veya encoded traversal benzeri ttyd path'leri SPA fallback'e gitmeden 404 kalır.
- Public gateway private socket path üretmeden önce `/api/ttyd-gateway-access` session-bound authorizer'dan `204` ister.
- Browser-supplied `x-yunpanel-tool-session`, `x-yunpanel-tool-transport`, `x-yunpanel-ttyd-auth`, proxy identity ve forwarding header'ları strip edilir.
- API access gate'e session UUID path'ten türetilmiş internal `x-yunpanel-tool-session` olarak gider.
- HTTP ve WebSocket transport internal olarak ayrılır; WebSocket authorization `markConnected=true` ile session startup evidence'ını ilerletir.
- Panel auth cookie, CSRF token ve internal proxy credential ttyd upstream'e aktarılmaz.
- Gateway yalnız kendi fixed reverse-proxy auth header'ını inject eder.
- WebSocket Origin exact panel origin olmalıdır; ttyd `--check-origin` native policy'si de korunur.

## Active WebSocket reauthorization

- ttyd WebSocket established olduktan sonra authority yalnız handshake anında bırakılmaz.
- Public web gateway active ttyd WebSocket'i 15 saniyede bir session-bound API access gate üzerinden reauthorize eder.
- Owner auth/role/MFA/session ownership artık valid değilse veya access gate unavailable olursa public ve upstream WebSocket destroy edilir.
- Bu sınır logout/logout-all/session revoke gibi yetki kayıplarının açık terminalde devam etmesini önlemek içindir.

## Browser UI

- Reusable TerminalPanel artık ttyd'yi primary action olarak gösterir.
- Browser capability'yi URL/query/hash/localStorage/sessionStorage içine koymaz.
- Capability normal authenticated/CSRF API POST ile ttyd session'a çevrilir; component state yalnız validated public session metadata tutar.
- Same-origin ttyd UI iframe içinde `/tools/ttyd/<sessionId>/` path'inden açılır.
- User close veya component dispose Owner-bound DELETE cleanup denemesi yapar.
- Server root terminal ve managed static/node/php Website terminal aynı ttyd-primary component'i kullanır.
- Legacy embedded xterm/node-pty yolu `Legacy gömülü terminal` migration fallback olarak halen source'ta bulunur.

## Packaging upgrade

- Package upgrade aktif `yunpanel-api`, `yunpanel-web` ve varsa `yun-agent` servislerini `try-restart` eder.
- Bu özellikle yeni broker supplementary-group üyelikleri ve yeni API/web gateway source'unun reboot beklemeden aktif process'lere geçmesi için gereklidir.

## Source kontratları

Bu turda source testleri şu sınırları pinler:

- reusable gateway descriptors ve production descriptor wiring;
- session-bound auth authorizer fail-closed davranışı;
- ttyd package install + distro service masking;
- shared target resolver + PHP current/public -> current policy;
- site UID/GID native process drop;
- one-shot socket/session lifecycle, startup/lifetime limits ve live-session revoke;
- Owner-bound explicit close;
- capability -> ttyd session bridge;
- HTTP/WebSocket Unix-socket gateway;
- browser-forged internal header stripping;
- ttyd browser session validator + primary UI wiring;
- production boot/shutdown wiring;
- package upgrade service restart.

GitHub Actions kullanılmadı. Full repository/real package test suite bu dokümanda geçmiş sayılmaz; gerçek acceptance `todo.md` içindedir.

## Kalan exact işler

1. Fresh Ubuntu 24.04 gerçek package testinde ttyd binary/version, masked inactive distro service, private socket root/session socket metadata ve no-public-TCP evidence doğrula.
2. Chromium/Firefox ile Owner root ve static/node/php site terminalinde Ctrl+C/Ctrl+D, Unicode/IME, resize, vim/top/full-screen TUI ve parallel session acceptance yap.
3. Wrong Origin/cookie/MFA/role/session, replay/expired capability, direct socket/port ve cross-session access reddini doğrula.
4. Açık WebSocket sırasında logout/logout-all/session revoke/user disable/role-MFA değişimini gerçek browserda doğrula; en fazla reauthorization intervali içinde terminal kapanmalı.
5. API/web/package restart/upgrade sırasında orphan ttyd/session socket/process kalmadığını doğrula.
6. T-TOOLS kabulü geçtikten sonra custom node-pty/xterm backend/frontend/package dependency fallback'ini kaldır.
