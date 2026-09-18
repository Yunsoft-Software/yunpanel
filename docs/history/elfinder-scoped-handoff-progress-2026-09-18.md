# elFinder scoped handoff + FPM progress — 2026-09-18

Bu kayıt P0.6 elFinder replacement çalışmasının mevcut main branch kaynak durumunu özetler. Gerçek Ubuntu/package/browser/filesystem acceptance geçmeden elFinder production-ready sayılmaz ve homegrown File Manager kaldırılmaz.

## Tamamlanan kaynak sınırları

- Owner-only handoff issuance endpoint eklendi: POST /api/servers/:serverId/websites/:websiteId/elfinder-handoffs.
- Handoff 30 saniyelik, tek kullanımlık, audience=elfinder capability üretir; session/user kimliğine live session registry üzerinden bağlıdır.
- Logout/session revoke live handoff kaydını iptal edebilir.
- Handoff yalnız active local Server ve managed static/node/php Website için açılır.
- Website Unix user canonical application identity'den tekrar hesaplanır; drift durumunda fail-closed kalır.
- Filesystem root request/query/body'den alınmaz; createWebsitePathContract üzerinden canonical Website HOME/SFTP root olarak server-side çözülür.
- Consume sırasında Website revision, applicationId, unixUser, root ve audience tekrar doğrulanır; stale capability reddedilir.

## Private consume boundary

- Handoff consume public HTTP portunda açılmaz.
- /run/yunpanel-elfinder/handoff.sock private Unix socket kullanılır.
- Runtime group yunpanel-elfinder, directory root:yunpanel-elfinder 0750, socket 0660 sınırı source contract'ında pinlidir.
- Consumer yalnız POST /consume ve exact { capability } JSON body kabul eder.
- Response yalnız bounded Website identity/root metadata taşır; capability consume sonrası tekrar kullanılamaz.
- Production boot private socket başlayabildiğinde Owner handoff HTTP route'unu mount eder; socket açılamazsa feature fail-closed disabled kalır.

## Packaging identity

- Debian postinst yunpanel-elfinder system group/user oluşturur.
- yunpanel-elfinder kullanıcısı www-data veya genel yunpanel grubuna eklenmez.
- /var/lib/yunpanel/elfinder private 0700; /run/yunpanel-elfinder ve /usr/lib/yunpanel/elfinder root:yunpanel-elfinder 0750 hazırlanır.
- tmpfiles runtime directory contract'ı korunur.

## Per-Website PHP-FPM template

- Ubuntu 24.04 distro PHP 8.3 için deterministic per-Website pool template eklendi.
- Pool exact canonical yunapp-* user/group altında çalışır.
- Socket /run/php/yunpanel-elfinder-<yunapp-user>.sock olur; www-data yalnız socket üzerinden bağlanır.
- HOME/chdir/root canonical /var/lib/yunpanel/data/<applicationId> olarak pinlenir.
- temp/upload/session path canonical Website HOME/tmp altındadır.
- open_basedir yalnız Website HOME + packaged shared elFinder root ile sınırlandırılır.
- shell/process execution fonksiyonları disable edilir; pool root veya shared broker identity altında çalışmaz.
- Şimdilik bu yalnız template/preview contract'ıdır; gerçek materialization/configtest/reload lifecycle tamamlanmış değildir.

## Connector template başlangıcı

- /usr/share/yunpanel/elfinder/connector.php için hardened connector template eklendi.
- Connector root/path/unixUser/websiteId/applicationId alanlarını request'ten kabul etmez.
- Root ve Website identity yalnız FPM environment'tan alınır.
- Root canonical Website HOME olmalı, symlink olmamalı ve realpath exact eşleşmelidir.
- PHP process effective user exact Website unixUser olmalıdır.
- elFinder network drivers kapatılır; LocalFileSystem root canonical Website HOME'a pinlenir.
- followSymLinks=false, chmod ve netmount disabled, upload/archive sınırları tanımlıdır.
- Connector henüz config-templates public export/test/materialization/package vendor lifecycle'ına tam bağlanmış değildir.

## Kalan exact kod işleri

1. Connector template'i export et ve source testlerle request-forged root, effective-user, symlink/root policy ve unsafe feature disable contract'ını pinle.
2. Shared elFinder vendor application/package layout'ını oluştur; connector + vendor autoload fixed paths package tarafından materyalize edilsin.
3. Per-Website FPM pool materialization/configtest/reload/rollback lifecycle'ını ekle.
4. Same-origin protected Nginx/FastCGI gateway'i handoff capability consume ile exact Website FPM socket'e bağla; vendor endpoint public bypass olmasın.
5. Browser Files action/client'i handoff üzerinden shared elFinder UI'a bağla.
6. Traversal/symlink/archive escape/special-file/cross-site source guards ve gerçek-host acceptance ekle.
7. Acceptance sonrası homegrown site-file-manager kaldır.

GitHub Actions kullanılmadı.