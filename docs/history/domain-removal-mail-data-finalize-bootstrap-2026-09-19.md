# Domain removal Mail Domain data/finalization/bootstrap ilerlemesi — 2026-09-19

Bu kayıt P0.9 Domain removal zincirindeki Mail Domain child operation'ın metadata cleanup sonrasındaki eksik kaynak fazlarını ve production bootstrap bağlantısını özetler.

## Eklenen kaynak lifecycle

- mail-domain-removal-data-phase.js
  - backing_up fazında preview sırasında pinlenmiş exact domain mail-data snapshot'ını yeniden doğrular.
  - Backup job'ını operation-scoped deterministic idempotency key ile kuyruğa alır ve job ID'sini child journal'a pinler.
  - Startup inspection backup dispatch etmez; eksik dispatch yalnız explicit continuation ister.
  - Succeeded backup sonucu ile persisted backup manifest'inin scope/identity/source snapshot/content evidence'ını birlikte doğrulamadan deleting_data fazına geçmez.
  - Verified backup sonrasında mailbox credential kayıtlarını pinned revision/address/update evidence'ıyla explicit çağrı başına bir tane kaldırır.
  - Startup inspection mailbox credential delete replay etmez.
  - Mailbox credential cleanup bittikten sonra live mail data exact pinned snapshot'tan sapmadıysa verified backup ID + exact resource revision ile MAIL_DATA_DELETE job'ını dispatch eder.
  - Succeeded delete job + canlı present=false post-condition kanıtlanmadan finalizing fazına geçmez.

- mail-domain-removal-finalize-phase.js
  - Local akış yalnız pinned backup/data-delete/cleanup/final revision evidence'ıyla mevcut guarded mailDeleteFinalizeService üzerinden Mail Domain metadata finalization yapar.
  - External akış local DKIM/filesystem/backup/delete işine girmez; empty local-dependency planını doğrulayıp deterministic cleanup evidence journal'ladıktan sonra yalnız external Mail Domain metadata unlink yapar.
  - Startup finalization inspection destructive mutation yapmaz; metadata zaten yoksa exact removed reconciliation üretir, mevcutsa explicit continuation bekler.

- mail-domain-removal-phase-router.js
  - Local fazları config -> cleanup -> data -> finalize adapter'larına bağlar.
  - External akışı yalnız pending/finalizing -> finalize sınırında tutar.
  - Pending veya terminal state startup inspector üzerinden mutation adapter'ına düşmez.

## Durable idempotency ve production composition

- Generic job registry'ye secret-free findIdempotentJob() eklendi.
  - Exact idempotency key + exact request digest eşleşmesinde public job döner.
  - Aynı key farklı work digest'iyle kullanılırsa conflict verir.
  - Durable registry read wrapper'ı bu lookup'ı restart sonrasında da korur.
- mail-domain-removal-production-runtime.js eklendi.
  - Mail removal plan service, v3 operation registry, config cleanup/data/finalize adapters ve phase router tek runtime altında compose edilir.
  - Config-disable crash recovery gerçek durable job idempotency lookup'ına bağlanır.
- index.js local Server production bootstrap'ında root-private Mail Domain removal operation store ile runtime initialize eder.
- domain-removal-production-runtime.js parent Domain removal journal/runtime'ını production composition'a bağlar.
  - Parent mail_domain step artık gerçek Mail Domain child runtime dependency'sine sahiptir.
  - Backup/cron gibi henüz olmayan resource-impact provider'ları uydurulmaz; yeni Domain removal preview bu eksik provider'larda fail-closed kalmaya devam eder.
- index.js parent Domain removal operation store'u initialize eder. Public full Domain delete apply route'u bu çalışma ile açılmadı.

## Bu turdaki küçük commitler

- 626ae3d7 — mail removal backup/mailbox/data-delete phase.
- 02fa12e8 — data phase source test kontratları.
- e4c5c1f0 — local/external finalization phase.
- 5a8768fa — finalization source test kontratları.
- 3c1d7bb6 — phase router.
- 692deee7 — phase router source test kontratları.
- bf941908 — job idempotency lookup.
- b62685e3 — durable lookup forwarding.
- 66ea1214 — idempotency lookup source test kontratı.
- 91a34e13 — Mail Domain removal production runtime composition.
- 42da7359 — Mail Domain removal production bootstrap.
- a4605a36 — parent Domain removal production runtime composition.
- 6f1bf199 — parent Domain removal production bootstrap.

## Doğrulama durumu

Sonraki yerel doğrulama (Node v24.21.0, 2026-09-19):

- `node --test` ile Mail Domain removal data/finalize/router/config/cleanup/runtime, Domain removal plan/operation/runtime/external DNS, job registry/durable wrapper ve backup impact dosyaları birlikte: **141 test geçti**.
- `npm run check`: lint, bütün workspace testleri (**3929 geçti, 0 başarısız**) ve web build geçti.
- `node --check` ile `apps/api/src`, `packages/host-runtime/src` ve `packages/config-templates/src` altındaki **490 JavaScript dosyası** geçti. Production bootstrap içindeki `index.js` sözdizimi kontrol edildi; gerçek host boot veya servis kabulü olarak yorumlanmaz.
- Mail Domain finalization `removed()` callback çağrısı düzeltildi; güncel Webmail/External DNS intent, SQL mail, certificate ve Roundcube fixture'ları aynı kapıda doğrulandı.

Gerçek Ubuntu mail, DNS, failure-injection ve restart kabulü `todo.md` T-PROVISIONING/T-MAIL altında açıktır.

## Kalan P0.9 sınırı

- Gerçek Ubuntu failure-injection ile backup dispatch, mailbox credential cleanup, data delete, finalization ve restart reconciliation kabulü.
- Domain-başına gerçek shared Roundcube webmail.<domain> mapping lifecycle'ı oluştuğunda delete tarafındaki mapping cleanup.
- External DNS destructive ownership/retirement handler'ları.
- Domain delete impact graph'ındaki Unix/runtime/DB/SFTP/log/backup/cron provider boşlukları.
- Full public Domain delete apply yüzeyi; bütün dependency provider ve destructive handler'lar fail-closed source/real-host kabulü geçmeden açılmamalıdır.
