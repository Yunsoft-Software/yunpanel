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

## Kalan P0.1 source işleri

- Isolation migration apply exact değişiklik preview/digest + typed confirmation ile operation-owned değişiklikler yapmalı ve geri alabilmeli; recursive blind `chown` yapmamalı.
- Legacy Website migration apply canonical identity/path/runtime/SFTP drift raporu olmadan destructive ownership repair yapmamalı.

## Kabul sınırı

Bu source-level ilerleme ve package upgrade smoke, gerçek Website fixture acceptance yerine geçmez. `todo.md` içindeki gerçek UID/GID isolation, ownership receipt preservation, chroot escape, AuthorizedKeysFile owner/mode, real SSH public-key login, revoke/rotate, cross-site rejection ve restart/reconcile maddeleri geçmeden Website isolation/SFTP P0.1 tamamlanmış sayılmaz.

GitHub Actions kullanılmadı. Source test kontratları repoya eklendi; bu ortamda gerçek Ubuntu/OpenSSH kabul testi çalıştırılmış gibi değerlendirilmez.
