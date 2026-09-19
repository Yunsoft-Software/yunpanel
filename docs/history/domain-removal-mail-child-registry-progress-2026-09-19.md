# Domain removal Mail Domain child registry progress — 2026-09-19

Bu checkpoint P0.9 Mail Domain child removal lifecycle'ının root-private durable operation registry dilimini kaydeder. Registry hazırdır; mevcut mail servislerini çalıştıracak orchestrator/runtime ve production wiring henüz bu dilimde yoktur.

## Durable lifecycle

- Local lifecycle `pending → disabling → cleaning → deleting_data → finalizing → removed` fazlarını kullanır. Başlangıç zaten disabled ise `disabling` atlanır.
- Enabled kaynakta disable/config job kimliği ve exact `sourceRevision + 1`, disabled kaynakta job olmadan aynı revision zorunludur.
- Cleanup evidence digest'i, verified backup kimliği ve mail-data delete job kimliği doğru fazdan önce eklenemez; finalization bunların tamamı olmadan açılamaz.
- External lifecycle yalnız `pending → finalizing → removed` yolunu ve `external_metadata_unlink` yöntemini kabul eder. Config/data-delete/backup kimliği taşıyan external state store validation'da reddedilir.
- Blocked/failed operation hangi exact faza döneceğini ve bounded error'u saklar; yalnız stale-guarded explicit retry error'u temizleyip aynı fazı yeniden açar.

## Persistence ve restart

- Store directory/file izinleri her yazımda `0700/0600` olarak uygulanır.
- Parent operation + Mail Domain intent'i idempotent create edilir; aynı parent'ta drift veya başka parent'ın aktif sahipliği fail-closed olur.
- Ara fazlar restartta tamamlanmış sayılmaz ve `listIncomplete` envanterinde korunur. Public view retry confirmation üretir ancak private typed confirmation ile ara evidence alanlarını dışarı vermez.
- Persisted phase/evidence tutarsızlığı ve sonradan eklenmiş yabancı backup/job state'i startup validation'da reddedilir.

## Kaynak doğrulama

- Yeni child-registry hedef kümesinde **8 test geçti, 0 test başarısız**.
- Node 24.21 ile `@yunpanel/api` paketinin tamamında **2.544 test geçti, 0 test başarısız**.
- Repository policy/lint doğrulaması geçti.
- Bu turda hiçbir sunucuya bağlanılmadı; `.44` production sunucusuna dokunulmadı.

## Sonraki kaynak dilimi

1. Child registry üzerinde preview/start/retry/list ve inspect-only startup reconciliation sunan runtime ekle.
2. Local fazları mevcut mail config apply, dependency cleanup, backup-bound mail-data delete ve finalize servislerine exact job/receipt evidence ile bağla.
3. External finalization'ı provider tarafında silme varsaymadan yalnız explicit metadata unlink ile uygula.
