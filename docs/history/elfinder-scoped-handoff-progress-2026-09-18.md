# elFinder scoped handoff + gateway progress — 2026-09-18

Bu kayıt P0.6 elFinder replacement çalışmasının 2026-09-18 main branch kaynak durumunu özetler. Gerçek Ubuntu/package/browser/filesystem acceptance geçmeden elFinder production-ready sayılmaz ve homegrown File Manager kaldırılmaz.

## Owner handoff ve private consume

- Owner-only `POST /api/servers/:serverId/websites/:websiteId/elfinder-handoffs` endpoint'i short-lived, tek kullanımlık, `audience=elfinder` capability üretir.
- Capability session/user identity'ye live-session registry üzerinden bağlıdır; logout/session revoke consume edilmemiş handoff'u iptal eder.
- Hedef yalnız active local Server ve managed `static/node/php` Website olabilir.
- Website `applicationId`, canonical `yunapp-*` Unix user ve Website revision consume öncesi tekrar doğrulanır.
- Root browser/request alanından alınmaz; canonical Website HOME/SFTP root olan `/var/lib/yunpanel/data/<applicationId>` server-side path contract'tan çözülür.
- Handoff yalnız metadata doğruluğuna güvenmez: `websiteProvisioningRuntime.handlers.elfinder.inspect` ile shared app, per-Website FPM, UMask ve private gateway readiness kanıtı yoksa capability basılmaz.
- Consume public TCP endpoint değildir; `/run/yunpanel-elfinder/handoff.sock` private Unix socket kullanılır.
- Consumer yalnız exact JSON `{ capability }` body kabul eder, consume sonrası token replay edilemez.

## Packaging ve shared application

- Debian package `yunpanel-elfinder` dedicated system group/user oluşturur; broker user `www-data` veya genel `yunpanel` grubuna eklenmez.
- Restricted web process olan `yunpanel` user yalnız broker socket erişimi için `yunpanel-elfinder` supplementary group'una eklenir.
- `/run/yunpanel-elfinder` root:`yunpanel-elfinder` `0750`, handoff socket `0660`; broker state home'u private `0700` kalır.
- elFinder upstream vendor `2.1.70`, exact commit `e7ea668fd569fc9903fb1c431d47d58f2daad2f2` olarak pinlenir.
- `scripts/fetch-elfinder-vendor.sh` tag/commit/origin/clean-tree sözleşmesini doğrular; build sırasında “latest” indirme yapılmaz.
- Debian builder vendor tree'yi `/usr/share/yunpanel/elfinder/vendor/elfinder` altına `.git` metadata olmadan paketler.
- Hardened `connector.php`, YunPanel `index.html` ve `yunpanel-client.js` build sırasında config template'ten deterministik üretilir.
- Browser UI CDN kullanmaz; distro `libjs-jquery` ve `libjs-jquery-ui` asset'leri local same-origin path'lerden servis edilir.
- Managed-service allowlist `php-fpm`, `php-mbstring`, `php-zip`, `libjs-jquery`, `libjs-jquery-ui` paketlerini ve fixed asset paths/PHP syntax'ını doğrular.
- PHP readiness ayrıca `posix_geteuid`, `posix_getpwuid`, `mb_strlen` ve `ZipArchive` availability kontrolü yapar.

## Hardened connector

- Connector request/query/body'den root/path/Unix user/Website/Application identity kabul etmez.
- FPM environment root canonical Website HOME olmalı, symlink olmamalı ve `realpath` exact eşleşmelidir.
- Effective PHP user exact canonical Website `yunapp-*` user olmalıdır.
- elFinder yalnız `LocalFileSystem` driver kullanır; network drivers kapalıdır.
- `followSymLinks=false`; `netmount` ve `chmod` kapalı; upload/archive boyut sınırları tanımlıdır.
- Shell/process execution fonksiyonları FPM policy'de disable edilir.

## Per-Website PHP-FPM materialization

- Her managed Website için deterministic pool `yunpanel-elfinder-<yunapp-user>` üretilir.
- Pool exact Website UID/GID altında çalışır; HOME/chdir/root canonical `/var/lib/yunpanel/data/<applicationId>` olur.
- Temporary/upload/session path yalnız Website HOME `tmp` altındadır.
- Dedicated socket `/run/php/yunpanel-elfinder-<yunapp-user>.sock` olarak üretilir.
- `open_basedir` Website HOME + shared packaged elFinder root ile sınırlandırılır.
- Host materializer durable receipt, config checksum, `php-fpm8.3 --test`, service activation/reload, socket inspection ve operation-owned compensation uygular.
- Foreign/drifted mevcut pool sessizce overwrite edilmez.
- Configtest/apply failure'da operation-before config presence/bytes state'i geri yüklenir.

## Private Nginx gateway

- Generated Nginx config yalnız `/run/yunpanel/elfinder-http.sock` Unix socket'inde dinler; TCP listener üretmez.
- Browser root/socket seçemez. Connector FastCGI target yalnız web gateway'in inject ettiği validated `Website/Application/yunapp-*` identity header'larından türetilir.
- Browser-supplied `x-yunpanel-elfinder-*` header'ları public web gateway'de strip edilir.
- Static vendor/client asset path'leri fixed package roots'tan servis edilir; raw connector/vendor PHP/internal package metadata doğrudan yayınlanmaz.
- Gateway manager generated config'i atomik uygular, previous config'i digest-scoped root-private snapshot'a alır, state-directory symlink/ownership drift'ini reddeder.
- `nginx -t`, reload/start, socket `root:yunpanel 0660` metadata ve Unix-socket curl health geçmeden gateway ready sayılmaz.
- Configtest/reload/health failure'da exact previous config veya previous absence restore edilir; rollback validate/reload failure successful apply gibi raporlanmaz.

## Browser/session gateway

- API authentication boundary `/api/elfinder-gateway-access` için canlı Owner/MFA management session gerektirir; Read Only erişemez.
- Browser elFinder shell yalnız `#handoff=<capability>` fragmentini kabul eder.
- Fragment JS tarafından hemen `history.replaceState` ile temizlenir; capability query/path/browser storage'a yazılmaz.
- Capability same-origin POST ile `/tools/elfinder/__yunpanel/handoff` endpoint'ine gönderilir ve private handoff socket'te consume edilir.
- Consume sonrası raw capability saklanmaz; web gateway random opaque tool session üretir.
- Tool session panel auth cookie digest'ine bağlıdır. Panel session değişirse aynı tool cookie connector erişimi vermez.
- Tool cookie HttpOnly + SameSite=Strict; production'da Secure ve yalnız `/tools/elfinder/` path scope kullanır.
- Her `/tools/elfinder/*` request live Owner access gate'ten tekrar geçer.
- Connector request'i tool session olmadan upstream FPM'e ulaşmaz.
- Panel auth/tool cookie veya internal proxy token Nginx/PHP upstream'e geçirilmez.

## Provisioning ve UI

- `elfinder` Website provisioning step'i managed `static/node/php` Website'lerde `unix_identity` sonrasında required step'tir.
- Apply sırası shared elFinder package/dependency health → per-Website FPM → PHP service UMask `0027` → private Nginx gateway → final FPM inspection olarak fail-closed ilerler.
- Website bu required step succeeded olmadan provisioning planında ready olamaz.
- Files UI elFinder handoff'u birincil aksiyon olarak kullanır.
- Browser helper handoff target/server/Website/audience/expiry doğrular ve capability'yi yalnız fragmentte taşıyarak `/tools/elfinder/` sayfasına gider.
- PHP Website'ler de managed Files/Terminal sekmelerine dahil edilmiştir.
- Homegrown `site-file-manager` source ve legacy Files görünümü gerçek acceptance tamamlanana kadar migration fallback olarak tutulur; genişletilmez.

## Kalan işler

1. Fresh Ubuntu 24.04'te gerçek package install/upgrade, PHP extension paths, Nginx config/socket restart davranışı ve root-private rollback snapshot'ını doğrula.
2. Gerçek Chromium/Firefox ile handoff fragment temizliği, Owner logout/revoke, direct vendor/connector bypass ve long-running Files UX acceptance yap.
3. İki gerçek Website UID/GID ile upload/download/edit/rename/move/copy/delete/mkdir/archive ve traversal/symlink/archive escape/special-file/oversize/cross-site denemelerini gerçek filesystem üzerinde doğrula.
4. Acceptance sonrası legacy `site-file-manager` HTTP/worker/backend/UI yollarını kaldır ve upgrade/rollback'te orphan session/process kalmadığını doğrula.

GitHub Actions kullanılmadı.
