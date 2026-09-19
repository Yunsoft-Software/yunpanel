# Site-create mail intent progress — 2026-09-19

Bu kayıt P0.4 ve P0.8 kapsamındaki yeni Website oluşturma akışında mail intent/preflight ilerlemesini özetler.

## Deterministic resource identity

External lifecycle registry artık opsiyonel operation-derived resource ID kabul eder.

Mail Domain registry bu primitive üzerinden explicit `mailDomainId` ile create edilebilir.

Böylece aynı site-create operation retry edildiğinde Mail Domain için yeni rastgele kimlik üretilmez; operation'a bağlı deterministic kimlik korunur.

İlgili commitler:

- `fd716c68` — external lifecycle registry deterministic resource IDs
- `e77179bf` — Mail Domain registry explicit deterministic ID

## Site-create input

Site-create input artık opsiyonel:

`mail: { mode: 'none' | 'local' | 'external' }`

alanını taşır.

Default `none` eski site-create davranışını ve response/lifecycle shape'ini korur.

### none

- Mail Domain ID üretilmez.
- Mail Domain planı yoktur.
- Webmail intent'i yoktur.
- Eski no-mail site-create lifecycle semantics korunur.

### local

Local mail yalnız `httpsMode=managed` ile kabul edilir.

Preview deterministic olarak:

- Mail Domain ID
- primary Domain ile exact Web Domain ilişkisi
- `managementMode=local`
- `initialStatus=disabled`
- `desiredStatus=enabled`
- `webmail.<primary-domain>`
- shared Roundcube requirement
- certificate coverage requirement

üretir.

Current metadata create aşaması yalnız disabled Mail Domain kaydını oluşturur.

Özellikle:

- default mailbox yaratmaz,
- default/bilinen parola üretmez,
- Mail Domain'i enabled yapmaz,
- Postfix/Dovecot config apply tetiklemez,
- DKIM üretmez,
- webmail mapping'i active yapmaz,
- DNS yayınlamaz.

Bu kasıtlıdır: durable provisioning step'leri bağlanmadan `ready` mail davranışı taklit edilmez.

### external

Preview deterministic Mail Domain ilişkisini:

- `managementMode=external`
- `initialStatus=unverified`
- `desiredStatus=null`

olarak üretir.

Shared Roundcube/webmail intent'i oluşturmaz.

## Conflict / retry fence

Preview:

- aynı domainName'i farklı Mail Domain ID sahiplenmişse,
- aynı Web Domain başka Mail Domain'e bağlıysa,
- deterministic ID mevcut fakat relationship/mode farklıysa

fail-closed kalır.

Aynı operation retry'sinde exact deterministic metadata mevcutsa preview aynı digest ile complete/resume state'ini doğru hesaplar.

## Source test coverage

`apps/api/test/site-create.test.js` kaynak kontratı şunları pinler:

- no-mail legacy semantics,
- local mail managed HTTPS zorunluluğu,
- deterministic Mail Domain ID,
- local disabled metadata-only create,
- retry/idempotent preflight,
- external unverified relationship,
- local webmail hostname intent.

İlgili commitler:

- `9e32f03f` — site-create mail provisioning intent
- `6699d084` — no-mail preview semantics fix
- `7d6f9efb` — legacy no-mail lifecycle shape preservation
- `aaa2ca07` — source tests

## Henüz bağlı olmayan provisioning adımları

Bu ilerleme preflight/metadata reservation katmanıdır. P0.8 apply/recovery için hâlâ:

1. local Mail Domain enable/config transition,
2. DKIM lifecycle,
3. SPF/DMARC/DKIM DNS desired state,
4. hostname-covering certificate issuance/selection,
5. shared Roundcube mapping bind,
6. Roundcube durable apply + mapped-host health,
7. DNS re-apply sonrası webmail A/AAAA,
8. cross-service health,
9. failure/recovery/compensation

tek Website provisioning operation journal'ına bağlanmalıdır.

Bu işler tamamlanmadan `mailDomainCreated=true` yalnız control-plane metadata reservation evidence'ıdır; çalışır mail servisi veya webmail readiness anlamına gelmez.
