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
- package upgrade sonrası registry/receipt korunması;
- iki Website arasında gerçek UID/GID izolasyonu;
- Passenger/Nginx/Node dependency failure ve onarım sonrası continue akışı.
