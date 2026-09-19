# Domain removal certificate retirement progress — 2026-09-19

Bu checkpoint P0.9 Domain removal parent/child journal'ındaki `certificate` step'ini exact registry ve Domain binding lifecycle'ına bağlayan kaynak dilimini kaydeder. Public Domain delete apply yüzeyi açılmamıştır; certificate materyali fiziksel olarak silinmemiştir.

## Pinned certificate intent

- Resource impact artık affected Domain kümesindeki non-retired certificate kayıtları için exact certificate, Domain, Server, state, source, renewal mode, staging, validity ve update evidence'ı üretir.
- Removal plan root ve descendant certificate intent'lerini deterministic sırayla pinler. Bound certificate exact Domain ile eşleşmezse, foreign Server/Domain evidence gelirse veya lifecycle drift ederse journal yaratılmadan fail-closed olur.
- Parent journal yalnız root Domain certificate step'lerini yürütür. Descendant certificate intent'i parent planında kalır fakat exact subset olarak ilgili parent-owned child removal operation'a aktarılır; aynı certificate iki journal tarafından temizlenmez.
- Önceki persisted plan shape'i okunabilir kalır fakat eksik certificate intent evidence'ı `null` hydrate edilir ve yeni mutation için güvenli varsayım üretilmez.

## Operation-owned retirement

- Exact suspended Domain ve suspension operation evidence doğrulanmadan certificate binding veya registry değişmez.
- Bound certificate önce revision/checksum/suspension fence'li Domain primitive'iyle ayrılır; ardından registry kaydı journal operation ID'si, original state ve original update timestamp'iyle immutable `retired` state'e geçirilir.
- Registry store v4 retirement owner, time, previous state ve previous update evidence'ını root-private durable state'te korur. Aynı exact operation retry'si idempotenttir; foreign owner veya drift 409 ile fail-closed olur.
- Retired certificate `setState`, issue/renew reconciliation veya error transition ile yeniden aktif lifecycle'a sokulamaz. Renewal sweep yalnız `active` automatic kayıtları gördüğü için retired kayıt için yeni job üretmez.
- Resource impact retired kayıtları yeni dependency graph'ına eklemez. Registry kaydı audit/recovery için kalır; ACME/custom material `materialRetained=true` evidence ile korunur ve ayrı ownership-aware retention/GC işi bekler.

## Restart ve descendant davranışı

- Startup certificate mutation'ını otomatik replay etmez. Certificate hâlâ aktifse step `blocked` olur ve exact typed continuation ister.
- Binding zaten ayrılmış ve registry kaydı aynı operation'a ait exact retirement evidence'ı taşıyorsa step ikinci mutation olmadan `succeeded` kapanır.
- Binding, certificate update timestamp'i, validity, source/renewal policy veya retirement owner drift'i completion sayılmaz.
- Descendant certificate child journal'da routing suspension sonrasında retire edilir; child metadata finalization ve parent child-step completion yalnız bu exact certificate evidence tamamlandıktan sonra ilerler.

## Kaynak doğrulama

- Node 24.21 ile certificate registry/renewal, resource-impact ve Domain removal plan/registry/runtime hedef kümesinde **72 test geçti, 0 test başarısız**.
- `@yunpanel/api` test paketinin tamamında **2.527 test geçti, 0 test başarısız**.
- Tam repository `npm run check` kapısı Node 24.21 ile geçti: repository policy/lint, bütün workspace testleri ve web production build başarılıdır.
- Bu turda hiçbir sunucuya bağlanılmadı; `.44` production sunucusuna dokunulmadı.

## Kalan P0.9 işi

1. Local mail + shared webmail mapping cleanup ve external DNS lifecycle handler'larını durable child evidence ile bağla.
2. Retired ACME/custom certificate materyali için shared ownership'i koruyan retention/GC lifecycle'ını tanımla.
3. Eksik Unix/runtime/DB/SFTP/log/backup impact provider'larını tamamlamadan public delete apply yüzeyi açma.
