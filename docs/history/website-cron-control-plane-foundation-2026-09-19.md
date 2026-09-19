# Website cron control-plane foundation — 2026-09-19

Bu kayıt, Domain/Website delete impact graph'ındaki sahte `crons=[]` shortcut'ına düşmeden gerçek site-user cron ürününün ilk source temelini özetler.

## Kaynakta tamamlananlar

- Yeni durable `WebsiteCronRegistry` Website-scoped task metadata'sını root-private control-plane store'da tutar.
- Her task exact Website `serverId + applicationId + unixUser` kimliğine pinlenir. Yalnız managed Unix identity taşıyan hosted `static/node/php` Website'lerde task oluşturulabilir; proxy/docker gibi site-user kimliği olmayan runtime'lar fail-closed kalır.
- Registry create/get/list/update/delete sözleşmesi, optimistic revision, deterministic Website/server scope filtreleri ve Website execution-identity drift fence'i taşır.
- Numeric 5-field cron expression ve bounded printable command validation'ı `@yunpanel/config-templates` içindeki tek ortak contract'a taşındı.
- Managed `/etc/cron.d` renderer:
  - deterministic UUID tabanlı filename,
  - exact managed `yunapp-*` user,
  - bounded environment,
  - enable/disable,
  - cron'un özel `%` davranışı için güvenli escaping
  üretir.
- Yeni `WebsiteCronManager` host primitive'i deterministic `/etc/cron.d/yunpanel-<uuid>.cron` state'ini inspect/apply/remove eder.
- Host manager yalnız root:root `0644` regular file ve YunPanel ownership marker'ını kabul eder; foreign/symlink/ownership drift'i overwrite etmez.
- Apply atomik temp-file + rename kullanır; cron service active evidence'ı yoksa yeni/değişmiş dosyayı önceki exact managed state'e rollback eder.
- Remove exact expected desired digest ile fencedir; drifted managed file destructive remove açmaz.
- Production bootstrap `YUNPANEL_WEBSITE_CRON_STORE` / `website-cron-registry.json` registry store'unu initialize eder.
- Sonraki source diliminde host manager `listManagedFiles()` salt okunur `/etc/cron.d` envanteri ekledi: yalnız canonical task UUID, dosya adı, SHA-256 ve `cron.service` durumunu döndürür. YunPanel prefix'li malformed/temp, symlink, foreign marker veya UID/GID/mode drift'inde fail-closed kalır; dosya içeriğini ve komutu response'a koymaz.
- Registry/template/host-manager source tests yazıldı.

## Bilinçli olarak henüz açılmayanlar

Bu dilim cron ürününü tamamlamaz ve Domain delete güvenliğini gevşetmez:

- Public cron CRUD endpoint'i henüz yok.
- Registry task'ını host apply/remove mutation'ına bağlayan durable job/operation lifecycle henüz yok.
- Cron output/status/history inspection henüz yok.
- Registry ile canlı `/etc/cron.d` envanterini ve durable apply receipt'ini birlikte authoritative sayan reconciliation provider henüz yok. Host envanteri tek başına başarılı apply kanıtı değildir.
- Bu nedenle resource-impact `crons` bucket'ı **bilinçli olarak unavailable kalır** ve public full Domain delete apply açılmaz.

## İlgili commitler

- `7c00dd9`, `3d1ba4a` — Website cron registry ve testleri.
- `b04f31e`, `b99c761`, `5a52380`, `5089c3d` — shared cron config contract/renderer ve registry refactor/testleri.
- `60f391c`, `b95269c`, `f4c7cca` — host cron manager, export ve testleri.
- `f0c4678` — production cron registry bootstrap.
- `6e89d212` — read-only managed cron file inventory ve fail-closed prefix/ownership testleri.

## Açık doğrulama

Sonraki yerel doğrulamada Node v24.21.0 ile `npm run check` 3929 testi ve lint/build kapısını geçti; üç cron foundation test dosyası bu toplamın içindedir. İlgili kaynak dosyaları `node --check` ile doğrulandı. Gerçek Ubuntu `cron`/`/etc/cron.d` ownership/service davranışı `todo.md` T-CRON altında açıktır.
