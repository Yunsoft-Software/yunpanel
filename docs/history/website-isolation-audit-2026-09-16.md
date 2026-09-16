# Website isolation audit — 2026-09-16

Bu kayıt Website/domain create ve provisioning isolation akışında doğrulanan mevcut sınırları ve kalan P0 işlerini özetler. Tamamlanmış özellik listesi değildir; uygulanacak işler `plan.md` içinde kalır.

## Doğrulanan mevcut davranış

- HTTP Website create akışı `wwwMode=independent` isteğini `site-create-isolation-guard.js` üzerinden fail-closed reddediyor. Böylece normal HTTP akışında `www.<domain>` yanlışlıkla parent Website kimliğini paylaşarak "independent" oluşturulamıyor.
- Alias/shared-site semantiğinde apex ve alias hostname'lerinin aynı Website/Application'a bağlanması doğru modeldir. Ayrı Website oluşturulması ayrı Unix identity/SFTP scope'u doğuracağı için alias için kullanılmamalıdır.
- Provisioning tarafında gerçek Website kaynağı isolation + SFTP ownership sınırıdır; bağımsız subdomain bu nedenle ayrı Website/Application identity üzerinden provision edilmelidir.

## Bulunan kalan açıklar

### Core create bypass

`site-create.js` doğrudan çağrıldığında eski `wwwMode=independent` yolu `www.<domain>` Domain kaydını aynı `websiteId` altında oluşturabilecek stale davranış taşıyor. HTTP guard bu yolu dışarıdan kapatsa da core invariant aynı seviyede korunmuyor.

Kalan iş:

- Core create katmanı da gerçek ayrı Website/Application implementasyonu tamamlanana kadar `wwwMode=independent` için fail-closed davranmalı.
- Sonraki implementasyonda independent subdomain ayrı Website/Application, ayrı Unix user/group, ayrı SFTP scope ve ayrı runtime ownership almalı.
- Alias/shared-site regression testi tek Website/Application ve tek isolation/SFTP unit oluştuğunu doğrulamalı.

### Provisioning isolation plan bütünlüğü

Mevcut isolation completion akışında planda `id: "sftp"` step'i bulunması tek başına yeterli kabul edilebiliyor. Stale veya yanlış Website/Application/Unix user/path bağlamı taşıyan bir SFTP step'i canonical isolation identity ile eşleştirilmeden kabul edilmemelidir.

Kalan iş:

- Existing isolation/SFTP step'leri canonical `websiteId`, `applicationId`, Unix identity ve managed path contract'ına göre doğrulanmalı.
- Duplicate, stale veya identity/path uyuşmazlığı fail-closed olmalı; sessizce "complete" kabul edilmemeli.
- Eksik step'ler idempotent eklenmeli; doğru existing step ikinci kez üretilmemeli.
- Regression testleri doğru existing plan, stale SFTP identity, duplicate step ve alias/shared-site senaryolarını kapsamalı.

## Kabul sınırı

Bu source-level düzeltmeler Website OS isolation kapısını tek başına tamamlamaz. Gerçek Ubuntu hostta ayrı UID/GID, çapraz home/release/log erişim reddi, SFTP chroot/escape ve restart/reconcile davranışı `todo.md` kabul maddeleri geçmeden P0.1 tamamlandı sayılmaz.

GitHub Actions kullanılmaz; source testleri küçük commitlerle ilerletilir.