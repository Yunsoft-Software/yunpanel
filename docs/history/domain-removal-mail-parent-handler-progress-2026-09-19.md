# Domain removal Mail Domain parent handler progress — 2026-09-19

Bu checkpoint P0.9 Domain removal parent journal'ındaki `mail_domain` step'inin durable child lifecycle sözleşmesini kaydeder. Gerçek Mail Domain child runtime bu dilimde uygulanmadı veya production bootstrap'a bağlanmadı; dependency yokken parent step fail-closed kalır.

## Parent-owned child sınırı

- `mail_domain` artık typed parent continuation ile ilerletilebilen bir journal step'idir.
- Parent yalnız journal'daki exact id, web-Domain, canonical name, management mode, status, revision ve update timestamp'iyle eşleşen child preview'ı kabul eder.
- Child operation parent operation kimliğini, kaynak intent'i, removal yöntemini, preview digest'ini ve parent'tan sonra yaratıldığını kanıtlamak zorundadır. Aynı parent'a ait duplicate veya drifted child state mutation başlamadan bloklanır.
- Parent startup yalnız child inventory'sini inspect eder. Exact `removed` child evidence varsa step'i kapatır; incomplete child'ı otomatik retry etmez ve typed explicit continuation bırakır.

## Local ve external kanıt ayrımı

- Local Mail Domain yalnız `local_verified_data_finalize` sonucu ile tamamlanabilir.
- Kaynak status `enabled` ise exact disable/config job kimliği ve `revision + 1` final revision gerekir; başlangıç zaten `disabled` ise disable job kabul edilmez ve revision değişmemelidir.
- Her local sonuç verified mail-data delete job kimliği, backup kimliği, bounded cleanup evidence digest'i ve canonical deletion timestamp'i taşımak zorundadır.
- External Mail Domain yalnız `external_metadata_unlink` sonucu ile tamamlanabilir. Local config/data-delete/backup job evidence'ı external sonuçta özellikle reddedilir; provider-side veri veya DNS silinmiş varsayılmaz.
- Child sonucu bu exact kanıtları taşımıyorsa parent step başarılı sayılmaz.

## Kaynak doğrulama

- Domain removal runtime hedef paketinde **35 test geçti, 0 test başarısız**.
- Node 24.21 ile `@yunpanel/api` test paketinin tamamında **2.536 test geçti, 0 test başarısız**.
- Repository policy/lint doğrulaması geçti.
- Bu turda hiçbir sunucuya bağlanılmadı; `.44` production sunucusuna dokunulmadı.

## Sonraki kaynak dilimi

1. Exact preview/operation/retry sözleşmesini uygulayan root-private durable Mail Domain child registry/runtime ekle.
2. Local child lifecycle'ı mevcut mail config apply, mailbox/alias/DKIM/webmail cleanup, backup-bound mail-data delete ve finalize servislerine bağla.
3. Config/data job restart state'ini yalnız receipt + terminal job + live post-condition ile reconcile et; mutation'ı startup'ta replay etme.
4. External metadata unlink için provider-side ownership sınırını açık tut ve local destructive akışı çalıştırma.
