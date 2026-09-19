# Shared Roundcube webmail mapping lifecycle — 2026-09-19

Bu kayıt P0.4 / P0.8 / P0.9 ortak hedefi olan sunucu başına tek shared Roundcube instance + domain-başına `webmail.<domain>` mapping lifecycle ilerlemesini özetler.

## Ürün sınırı

Roundcube domain başına kurulmaz.

Tek shared state:

- Roundcube application/database
- dedicated PHP-FPM pool/socket
- protected Roundcube config
- tek managed Nginx config artifact

Domain mapping state ise ayrı ve revisioned tutulur. Her mapping aynı shared app/FPM socket'ine gider fakat kendi hostname + certificate evidence'ını taşır.

## Mapping registry

Yeni root-private registry:

`roundcube-domain-mapping-registry.json`

Mapping identity:

- mapping ID
- Mail Domain ID
- Web Domain ID
- Server ID
- domainName
- exact `webmail.<domain>` hostname
- certificate ID
- certificate SHA-256 fingerprint
- revision
- state
- operation ID
- shared Roundcube apply job ID
- expected Roundcube preview/Nginx digests
- createdAt/updatedAt

Durable states:

- `pending`
- `active`
- `removing`
- `removed`

V1 active-only mapping store v2'ye active state olarak migrate edilir.

## Certificate ownership

Mapping bind yalnız:

- enabled local Mail Domain,
- exact Web Domain ownership,
- aynı Server,
- active non-staging certificate,
- certificate materialinin gerçekten `webmail.<domain>` hostname'ini kapsaması,
- registry fingerprint ile material fingerprint exact eşleşmesi

halinde açılır.

Private certificate path/key mapping registry'de tutulmaz.

Mevcut DNS-01 wildcard certificate akışı `*.domain` üretebildiği için `webmail.<domain>` coverage için yeni ACME motoru yazılmaz.

## Shared Nginx desired state

`roundcube-nginx` template artık primary mail hostname yanında birden çok mapping server block üretir.

Her mapping:

- kendi `server_name`
- kendi fullchain/private-key path'i
- ortak Roundcube public root
- ortak `/run/php/yunpanel-roundcube.sock`

kullanır.

Public preview yalnız mapping hostname/endpoint taşır, certificate material path'lerini taşımaz.

Roundcube configuration materialization:

- registry mapping inventory'sini okur,
- her certificate'i yeniden doğrular,
- current certificate materialin hostname'i hâlâ kapsadığını doğrular,
- mapping revision/update/certificate evidence'ını Roundcube preview digest'ine dahil eder.

Host activation primary endpoint + bütün mapped endpoint'leri `curl --resolve ... 127.0.0.1` ile health-check etmeden başarılı sayılmaz.

## Durable bind/delete

Mapping mutation doğrudan active/deleted olmaz.

Bind:

1. exact preview
2. `pending` operation intent persist
3. explicit continuation
4. current shared Roundcube desired preview
5. `ROUNDCUBE_CONFIG_APPLY` durable job enqueue
6. exact job ID + preview/nginx digest pin
7. queued/running -> inspect-only
8. exact succeeded evidence -> `active`

Delete:

1. exact active source preview
2. `removing` operation intent persist
3. mapping shared Nginx desired state'ten hemen çıkar
4. explicit continuation
5. current shared Roundcube apply
6. exact succeeded evidence
7. `removed` tombstone

`removed` fiziksel olarak hemen silinmez; operation-owned lost-ack/restart evidence olarak tutulur.

Apply job ID attachment desired mapping revision/update identity'sini değiştirmez. Böylece job dispatch sonrasında preview digest kendi kendine stale olmaz.

## DNS readiness

DNS mail intent mapping desired-state varlığıyla değil canlı apply evidence'ıyla açılır.

Webmail endpoint resolver yalnız:

- `active` mapping,
- current Roundcube desired preview içinde exact mapping revision,
- exact certificate evidence,
- current preview/nginx digest'lerine bağlı succeeded `ROUNDCUBE_CONFIG_APPLY`,
- `httpHealthy=true`,
- `applied=true`

kanıtlandığında readiness verir.

Bundan sonra mevcut DNS desired-state modeli:

- `webmailEnabled=true`
- `webmailHost=webmail.<domain>`

üretir ve A/AAAA kayıtlarını ekler.

Pending/removing/removed mapping veya stale successful job DNS kaydı yayınlatmaz.

## Domain removal entegrasyonu

Resource impact yeni `webmailMappings` bucket'ı taşır ve mapping için ID/state dışında exact metadata evidence'ı korur.

Domain removal preview/journal:

- `webmailMappingIds`
- `webmailMappingIntents`

pinler.

Start yalnız active mapping için orchestratable olur. Pending/removing mapping:

`webmail_mapping_operation_in_progress`

hard blocker'ıdır.

Mapping owner Mail Domain exact local+enabled olmalı ve mapping certificate affected Domain certificate intent setinde bulunmalıdır.

Parent journal step sırası:

`certificate -> webmail_mapping -> mail_domain`

Bu sıra bilinçlidir: certificate registry retirement renewal authority'yi kapatır fakat certificate material ayrı retention policy nedeniyle fiziksel olarak korunur. Webmail mapping Nginx desired state'ten çıkarılırken retained certificate material kullanılabilir; yeni renewal başlatılmaz.

Webmail step:

- suspended Domain evidence'ını doğrular,
- exact source mapping revision/cert/update evidence'ını doğrular,
- deterministic parent-owned removal operation ID kullanır,
- yalnız explicit continuation mutation yapar,
- queued/running Roundcube apply'i replay etmez,
- `removed` tombstone exact parent ownership taşıyorsa startup ikinci Roundcube mutation yapmadan step'i kapatabilir,
- mapping fiziksel olarak/evidence olmadan kaybolmuşsa başarı saymaz,
- foreign removing/removed operation fail-closed kalır.

Descendant mapping intents exact child subset fence ile child Domain operation'a devredilir.

## Production wiring

Production bootstrap:

- mapping store
- registry
- mapping service
- webmail endpoint readiness resolver

oluşturur.

Aynı mapping inventory:

- normal resource-impact API
- durable Domain removal preview/runtime
- shared Roundcube config materializer
- mail DNS readiness

tarafından kullanılır.

## Başlıca commit dilimleri

- `6dfc2858`, `13fb1af4`, `55f28ae6` — mapping registry ve durable/tombstone lifecycle
- `be38a215`, `4d7bcbfe`, `8c4c8ace` — typed orchestration service
- `ed321ca1`, `ea70a3be`, `3753f702` — HTTP + production service wiring
- `f3b6978c`, `e4015684`, `46f235ce` — shared Nginx desired-state + health
- `1d3b7ccc`, `8d5d2e2f`, `bb9401a2`, `4488ba4c` — live DNS readiness
- `a7412d4e`, `7e10de60`, `748c21fb` — impact/plan/journal evidence
- `67d04dcc`, `66feb514`, `aaec153c`, `f4d96c55` — Domain removal runtime + production wiring
- `b235a34f`, `3aad7ae5`, `501ed935` — Mail Domain/certificate ownership fences
- source test contracts adjacent small test commits'te tutulur.

## Açık kalan

Bu kaynak dilimi mevcut local Mail Domain için shared webmail mapping bind/delete lifecycle'ını kurar.

P0.8 site-create input/preflight bugün henüz mail mode taşımıyor. Yeni Website provisioning'de:

- local mail seçimi,
- Mail Domain create/enable,
- wildcard/hostname-covering certificate selection/issuance,
- mapping bind,
- shared Roundcube apply,
- DNS zone re-apply

tek provisioning operation zincirine henüz bağlanmalıdır.

Ayrıca gerçek Ubuntu/browser/DNS kabulü ve Node 24 source testleri çalışmadan ürün maddesi DONE sayılmaz.
