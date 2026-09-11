# YunPanel — Gerçek Ortam / Kabul TODO

Bu dosyada yalnız bu geliştirme oturumunda güvenilir biçimde yapılamayan **gerçek Node 24, browser, Ubuntu, package, DNS ve rollback kabul işleri** tutulur. Kod geliştirme işleri `plan.md`, bağlayıcı kurallar `agents.md` içindedir. GitHub Actions kullanma. Secret/parola/cookie/MFA secret/private key veya kullanıcı verisini repo, log, screenshot ya da test fixture'ına yazma.

2026-09-09/10 tarihindeki Node24/package/canlı kabuller tarihsel referanstır; sonraki agentless recovery, migration backup/stage/validate, common audit ve kalıcı Website source değişikliklerini kapsamaz. Güncel `main` ayrıca doğrulanmadan “full check geçti” denmez.

## T-RUNTIME — P0 güncel full check

- [ ] Mixed/stale web/API build ile privileged management'in fail-closed kaldığını ayrıca doğrula.

## T-AUTH-AUDIT — P0 gerçek HTTPS/browser kabulü

- [ ] Gerçek HTTPS Owner akışında setup/login/TOTP/recovery/password/session/logout/logout-all/idle/absolute timeout çalışsın.
- [ ] İki tab browser race: delayed 200/401, cookie rotation, lost MFA response, `pageshow`, keep-alive ve session revoke yarışlarını doğrula.
- [ ] Read Only session yalnız izinli resource GET/HEAD'lerine ulaşsın; mutation/jobs/users/audit/sensitive nested endpointler 403 kalsın.
- [ ] Trusted proxy/client-IP/rate-limit spoof kabulünü gerçek reverse proxy üzerinde tamamla; forwarding header doğrudan güvenilmesin.
- [ ] Owner `/api/audit` gerçek auth/MFA sınırında çalışsın; Read Only 403. actor/resource/action/outcome/time filtreleri ve pagination gerçek browser/API isteğiyle doğrulansın.
- [ ] Owner mutation → queued job → local/legacy terminal completion ve `job-recovery` terminal handoff actor bağını aynı private auth SQLite üzerinde doğrula. `system` scheduler işleri Owner gibi görünmemeli.
- [ ] Audit tablosu/job linkleri password, cookie, CSRF, env value, MFA secret, request/response body, raw job output veya terminal output içermemeli.
- [ ] Auth DB/WAL/SHM ve audit state root-owned/service-owned doğru private izinlerle kalmalı; restart/upgrade/backup-restore sonrası audit schema tekrar açılmalı.

## T-AGENTLESS — P1 gerçek Ubuntu host kabulü

- [ ] Exact `YUNPANEL_LOCAL_SERVER_ID` + OS hostname + exclusive lock + root `yunpanel-api.service` startup/shutdown zincirini gerçek Ubuntu 24.04 hostta doğrula.
- [ ] 30s local snapshot host inventory + allowlisted systemd services + Docker + Nginx'i aynı server record'a persist etsin; snapshot/binding fault executor'ı drain edip lock'u bıraksın.
- [ ] Executor disk-full/read-only/lost acknowledgement senaryolarında successful host mutation'ı failed diye yeniden yazmasın; ambiguous state yeni claim/retry'ı durdursun.
- [ ] `.recovery.json` sidecar 0600 ve secret-free kalsın; running/terminal/mixed recovery sınıflandırması restart sonrası korunsun.
- [ ] Bütün güncel recovery komutlarını gerçek host evidence/receipt ile doğrula: read-only inspect, domain stage/activate, static deploy/rollback, Node deploy/restart/rollback, DB create/delete, service control/install/restart, system upgrade, certificate issue/renew.
- [ ] Generic force-success/force-failed, blind mutation retry veya evidence-free journal clear yolu bulunmasın.
- [ ] Node/static clone/install/build ve runtime dedicated `yunapp-*`; Node systemd unit `NoNewPrivileges=true`, boş capabilities ve bounded writable path kullansın.
- [ ] Local ownership altında retained legacy heartbeat/command/environment/result 409 `server_managed_locally` kalsın.
- [ ] Web service process environment/state mountlarında control-plane secrets görünmesin.

## T-MIGRATION — P1 agentless migration/rollback

- [ ] Gerçek packaged hostta API+agent stopped + queue/recovery clear iken `local-migration-backup create -> verify -> preview -> stage` zincirini çalıştır.
- [ ] Backup/snapshot/stage rootları 0700, archive/manifest 0600; checksum tamper, missing required path, source symlink, duplicate/special member, link escape, type drift ve partial-stage cleanup fail-closed olsun.
- [ ] `/etc/passwd` ve `/etc/group` yalnız `yunapp-*` identity reference olsun; live overwrite yapılmasın. UID/GID/home/shell/group drift doğru raporlansın.
- [ ] Enrolled host: verified snapshot sonrası `bind <id> --backup-dir <snapshot> --confirm`, exact env ID, agent disable, API start, `local-runtime validate <id>` sırasını uygula.
- [ ] Fresh agentless host: verified snapshot sonrası `create --backup-dir <snapshot> --confirm`; `agentTokenHash=null`, enrollment credential yok. API start sonrası `validate` geçmeden functional mutation yapma.
- [ ] `validate` exact local ownership/hostname, API active, agent inactive, queue/recovery zero, fresh local snapshot, exact packaged API version ve loopback `/api/health` 200 `status=ok` istemeli.
- [ ] Existing enrolled host rollback: new rollback snapshot → verify/preview/stage → API+agent stop → `release <id> --backup-dir <snapshot> --confirm` → agent enable/start. Fresh local-only identity release edilememeli.
- [ ] Live restore/apply kodu açıldığında per-target replace, owner/mode/ACL/xattr, pre-apply backup, health gate ve deterministic rollback gerçek isolated hostta kanıtlanmadan production'a alınmasın.
- [ ] Migration + rollback kabulü tamamlandıktan sonra `yun-agent.service` ve retained transport kaldırılırken package upgrade disabled agent'ı tekrar enable etmemeli.

## T-WEBSITE — P1 kalıcı Website/domain kabulü

- [ ] Güncel Node24 full testte file-backed Website registry persistence, restart-time server/application FK validation, migration policy persistence ve corruption guards çalışsın.
- [ ] Production package `YUNPANEL_WEBSITE_STORE=/var/lib/yunpanel/control-plane/website-registry.json` ve `YUNPANEL_WEBSITE_MIGRATION_POLICY_STORE=/var/lib/yunpanel/control-plane/website-migration-policy.json` altında private state oluştursun; restart/upgrade kimlikleri veya policy mode/digest bilgisini değiştirmesin.
- [ ] Authenticated API'de Owner Website create/list/detail; Read Only list/detail/explicit Website→Domain read ve POST/migration 403 davranışını gerçek listener üzerinden doğrula.
- [ ] Website store v1→v2 upgrade'i gerçek package state üzerinde ID değiştirmeden revision/proxy target alanlarını eklesin. Owner update preview/apply exact revision + linked-Domain digest + typed confirmation istesin; stale Website/Domain state ve duplicate Application rebind mutation üretmesin, Read Only iki update route'unda 403 kalsın.
- [ ] Static/Node Website binding'i canonical application root + deterministic `yunapp-*` user kullansın; stale/missing/cross-server application reference startup'ta fail-closed olsun.
- [ ] Domain `websiteId` ilişkisi same-server ve existing Website şartını korusun; legacy kayıtlar compatibility modda `websiteId=null` olarak okunabilsin ve otomatik server/port/hostname tahminiyle kalıcı bağ oluşturulmasın.
- [ ] IDN hostname inputları gerçek API'de canonical ASCII punycode olarak persist olsun; Unicode/punycode eşdeğerleri duplicate hostname/alias olarak kabul edilsin.
- [ ] Owner site-create preview/apply'i gerçek packaged listener'da static, Node, existing Application ve external proxy ile doğrula. Exact operation/digest/confirmation, managed port collision, explicit `www` alias/child, stale-state no-mutation ve Application/Website sonrası kesilen işlemin duplicate üretmeden devamı korunmalı; DNS/certificate/mail sonucu false kalmalı.
- [ ] Owner Domain reparent preview/apply gerçek listener'da exact explicit parent/digest/typed confirmation istesin; stale hierarchy, cycle, cross-server ve dot-boundary ihlali mutation üretmesin. Reparent sonrası hostname, target, certificate ve desired/staged/applied traffic state aynı kalsın; Read Only iki POST route'unda 403 alsın.
- [ ] Owner `GET /api/websites/migration/preview` ve `/status` için deterministic digest/current policy üretimini doğrula. Read Only her iki migration route'unda 403 kalmalı.
- [ ] Existing-Website migration bind exact `domainId + websiteId + previewDigest + typed confirmation` istemeli; state değişirse stale digest hiçbir Domain mutationı üretmemeli, aynı tamamlanmış bind retry'ı idempotent kalmalı.
- [ ] Migration finalize yalnız fresh preview bütün Domainleri `already_bound` gösterdiğinde exact digest ile `compatibility -> enforced` geçsin. Enforced modda yeni unbound managed Domain 409 `website_binding_required`, same-server explicit Website ile create başarılı olsun.
- [ ] Policy rollback yalnız exact enforced digest + typed confirmation ile compatibility moduna dönsün; migration-only binding rollback exact ledger identity/digest istesin; iki rollback de Nginx target, certificate, application release veya Domain traffic revision değiştirmesin.
- [ ] Apex + bağımsız subdomain + alias + application + certificate + Website-create/bind orchestration + policy finalize/rollback'i gerçek test domainiyle uçtan uca doğrula.

## T-SERVICES-DB — P1/P2 gerçek host functionality

- [ ] Nginx, MariaDB/MySQL, Docker, Cron, Postfix, Dovecot, Rspamd inspect ve güvenli bir servis üzerinde install/start/stop/restart gerçek `apt/systemctl` ile çalışsın.
- [ ] MariaDB↔MySQL conflict fail-closed kalsın; mevcut DB engine bozularak değiştirilmesin.
- [ ] MySQL/MariaDB Unix socket root auth ile engine/version/non-system inventory; test DB create→inspect→drop→inspect çalışsın. System DB ve injection isimleri reddedilsin.
- [ ] DB/job/private receipt state'inde raw SQL/socket path/client output/credential bulunmasın.

## T-PACKAGE-LIVE — P0/P1 package ve canlı kapı

- [ ] Node24 full check tamamlandıktan sonra yeni `.deb` üret; `dpkg-deb -c/-I` ile root API, Website/audit/migration-policy files, local-runtime, migration backup CLI, bütün job-recovery komutları, receipts, runbooklar ve web sandbox'ın aynı committen paketlendiğini doğrula.
- [ ] İzole Ubuntu hostta clean install + old-package upgrade yap. Auth DB/master key/state permissions, disabled-agent preservation, Website/audit/migration-policy schema ve local runtime startup davranışı korunmalı.
- [ ] Hosted static/Node siteler panel restart/upgrade sırasında çalışmaya devam etsin.
- [ ] `0.3.0-4` ↔ yeni agentless aday package/state rollback provası yap; IDs, auth, master key, vhost, cert, Website/application/domain/policy ve release state korunmalı.
- [ ] Gerçek live hosta ancak isolated package/migration/rollback kabulünden sonra geç.

## T-FUTURE — ilgili kod geldikten sonra

- [ ] Terminal/WS: Owner root terminal + site `yunapp-*` terminal, Origin/session/MFA/revoke/cleanup/backpressure ve open-close audit kabulü.
- [ ] DNS/wildcard/custom-cert/mail/Docker/backup/cron/Plesk importer ilgili `plan.md` kodu tamamlandıkça gerçek provider/host fixture'larında doğrulanır.
- [ ] Görsel UI/UX responsive/polish kabulü backend functionality tamamlandıktan ve tasarım ayrı modele verildikten sonra yapılır.

## Yayın kuralı

Repoda kod bulunması kabulün geçtiği anlamına gelmez. Güncel Node24/full workspace, gerçek browser/HTTPS, package/Ubuntu ve ilgili DNS/mail/Plesk/migration testleri tamamlanmadan production-ready etiketi verme. GitHub Actions kullanma.
