# Website isolation + SFTP ilerleme kaydı — 2026-09-17

Bu kayıt 16 Eylül Website isolation audit'inden sonra tamamlanan source-level işleri ve kalan P0.1 sınırlarını özetler. Kalan ürün/kod işleri `plan.md`, gerçek Ubuntu/package/browser kabul maddeleri `todo.md` içindedir.

## Tamamlanan Website isolation source sınırları

- `88c6d997` ile provisioning planındaki existing SFTP step artık yalnız `id=sftp` olduğu için idempotent kabul edilmiyor. Canonical `websiteId`, `applicationId`, Unix identity ve adapter eşleşmesi zorunlu; stale identity, duplicate SFTP kind ve non-hosted Website'e sızmış SFTP step fail-closed.
- `eb2b9071` ve `6af9fa3c` ile public/core Site create sınırı `wwwMode=independent` için 409 fail-closed davranıyor ve async rejection kontratı korunuyor. Aynı Website altında sahte independent `www.<domain>` resource graph üretimi kapalı.
- `b34c9593` ile hosted Website provisioning; deterministic `yunapp-*` identity, canonical HOME, Website document root, static build/publish root, Passenger app/document root, PHP bootstrap/FPM root ve Node release path'lerini managed Website path contract'ına göre doğruluyor. Stale/duplicate runtime/path step host mutation'a ilerleyemiyor.
- `0fc98259` ile provisioning planner, aynı Website identity altında stale independent-www metadata görürse fail-closed davranıyor; eski test yanlış resource-sharing davranışını artık kabul etmiyor.
- `2d2366e7` regression kontratı independent subdomain'in explicit `parentDomainId` ile ayrı Site create yolundan ayrı Application, Website, Unix identity ve SFTP scope aldığını kilitliyor.
- `ee584241` ile explicit Domain→Website binding, gerçek Website runtime bilgisi varsa trafik target'ıyla da doğrulanıyor. Static root, PHP/Passenger Application ID ve proxy upstream Website binding'inden saparsa Domain create fail-closed; retained legacy direct-systemd migration uyumluluğu ayrı tutuluyor.
- Final Website create yüzeyi explicit parent seçilen subdomain'i yeni Node/static/PHP Application veya kullanılmamış bir Application ile aynı preview/digest korumalı Site create operation'ına bağlıyor. Başka Website'e bağlı Application seçenekleri listeden çıkarılıyor; `wwwMode=independent` seçeneği kaldırıldı ve stale form state'i API'ye ulaşmadan reddediliyor.
- Aynı create yüzeyindeki explicit `shared-site` seçeneği mevcut Website'in canonical Domain/runtime/Unix binding'ini gösterip typed confirmation istiyor. Desteklenen target backend Domain→Website guard'ında tekrar doğrulanıyor; ambiguous legacy/managed Compose target'ları seçenek olmuyor. Bu yol yalnız yeni Domain binding'i oluşturuyor; `www` alias aynı kayıtta kalıyor ve yeni Application, Unix user, runtime, SFTP scope veya mailbox üretilmiyor.

## Isolation audit HTTP/runtime

- `0f457117` authenticated `GET /api/websites/:websiteId/isolation-audit` route kontratını ekledi. Route panel auth guard arkasında, local Website scope kontrolü yapıyor ve audit service hatalarını mevcut Website HTTP error kontratına map ediyor.
- `ef0a0338` audit'i durable Website provisioning registry ve canlı provisioning handler `inspect()` fonksiyonlarıyla production runtime'a bağladı. Capability yalnız gerekli Website/Application registry bağı hazır olduğunda expose ediliyor; local-server scope fail-closed kalıyor.
- Website genel bakışı audit sonucunu persistent Website ID üzerinden yüklüyor; canonical user/HOME/document root/tmp/log beklentilerini, denetlenen provisioning adımlarını ve actionable bulguları gösteriyor. Yeniden denetleme salt okunur kalıyor ve API'ye Domain ID gönderilmiyor.
- Audit inspect-only kalır. Migration gerektiren metadata, operation ve step farkları current/desired değer, ownership gate, step state, bounded inspection reason ve secret-safe intent SHA-256 ile exact değişiklik listesine dönüştürülür. Preview digest bu listeyi pinler ve typed confirmation digest'e bağlıdır.
- Tek fark canonical workspace `tmp`/`logs` eksikliği olduğunda audit `applyAvailable=true` verir. Authenticated apply exact body, preview digest ve typed confirmation'ı yeniden doğrular; canonical user/home/path dışındaki journal intent'ini reddeder.
- Apply intent'i host mutation'dan önce root-private durable migration registry'ye yazılır. Host workspace receipt'i yalnız operation-created direct-child dizinleri sahiplenir. Restartta `applying` state kör replay edilmez; receipt inspection tamamlanmış postcondition'ı kapatır, belirsiz/incomplete state operator müdahalesi için açık kalır.
- Typed rollback yalnız aynı operation receipt'inin sahip olduğu boş dizinleri non-recursive kaldırır; pre-existing veya veri içeren dizin, Unix account/home, runtime ve SFTP state'i korunur. HTTP yüzeyi migration list/get/apply/rollback endpoint'lerini panel auth ve local Website scope arkasında sunar; raw intent veya secret public projection'a çıkmaz.
- Website izolasyon paneli stale “apply kapalı” bildiriminden çıkarıldı. Yalnız `applyAvailable` workspace preview'ında exact path/mode/ownership gate gösterilir, mevcut reusable typed-confirmation dialog'u apply'i başlatır; durable operation durumları ve receipt sonucu listelenir, güvenli statülerde operation/digest-bound rollback açılır. Browser `prompt`/`alert` ve storage kullanılmaz.
- Aynı operation için paralel apply veya rollback istekleri runtime içinde tek host mutation flight'ını paylaşır. İkinci sekme aynı sonucu bekler; workspace adapter'ı eşzamanlı iki kez çalıştırılmaz. Yanlış rollback confirmation aktif flight'a katılamadan reddedilir.

## SFTP public-key lifecycle source durumu

### Durable credential registry

`d85e4f68` ile Website-scoped SFTP public-key registry eklendi:

- yalnız desteklenen OpenSSH public-key satırları kabul edilir;
- private-key payload açıkça reddedilir;
- key fingerprint, duplicate kontrolü, revision, revoke ve rotate semantics durable state'te tutulur;
- public/list projection raw public-key materialini geri döndürmez;
- host materialization için raw public key yalnız internal materialization projection'ında bulunur;
- persisted key Website/Application/Unix binding drift'i fail-closed davranır.

### Root-owned AuthorizedKeysFile

`ba77c394` ile OpenSSH SFTP key materialization user-writable Website HOME dışına taşındı:

- canonical root: `/etc/ssh/yunpanel-authorized-keys`;
- site-specific path: `/etc/ssh/yunpanel-authorized-keys/<yunapp-*>`;
- SFTP `Match User` bloğu explicit `AuthorizedKeysFile` ile bu root-managed dosyaya bağlanır;
- managed directory/file owner ve mode drift'i fail-closed denetlenir;
- atomik replace kullanılır;
- YunPanel marker'ı olmayan mevcut file sessizce overwrite edilmez;
- sıfır active key durumu marker-only managed dosya ile password-disabled/key-disabled erişim politikası üretir.

Bu tasarım site user'ın kendi HOME altındaki `~/.ssh/authorized_keys` dosyasını değiştirerek YunPanel credential lifecycle'ını bypass etmesini engeller.

### Desired-state reconcile servisi

`5afc2898` ile key registry ve host materializer arasına Website SFTP key service eklendi:

- list, add, revoke, rotate, inspect-materialization ve reconcile akışı aynı canonical Website/Application/Unix identity üzerinden çalışır;
- mutation önce durable registry state'ini yazar, sonra exact active key setini root-owned AuthorizedKeysFile'a reconcile eder;
- host materialization başarısızsa mutation sahte başarı dönmez; durable desired state korunur ve `sftp_key_reconcile_required` ile explicit reconciliation gerekir;
- list response yalnız secret-safe key metadata + materialization status döndürür, raw key taşımaz;
- empty active-key set de idempotent reconcile edilebilir.

### Authenticated HTTP ve production bootstrap

`41967b5` ile key lifecycle production API composition'ına bağlandı:

- `GET/POST /api/websites/:websiteId/sftp/keys`, revoke, rotate ve explicit reconcile route'ları panel auth guard arkasına alındı;
- mutation body'leri exact-field doğrulamasıyla sınırlandı; `privateKey` gibi beklenmeyen alanlar service katmanına ulaşmadan reddediliyor;
- read-only rol yalnız secret-safe listeleme route'una erişebiliyor, mutation'lar Owner management sınırında kalıyor;
- mutation audit'i yalnız bounded Website kimliği ve action/outcome tutuyor; label veya raw public-key body metadata'ya girmiyor;
- production bootstrap durable registry'yi control-plane state root altında başlatıyor, yalnız `YUNPANEL_LOCAL_SERVER_ID` kapsamındaki Website'leri kabul ediyor ve root-owned host materializer'a bağlıyor;
- restart testi durable key metadata'sının korunduğunu, public response'un raw key taşımadığını ve remote Website'in 404 kaldığını kilitliyor.

### Provisioning ownership/evidence ve restart reconcile

Website provisioning `sftp` handler'ı artık internal-sftp chroot/config sonucunu tek başına başarı kabul etmiyor. Base izolasyon sağlandıktan sonra current durable key desired state root-owned `AuthorizedKeysFile` üzerine reconcile ediliyor; step evidence yalnız secret-safe adapter, key count ve SHA-256 kimliği taşıyor.

- Empty key set marker-only deny-all dosya olarak aynı lifecycle'da materialize edilir.
- Registry/materialization drift'i handler inspect sonucunda `sftp_key_reconcile_required` + bounded reason bırakır; Website izolasyon paneli bunu host mutation yapmadan gösterir.
- Kesilmiş `applying` SFTP step'i API restartında kör apply/replay yapmaz. Base SFTP ve key materialization birlikte inspect edilmedikçe operation `succeeded` olmaz; explicit key reconcile sonrası aynı interrupted operation evidence ile kapanabilir.
- SFTP compensation key registry desired state'ini veya root-owned key dosyasını örtülü silmez; destructive cleanup mevcut operation-owned SFTP manager sınırında kalır.

### Ubuntu package upgrade smoke

Kaynak commit `675579e` için repo dışı `.local/test-server.env` hedefi kullanılmadan önce IPv4 hedefinin `.44` ile bitmediği ve tek adrese çözüldüğü doğrulandı. Yalnız tanımlı Ubuntu 24.04 test hostuna bağlanıldı.

- Hostun kendi amd64/Node `v24.20.0` ortamında temiz `npm ci`, tam `npm run check` ve production Vite build geçti; `yunpanel_0.3.0-2026091701_amd64.deb` üretildi. Paket SHA-256 değeri `353c10480960ff5acca3a140d261eed20257fcfe66d1874bbe86cc705fff9cd0` olarak doğrulandı.
- Upgrade öncesi packaged `local-runtime validate` geçti, durable recovery state `clear`, aktif job sayısı sıfır, `yun-agent` inactive/disabled ve Nginx active idi.
- Resmi migration backup oluşturulup tekrar doğrulandı; ardından `0.3.0-2026091502` paketinden `0.3.0-2026091701` paketine upgrade edildi.
- Upgrade sonrası `dpkg -V`, API health, web gateway, `local-runtime validate`, recovery state ve `nginx -t` kapıları geçti. Legacy agent kapalı kaldı.
- `/var/lib/yunpanel/control-plane/website-provisioning-registry.json` byte-for-byte korundu ve `root:root 0600` kaldı. Yeni production bootstrap `/var/lib/yunpanel/control-plane/website-sftp-key-registry.json` dosyasını `root:root 0600` oluşturdu.
- Test hostunda `/var/lib/yunpanel/staging/website-identities` altında gerçek ownership receipt fixture'ı yoktu. Bu nedenle receipt içeriğinin upgrade boyunca korunması kanıtlanmış sayılmadı; `todo.md` yalnız bu kalan fixture kabulüne daraltıldı.

## Workspace migration apply/rollback source durumu

Canonical Website workspace yöneticisi operation-scoped receipt tutar. Receipt yalnız apply öncesi mevcut olmadığı doğrulanan `tmp`/`logs` direct-child dizinlerini sahiplenir ve her create sonrası ayrı checkpoint yazar. Restartta `planned` kalmış fakat hostta bulunan dizin ownership'i tahmin edilmez. Compensation pre-existing dizinlere dokunmaz, yalnız checkpoint'li ve boş operation-owned dizinleri ters sırada non-recursive `rmdir` ile kaldırır; dizin veri içeriyorsa fail-closed kalır ve base Unix identity cleanup'ına ilerlemez. Workspace-only inspect/apply/compensation yüzeyi mevcut canonical Unix identity'yi zorunlu tutar fakat user/home create veya delete çağırmaz. Inspect bütün eksik workspace direct-child'larını birlikte raporlar; audit bunları exact path/mode ve `operation_receipt_planned` ownership gate'iyle digest'e dahil eder. API migration journal'ı pending/applying/succeeded/failed/compensating/compensated durumlarını ve secret-safe evidence'ı disk üzerinde korur.

## Kalan P0.1 source işleri

- Workspace dışındaki legacy Unix identity/path/runtime/SFTP drift'leri exact adapter preview ve ayrı operation ownership kanıtı olmadan destructive repair'e açılmamalı.
- Her yeni migration adapter'ı restart inspection, stale revision/digest, operation-owned compensation ve data-preserving rollback testlerini aynı durable lifecycle'a eklemeli.

## Kabul sınırı

Bu source-level ilerleme ve package upgrade smoke, gerçek Website fixture acceptance yerine geçmez. `todo.md` içindeki gerçek UID/GID isolation, ownership receipt preservation, chroot escape, AuthorizedKeysFile owner/mode, real SSH public-key login, revoke/rotate, cross-site rejection ve restart/reconcile maddeleri geçmeden Website isolation/SFTP P0.1 tamamlanmış sayılmaz.

GitHub Actions kullanılmadı. Source test kontratları repoya eklendi; bu ortamda gerçek Ubuntu/OpenSSH kabul testi çalıştırılmış gibi değerlendirilmez.


## 18 Eylül continuation — exact legacy preview ve data-preserving compensation

- `289142fe` + `25262738` canonical Website Unix identity için salt-okunur legacy migration preview ekledi. Preview current UID/GID, account HOME/shell, private-group member count ve canonical HOME mode farklarını exact kodlarla verir; grup üye adları public projection'a çıkmaz ve all-missing state ayrı `safeCreateCandidate` olarak işaretlenir.
- `79fd8ef0` + `1c3f94de` aynı preview'ı path-bound Website/Application contract'ından geçirir. Preview workspace mutation yapmaz; canonical path contract yalnız evidence olarak eklenir.
- `5c33c1c0`–`4c77c635` aralığında Unix identity preview provisioning handler ve isolation audit'e bağlandı. Audit yalnız bounded alanları kabul eder, desired user/HOME'u canonical Application identity ile yeniden bağlar ve host drift evidence'ını migration preview digest'ine dahil eder. Böylece UID/GID/HOME/shell/mode drift'i değişirse eski typed confirmation geçerli kalmaz.
- `c11083e7` + `1c14b38e` Unix identity operation receipt'i için read-only restart inspection ekledi. Receipt bulunmayan pre-existing account operation-owned sayılmaz; ownership checkpoint yazılmadan host state oluşmuşsa inspection fail-closed kalır ve mutation replay edilmez.
- Safe-create identity apply bu aşamada bilerek açılmadı. Mevcut provisioning compensation HOME'u recursive kaldırabildiği için legacy migration rollback'inde aynı davranış kullanılmayacak; plan artık migration'a özel data-preserving/non-recursive rollback kanıtını explicit blocker tutuyor.
- `7b346cde` + `bf41c277` SFTP compensation'daki ownership'i kanıtlanmayan chroot/mount directory recursive delete davranışını kaldırdı. Receipt-owned SSH drop-in ve systemd mount unit geri alınır; chroot/mount dizinleri veri/ownership kanıtı olmadan silinmez.
- `e4cc30cb`–`a1b7fdd8` aralığında SFTP legacy migration preview eklendi ve key-aware provisioning/audit zincirine bağlandı. Preview receipt state, SSH config checksum match, systemd mount-unit checksum/active state, root/chroot/mount uid/gid/mode, `sshd -t` sonucu ve authorized-key key-count/SHA-256 evidence'ını bounded olarak taşır; raw SSH config veya public-key material çıkmaz.
- SFTP ve Unix identity exact preview artık migration digest'ine bağlıdır fakat geniş migration apply hâlâ fail-closed'dur. Kalan P0.1 source işi runtime adapter exact current/desired preview'ı, safe identity create/rollback ve operation-owned runtime/SFTP apply/restart/compensation lifecycle'ıdır.
- Bu oturumda supported Node 24.11.1+ runtime bulunmadığı ve container dış DNS erişimi olmadığı için repo test suite çalıştırılmış sayılmadı. Source-level test kontratları eklendi; gerçek/supported-runtime ve Ubuntu acceptance kapıları `todo.md` içinde kalır.

### 18 Eylül continuation — runtime exact preview genişlemesi

- `157afeda`–`af5e3430` aralığında Passenger Node legacy runtime preview eklendi. Shared Passenger health/version, canonical Website identity, bounded Node binary adayları, current-release symlink ve resolved release/app/document/startup path evidence mutation yapmadan okunuyor. Release escape ve yanlış Node major ayrı bounded drift kodlarıdır; preview canonical Application/path contract'a yeniden bağlanıp isolation migration digest'ine dahil edilir.
- `26b13f69` canonical path boundary kontrolünü string-prefix karşılaştırmasından gerçek path-boundary kuralına daralttı; `/current-escape` gibi prefix-benzeri yollar Passenger preview evidence'ı olarak kabul edilmiyor.
- `b90739bc` + `b7534628` PHP-FPM legacy preview'ını ekledi: canonical identity, document-root uid/gid/mode, distro package/version, operation receipt state, pool file uid/gid/mode + SHA-256, `php-fpm --test`, service active state ve Website socket type/mode bounded current/desired evidence olarak çıkıyor. Raw pool config veya previous config içeriği public preview'a taşınmıyor.
- `7edfc66d` + `7738f571` PHP runtime container preview'ını ekledi: application/releases control directories, operation release + public root ownership/mode, current symlink owner/target ve canonical release ID exact evidence olarak tutuluyor; preview hiçbir chown/chmod yapmıyor.
- `c288222a`–`f19ef54d` aralığında PHP container + PHP-FPM + shared `UMask=0027` evidence tek `php-runtime` preview'ında birleştirildi ve isolation migration digest'ine bounded projection ile bağlandı. Raw config/receipt payload ve beklenmeyen alanlar projection dışı kalıyor.
- Bu noktada P0.1 exact read-only preview kapsamı Unix identity, SFTP, Passenger Node ve PHP runtime için tamamlandı. Kalan runtime-preview boşluğu static publish/release katmanıdır; bundan sonra safe-create identity ve operation-owned migration apply/rollback açılacaktır.

### 18 Eylül continuation — static runtime exact preview ve legacy handler yönlendirmesi

- `6e98fac3` + `d070418c` static publish migration preview'ını ekledi. Canonical identity, ACL tooling presence, publish/releases control-directory uid/gid/mode, managed release kimlikleri + isolation sonucu ve current symlink owner/target bounded current/desired evidence olarak okunuyor; `apt-get`, `chown`, `chmod` veya `setfacl` çalıştırılmıyor.
- `c3195c60` + `81c539ef` current symlink release target parsing'ini ortak bounded helper'a aldı ve `EINVAL` gibi raw host hata kodlarını public-safe `static_publish_current_invalid` reason'ına normalize etti.
- `da6916fe` + `fabee4f4` isolation wrapper'larında production preview wiring'ini tamamladı. Passenger preview artık wrapper içinde kaybolmuyor ve shared `UMask=0027` inspection evidence'ını taşıyor; static wrapper current deployment inspection + publish isolation preview'ını tek `static-runtime` sözleşmesinde birleştiriyor.
- `933a1921` legacy static step intent'inde mode yokluğunu örtük `null` yerine explicit `legacy_unresolved` olarak işaretliyor; bu state migration preview'da görünür kalıyor fakat apply authority anlamına gelmiyor.
- `0ad06f53` + `262ff662` isolation audit'in static Website runtime step'ini durable kayıtta eski `kind=runtime` olsa bile canonical `static_runtime` inspector ile salt-okunur denetlemesini sağladı. Durable step metadata'sı evidence olarak korunuyor; inspector seçimi runtime type'a göre yapılıyor.
- `0a495066` + `5d43ceb1` static runtime preview'ını migration digest'ine bounded projection ile bağladı. Node/Passenger ve static preview seçimleri runtime type'a göre ayrıldı; static current-release veya ACL/ownership drift'i değişirse eski typed confirmation geçersiz oluyor.
- Bu aşamada P0.1 exact read-only legacy preview kapsamı Unix identity, SFTP, Passenger Node, PHP ve static runtime için tamamlandı. Kalan source işi safe-create identity ve diğer legacy migration adapter'larında digest-bound, operation-owned, restart-inspectable apply/rollback lifecycle'ıdır.


### 18 Eylül continuation — Unix identity safe-create durable migration

- `4b96bb07` + `3bd696ce` legacy identity rollback'ini data-preserving yaptı. Operation-owned HOME artık recursive silinmiyor; boş HOME non-recursive kaldırılabilir, veri içeren HOME korunur ve restart compensation inspection `preservedHomeData=true` evidence'ı ile tamamlanmış state'i doğrular.
- `724dd3da` + `8869963c` path-bound identity-only migration lifecycle ekledi. Apply yalnız canonical Website/Application scope'ta preview'ın `safeCreateCandidate=true` verdiği all-missing user/group/HOME state'inde açılır; pre-existing account/group/HOME drift mutation öncesi fail-closed kalır. Workspace `tmp/log` lifecycle bu adapter tarafından değiştirilmez.
- `9e30478b` + `7778f01b` isolation audit'in exact identity safe-create değişikliğini `create_canonical_unix_identity` action'ı, `operation_receipt_planned` ownership gate'i ve digest-bound typed confirmation ile applyable hale getirdi. Safe-create olmayan identity drift hâlâ blocked `reconcile_isolation_step` olarak kalır.
- `cf570e5b`, `34326e7b`, `8da0d3f1` ve `9fb73753` durable isolation migration journal/runtime'ını identity-only operation'a genişletti. Aynı store sürümü eski workspace kayıtlarıyla uyumlu kalır; zero-target operation identity migration olarak dispatch edilir. Restart önce durable identity receipt inspection yapar, tamamlanmış mutation'ı tekrar etmez; stale preview/revision apply'i kapatır. Typed rollback yalnız aynı operation evidence'ını compensation'a taşır.
- `57710c82` + `1bfbc148` production provisioning bootstrap identity migration capability'sini açtı ve eksik lifecycle metodu olan custom migration manager'ı kabul etmeyen composition kontratını kilitledi.
- `0ce28081` + `0b8ecf0f` Website isolation panelini identity/workspace operation türüne göre doğru copy/evidence gösterecek şekilde güncelledi. Identity rollback HOME verisini koruduğunda panel bunu `preservedHomeData` olarak görünür kılar; workspace-only metinleri identity operation'a yanlış uygulanmaz.
- Böylece P0.1 identity safe-create source lifecycle tamamlandı. Gerçek Ubuntu UID/GID, restart-cut ve HOME-data rollback kabulü `todo.md` kapısıdır. Kalan source işi legacy path/SFTP/Passenger/PHP/static mutation'larını yalnız operation-owned evidence ve exact current digest altında güvenle apply/rollback edilebilir hale getirmektir.


### 18 Eylül continuation — SFTP safe-create durable migration

- `f1a0f0fc` + `c3656cc3` SFTP migration preview'ına explicit `safeCreateCandidate` ekledi. Apply authority yalnız receipt/config/unit/site chroot/mount state'i tamamen eksikken ve shared chroot root canonical ya da eksikken açılır; foreign site-specific artifact preview aşamasında mutation öncesi bloklanır.
- `a5e4c171` + `e055e6e8` host SFTP manager'a normal provisioning'den ayrı migration lifecycle ekledi: inspect/apply/compensation restart inspection yüzeyleri durable SFTP receipt evidence'ı üretir.
- `7433bd1f` + `42b441e6` migration lifecycle'ını key-aware provisioning handler'a taşıdı. Safe SFTP apply sonrasında current desired authorized-key set root-owned materialization'a reconcile edilir; key reconcile başarısızsa operation sahte başarı dönmez.
- `e0c32fae`, `dd784a5e`, `e84b9274` ve `c30fc241` isolation audit + durable migration journal/runtime'ını typed `adapter=sftp` operation'a genişletti. Current preview digest/revision yeniden doğrulanır; restart receipt + key materialization inspection ile tamamlanmış operation'ı kapatır ve incomplete state'i kör replay etmez.
- `6b0754c2` + `12d75ea3` SFTP receipt'e operation-created chroot/mount directory checkpoint'leri ekledi. Pre-existing canonical directory yeniden sahiplenilmez veya mutate edilmez; rollback config/unit removal ve unmount sonrasında yalnız checkpoint'li boş directory'leri non-recursive kaldırır. Directory içinde veri görünürse korunur.
- `e1ab6e5f` + `83ba92e5` paneli persisted migration `adapter` alanına göre workspace/identity/SFTP operation'larını ayıracak şekilde güncelledi; SFTP apply/rollback copy'si exact ownership sınırını açıkça gösterir.
- `9fbb5948` ile P0.1 source planı runtime/path migration'a daraldı. Gerçek OpenSSH/systemd/key login/restart/data-preserving rollback acceptance `todo.md` içinde kalır.
