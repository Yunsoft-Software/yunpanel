# Website isolation + SFTP ilerleme kaydı — 2026-09-17

Bu kayıt 16 Eylül Website isolation audit'inden sonra tamamlanan source-level işleri ve kalan P0.1 sınırlarını özetler. Kalan ürün/kod işleri `plan.md`, gerçek Ubuntu/package/browser kabul maddeleri `todo.md` içindedir.

## Tamamlanan Website isolation source sınırları

- `88c6d997` ile provisioning planındaki existing SFTP step artık yalnız `id=sftp` olduğu için idempotent kabul edilmiyor. Canonical `websiteId`, `applicationId`, Unix identity ve adapter eşleşmesi zorunlu; stale identity, duplicate SFTP kind ve non-hosted Website'e sızmış SFTP step fail-closed.
- `eb2b9071` ve `6af9fa3c` ile public/core Site create sınırı `wwwMode=independent` için 409 fail-closed davranıyor ve async rejection kontratı korunuyor. Aynı Website altında sahte independent `www.<domain>` resource graph üretimi kapalı.
- `b34c9593` ile hosted Website provisioning; deterministic `yunapp-*` identity, canonical HOME, Website document root, static build/publish root, Passenger app/document root, PHP bootstrap/FPM root ve Node release path'lerini managed Website path contract'ına göre doğruluyor. Stale/duplicate runtime/path step host mutation'a ilerleyemiyor.
- `0fc98259` ile provisioning planner, aynı Website identity altında stale independent-www metadata görürse fail-closed davranıyor; eski test yanlış resource-sharing davranışını artık kabul etmiyor.
- `2d2366e7` regression kontratı independent subdomain'in explicit `parentDomainId` ile ayrı Site create yolundan ayrı Application, Website, Unix identity ve SFTP scope aldığını kilitliyor.
- `ee584241` ile explicit Domain→Website binding, gerçek Website runtime bilgisi varsa trafik target'ıyla da doğrulanıyor. Static root, PHP/Passenger Application ID ve proxy upstream Website binding'inden saparsa Domain create fail-closed; retained legacy direct-systemd migration uyumluluğu ayrı tutuluyor.

## Isolation audit HTTP/runtime

- `0f457117` authenticated `GET /api/websites/:websiteId/isolation-audit` route kontratını ekledi. Route panel auth guard arkasında, local Website scope kontrolü yapıyor ve audit service hatalarını mevcut Website HTTP error kontratına map ediyor.
- `ef0a0338` audit'i durable Website provisioning registry ve canlı provisioning handler `inspect()` fonksiyonlarıyla production runtime'a bağladı. Capability yalnız gerekli Website/Application registry bağı hazır olduğunda expose ediliyor; local-server scope fail-closed kalıyor.
- Audit inspect-only'dir. Audit sonucu migration gerektiriyorsa raw recursive ownership repair yapmaz; migration apply hâlâ ayrı preview/digest + typed-confirmation operation olarak tamamlanmalıdır.

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

## Kalan P0.1 source işleri

- Final Website create/preflight/panel yüzeyinde independent subdomain explicit `parentDomainId` + ayrı Website create olarak sunulmalı; `shared-site` seçimi mevcut Website binding'ini açıkça göstermeli ve default bağımsız Website olmalı.
- Isolation audit sonucu panelde gösterilmeli; migration apply exact preview/digest + typed confirmation ile operation-owned değişiklikler yapmalı, recursive blind `chown` yapmamalı.
- SFTP key registry/service için authenticated add/list/revoke/rotate/reconcile HTTP route'ları ve production durable store/runtime bootstrap wiring tamamlanmalı.
- SFTP key desired state/materialization Website provisioning ownership/evidence ve restart/reconcile lifecycle'ına bağlanmalı.
- Legacy Website migration apply canonical identity/path/runtime/SFTP drift raporu olmadan destructive ownership repair yapmamalı.

## Kabul sınırı

Bu source-level ilerleme gerçek Ubuntu acceptance yerine geçmez. `todo.md` içindeki gerçek UID/GID isolation, chroot escape, AuthorizedKeysFile owner/mode, real SSH public-key login, revoke/rotate, cross-site rejection, restart/reconcile ve package upgrade kabul maddeleri geçmeden Website isolation/SFTP P0.1 tamamlanmış sayılmaz.

GitHub Actions kullanılmadı. Source test kontratları repoya eklendi; bu ortamda gerçek Ubuntu/OpenSSH kabul testi çalıştırılmış gibi değerlendirilmez.