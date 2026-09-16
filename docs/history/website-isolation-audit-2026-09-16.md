# Website isolation audit — 2026-09-16

Bu kayıt Website/domain create ve provisioning isolation akışında doğrulanan mevcut sınırları ve kalan P0 işlerini özetler. Tamamlanmış özellik listesi değildir; uygulanacak işler `plan.md` içinde kalır.

## Doğrulanan mevcut davranış

- Public/core Website create girişi artık `apps/api/src/site-create.js` üzerinden `wwwMode=independent` isteğini fail-closed reddediyor. Eski create implementasyonu `site-create-base.js` altında tutuluyor ve public wrapper doğrudan preview/apply ile `siteCreateInternals.normalizeInput` çağrılarında aynı 409 kontratını uyguluyor. Bu sınır `eb2b9071` ve async rejection semantiğini koruyan `6af9fa3c` commitleriyle kapatıldı.
- HTTP create akışındaki `site-create-isolation-guard.js` aynı invariantı korumaya devam ediyor; dolayısıyla route katmanı ile public core katmanı arasında independent-www bypass kalmıyor.
- Alias semantiğinde apex ve alias hostname'lerinin aynı Website/Application'a bağlanması doğru modeldir. Ayrı Website oluşturulması ayrı Unix identity/SFTP scope'u doğuracağı için alias için kullanılmamalıdır.
- Provisioning SFTP dekorasyonu canonical Website/Application/Unix identity kontratını doğruluyor. Existing `sftp` step'i stale identity taşıyorsa, aynı kind farklı ID ile duplicate edilmişse veya non-hosted Website'e SFTP step'i sızmışsa fail-closed davranıyor. Bu sınır `88c6d997` ile regression testleriyle kilitlendi.

## Kalan açıklar

### Gerçek independent subdomain resource graph

`wwwMode=independent` artık yanlış resource graph üretmek yerine fail-closed. Ancak özellik tamamlanmış değildir.

Kalan iş:

- Independent subdomain create flow'u ayrı Website/Application identity üretmeli.
- Ayrı Unix user/group, SFTP scope, runtime ownership ve canonical managed path contract kullanılmalı.
- Parent/child Domain ilişkisi açık ID referansıyla kurulmalı; ayrı Website kaynakları örtük paylaşılmamalı.
- Alias/shared-site regression testi tek Website/Application ve tek isolation/SFTP unit oluştuğunu doğrulamalı; `shared-site` yalnız explicit seçim olmalı.

### Provisioning isolation plan bütünlüğü

SFTP ve Unix identity canonicalization tamamlandı. Kalan plan bütünlüğü işi filesystem/runtime isolation step'leridir.

Kalan iş:

- Existing `isolation` ve webroot/runtime-dir step'leri canonical `websiteId`, `applicationId`, Unix identity ve managed path contract'ına göre doğrulanmalı.
- Duplicate, stale veya identity/path uyuşmazlığı fail-closed olmalı; sessizce complete kabul edilmemeli.
- Eksik isolation/webroot step'leri idempotent eklenmeli; doğru existing step ikinci kez üretilmemeli.
- Regression testleri stale isolation/webroot identity/path, duplicate isolation ve alias/shared-site senaryolarını kapsamalı.

## Kabul sınırı

Bu source-level düzeltmeler Website OS isolation kapısını tek başına tamamlamaz. Gerçek Ubuntu hostta ayrı UID/GID, çapraz home/release/log erişim reddi, SFTP chroot/escape ve restart/reconcile davranışı `todo.md` kabul maddeleri geçmeden P0.1 tamamlandı sayılmaz.

GitHub Actions kullanılmaz; source testleri küçük commitlerle ilerletilir.
