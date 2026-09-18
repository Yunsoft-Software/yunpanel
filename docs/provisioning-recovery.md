# Website provisioning recovery sözleşmesi

Bu belge YunPanel Website provisioning akışının restart, retry ve compensation davranışını tanımlar. Ürün hedefleri `docs/architecture.md`, kalan implementasyon işleri `plan.md`, gerçek Ubuntu/package/browser kabul kapıları `todo.md` içindedir.

## Kaynakta mevcut durum — 2026-09-14

Mevcut durable provisioning akışı aşağıdaki recovery parçalarına sahiptir:

- operation ve step state'i disk-backed registry'de tutulur;
- failed step yalnız operation + step'e bağlı explicit confirmation ile retry edilir;
- desteklenen step'ler operation + step'e bağlı explicit confirmation ile compensate edilir;
- Unix identity ve Nginx compensation operation-owned evidence/receipt ile fail-closed çalışır;
- public HTTP read model raw intent, evidence, resource secret veya compensation evidence taşımaz;
- Site overview son provisioning operation'ını Website ID üzerinden gösterir ve yalnız backend'in izin verdiği retry/compensate aksiyonlarını açar;
- API startup sırasında registry'deki `applying` / `compensating` operation'ları `listInterrupted()` ile bulur ve mevcut orchestrator'ın inspect-first reconciliation yolundan geçirir;
- Site overview recovery yönlendirmesi yalnız public `kind`, `state` ve bounded error code'larından türetilir; raw intent/evidence kullanılmaz.

Direct-systemd → Passenger migration tarafında kaynakta ayrıca read-only host preview, canonical Passenger env binding, health-gated Nginx cutover, operation-owned rollback receipt ve legacy systemd cleanup coordinator bulunur. Control-plane runtime binding registry ve canonical application-level migration preview da mevcuttur. Ana job queue/apply/reconciliation authority zinciri tamamlanmadan bu migration production-accepted sayılmaz.

Bu maddeler kaynak implementasyon durumudur. Gerçek Ubuntu restart/failure-injection kabulü tamamlanmış sayılmaz; ilgili maddeler `todo.md` içinde açık kalır.

## Startup recovery kuralı

API başlangıcında interrupted operation bulunursa YunPanel yeni host mutation başlatmaz.

1. Registry yüklenir.
2. Yalnız step state'i `applying` veya `compensating` olan operation'lar seçilir.
3. `applying` step için handler `inspect` çalışır.
4. Inspect sonucu mevcut host durumunun hedefi gerçekten karşıladığını kanıtlarsa durable step `succeeded` yapılır.
5. Inspect hedefi kanıtlayamazsa step `applying` kalır ve kullanıcıya/manual remediation yoluna bırakılır. `apply` otomatik tekrar edilmez.
6. `compensating` step için aynı model `inspectCompensation` ile uygulanır. Compensation gerçekten tamamlandıysa durable state tamamlanır; belirsizse destructive compensation tekrar edilmez.
7. Startup recovery bir sonraki `pending` step'i otomatik başlatmaz. Yeni mutation normal explicit provisioning devam akışından geçer.

Amaç crash sonrası “komut çalıştı mı çalışmadı mı?” belirsizliğini ikinci kez aynı komutu çalıştırarak çözmeye çalışmamaktır.

## Ownership ve compensation kuralı

Destructive rollback yalnız operation'ın sahipliği kanıtlanabilen kaynağa uygulanır.

### Unix identity

- `useradd` sonrasında UID/GID ve managed home ownership durable receipt'e checkpoint edilir.
- Receipt ile mevcut UID/GID uyuşmazsa drift kabul edilir ve cleanup bloklanır.
- Host üzerinde user/group/home bulunduğu halde durable ownership checkpoint yoksa YunPanel sahipliği tahmin etmez.
- Ownership bilinmiyorsa `userdel`, `groupdel` veya recursive home delete yapılmaz.
- Önceden var olan ve operation tarafından oluşturulmadığı kanıtlanan identity korunur.

### Nginx

- Compensation operation-owned staged/active config ve checksum evidence üzerinden ilerler.
- Checksum/ownership eşleşmiyorsa var olan vhost körlemesine ezilmez veya silinmez.
- Shared Passenger runtime site-level compensation kapsamına girmez; server-owned dependency olarak korunur.

## Website isolation migration recovery

Website isolation audit'ten açılan migration apply normal provisioning retry yolu değildir. Ayrı durable isolation migration journal'ı exact Website revision + preview digest + typed confirmation'a bağlıdır.

Kaynakta apply authority verilen dar operation türleri:

- `workspace`: yalnız preview'da eksik olduğu kanıtlanan canonical `tmp`/`logs` direct-child dizinleri;
- `identity`: yalnız canonical Unix user/group/HOME üçlüsünün tamamı eksikken safe-create;
- `sftp`: yalnız site-specific SSH drop-in, mount unit, chroot/mount ve receipt state'i safe-create şartını sağlarken; authorized-key desired state ayrıca root-owned materialization ile reconcile edilir;
- `php`: yalnız PHP container ownership/path, shared package/service ve `UMask=0027` zaten canonical iken eksik site-specific FPM pool.

Bu journal'da mutation öncesi operation intent'i persist edilir. `applying` veya `compensating` state ile restart edilirse adapter önce read-only operation receipt/host inspection çalıştırır; completed postcondition kanıtlanırsa journal kapatılır, kanıtlanamıyorsa aynı mutation otomatik replay edilmez.

Rollback sınırı operation türüne göre dardır:

- workspace yalnız operation-created ve boş direct-child dizinleri non-recursive kaldırır;
- identity receipt-owned user/group'u geri alır; HOME boşsa non-recursive kaldırabilir, veri içeriyorsa koruyup `preservedHomeData` evidence'ı bırakır;
- SFTP receipt-owned SSH config/unit ve operation-created boş chroot/mount dizinlerini kaldırır; veri içeren dizinleri ve durable key desired state'ini korur;
- PHP yalnız receipt-owned site pool'u restore/remove eder; shared package/service, UMask ve container ownership'e dokunmaz.

Passenger legacy runtime ve static legacy permissions preview'ları explicit blocked-authority state taşır (`automaticMigration=false`). PHP container ownership/path drift'i de receipt-backed rollback authority olmadan apply'e çevrilmez. Bu drift'ler exact preview digest'e girer fakat automatic/typed migration mutation'ı başlatmaz.

## Retry ve continue kuralı

Retry bir bypass yolu değildir.

- Yalnız `failed` ve aktif compensation'ı olmayan step retry edilebilir.
- Retry step'i `pending` durumuna döndürür ve aynı normal inspect/apply orchestrator yoluna sokar.
- Non-failed step, yanlış step ID veya yanlış confirmation fail-closed reddedilir.
- `continue` yalnız normal operation akışını ilerletir; terminal `failed` / `compensated` durumları çözülmeden sonraki mutation'a atlamaz.

Confirmation formatları:

- continue: `continue-site-provisioning:<operationId>`
- retry: `retry-site-provisioning:<operationId>:<stepId>`
- compensation: `compensate-site-provisioning:<operationId>:<stepId>`

## Runtime adapter transition recovery

Direct-systemd → Passenger geçişi normal Website provisioning step'inden farklı olarak çalışan trafiğin supervisor ve Nginx target'ını değiştirir. Bu yüzden aşağıdaki ek kurallar bağlayıcıdır.

### Mutation öncesi snapshot

Migration job yalnız control-plane'in persisted state'inden üretilen snapshot ile başlatılır. Snapshot en az şunları içerir:

- exact Application ID + current release ID + active runtime;
- exact Website ID + Website revision;
- geçiş kapsamındaki exact Domain ID + desired/applied revision;
- canonical hostname/aliases, TLS ve bounded Nginx settings;
- eski direct-systemd proxy route'unun expected port/health identity'si.

Client raw Passenger target, filesystem path, node binary, Unix user/group veya env include gönderemez. Bunlar host canonical identity/readiness katmanından türetilir.

### Cutover sırası

1. Mevcut systemd source release/health ve aktif Nginx checksum doğrulanır.
2. Canonical Passenger env include hazırlanır ve operation ownership receipt'i yazılır.
3. Passenger target readiness tekrar doğrulanır.
4. Passenger Nginx config stage edilir.
5. Source route mutation öncesi bir kez daha checksum ile doğrulanır.
6. Nginx activate/configtest/reload yapılır.
7. Gerçek hostname üzerinden Passenger health gate geçer.
8. Ancak bundan sonra legacy systemd stop/disable yapılır.

Bu sıralama tersine çevrilemez. Hedef health kanıtı gelmeden systemd kapatılamaz.

### Failure ve rollback

- Passenger config stage/configtest/reload başarısız olup eski route'un korunduğu kanıtlanıyorsa operation-owned env include compensate edilir.
- Passenger route aktif olduktan sonra health başarısızsa eski systemd source tekrar health/release açısından doğrulanır; ardından önce Nginx eski route'a compensate edilir, yalnız Nginx rollback doğrulandıktan sonra operation-owned env include geri alınır.
- Nginx rollback state'i belirsizse env include korunur; belirsiz trafik üstüne ikinci destructive cleanup yapılmaz.
- Source da artık sağlıklı değilse otomatik rollback yapılmaz. YunPanel ölü olduğu tahmin edilen source'a trafik çevirmek yerine actionable recovery state bırakır.

### `cleanup_required` kuralı

Passenger route health-gated biçimde aktif olduktan sonra legacy systemd stop/disable başarısız olabilir. Bu durumda:

- sağlıklı Passenger trafiği geriye çevrilmez;
- job sonucu `migrated` değil `passenger_active_cleanup_required` olur;
- durable runtime binding adapter=`passenger`, state=`cleanup_required` olarak tutulabilir;
- source operation ID, release, Website revision ve Domain revision/checksum evidence kaybolmaz;
- retry yalnız eksik cleanup/reconciliation bölümünü inspect-first biçimde tamamlar; Nginx cutover körlemesine ikinci kez yapılmaz.

### Control-plane reconciliation

Host sonucu ancak queued snapshot hâlâ current state ile birebir eşleşiyorsa `ApplicationRuntimeBinding` authority'sine yazılır. Aşağıdakilerden biri drift etmişse reconciliation fail-closed kalır:

- Application current release veya active runtime;
- Website ID/application binding veya Website revision;
- Domain ID/Website binding, hostname/aliases, desired/applied revision, TLS veya Nginx settings;
- host sonucundaki application/release identity;
- Passenger target/Nginx checksum evidence.

Reconciliation başarısız olsa bile terminal host sonucu yok edilmez. Durable job recovery kaydı acknowledgment almadan kalır; operator current control-plane state ile host state'i uzlaştırmadan yeni mutation normal başarı gibi ilerlemez.

### Domain restage guard

Passenger binding current revision'larla eşleşiyorsa normal Domain stage/reload target'ı eski proxy portundan üretemez. Runtime binding Nginx target resolution'ın authority'sidir. Bu guard olmadan migration tamamlanmış sayılmaz; çünkü bir sonraki SSL/Domain update Passenger route'unu direct-systemd proxy'ye geri çevirebilir.

Bir Website birden fazla bağımsız Domain route'a sahipse mevcut tek-route migration supervisor cleanup yapamaz; bütün route'lar atomik/kanıtlı scope'a alınana kadar migration blocker olarak kalır. Alias aynı Domain route'un parçasıdır.

## UI recovery kuralı

Site overview şu bilgileri gösterebilir:

- operation ID ve required-step progress;
- step ID/kind;
- durable public state;
- bounded public error code;
- compensation public state/error;
- `canRetry` ve `canCompensate` capability'leri;
- public state'ten türetilen handler-kind bazlı remediation guidance.

UI şunları göstermemelidir:

- raw provisioning intent;
- host evidence;
- ownership receipt içeriği;
- service/database/mail credential;
- private provider response;
- secret-bearing resource metadata.

Mevcut guidance aileleri Unix identity, Passenger/static runtime, Nginx ve certificate adımları için tanımlıdır. Yeni mutating adapter eklendiğinde kendi actionable remediation metni de aynı dilimde eklenmelidir.

## Yeni mutating adapter için zorunlu contract

DNS, mail, database, SFTP, backup, logs/analytics ve diğer host-mutating adapter'lar aşağıdakileri sağlamadan Website provisioning golden path'ine alınmaz:

- bounded ve doğrulanmış intent;
- idempotent veya inspect-before-apply davranışı;
- başarılı sayılmak için explicit durable evidence;
- restart sonrası host state'i güvenle okuyabilen `inspect`;
- destructive rollback gerekiyorsa operation-owned ownership receipt/evidence;
- compensation destekleniyorsa `inspectCompensation`;
- drift/unknown ownership durumunda fail-closed davranış;
- public-safe error code ve actionable remediation guidance;
- secret-safe HTTP/job/audit projection;
- source testleri ve `todo.md` içinde gerçek-host failure-injection/restart acceptance maddesi.

## Kabul durumu

Kaynak kod testleri bu contract'ın davranışını modellemelidir; ancak gerçek kabul için `todo.md` geçerlidir. Özellikle aşağıdakiler gerçek Ubuntu'da doğrulanmadan recovery production-accepted sayılmaz:

- process crash/restart tam mutation sınırlarında;
- Unix UID/GID/home ownership drift;
- Nginx config/checksum drift;
- interrupted compensation restart;
- direct-systemd → Passenger cutover sırasında configtest/reload/health/systemd cleanup failure injection;
- Passenger aktifken API restart sonrası runtime binding/job reconciliation ve `cleanup_required` resume;
- package upgrade sonrası registry/receipt korunması;
- iki Website arasında gerçek UID/GID izolasyonu;
- Passenger/Nginx/Node dependency failure ve onarım sonrası continue akışı.