# Domain removal child Domain progress — 2026-09-19

Bu checkpoint P0.9 Domain removal parent journal'ının descendant Domain zincirini durable child removal operation'larıyla deepest-first ilerleten kaynak dilimini kaydeder. Public Domain delete apply route'u açılmamıştır; certificate, mail, external-DNS ve child local-authoritative-DNS lifecycle'ları tamamlanmış sayılmaz.

## Exact child intent

- Resource-impact descendant Domain referansları artık desired/staged/applied revision, applied hostname, staged checksum ve suspension ownership alanlarını taşır.
- Parent removal plan her descendant için exact `id`, `serverId`, hostname, Website/certificate binding, parent, active/suspended state, desired revision, checksum ve suspension operation kimliğini pinler.
- Unstable revision, stale suspension evidence, cross-server child, duplicate, cycle veya root'tan kopuk hierarchy mutation başlamadan reddedilir.
- Deepest-first child ID sırası ile snapshot sırası journal'da birlikte doğrulanır. Eski journal child snapshot uydurmadan `childDomains=null` olarak fail-closed yüklenebilir; bu legacy planla yeni operation yaratılamaz.

## Parent-owned child operation

- Domain removal operation şeması geriye uyumlu `parentOperationId` ownership alanı taşır. Yeni child operation yalnız var olan ve aktif parent operation altında yaratılır; aynı Domain için eşzamanlı ikinci removal operation reddedilir.
- Parent `child_domain` step'i current leaf child preview'ını exact pinned identity ile karşılaştırır. Child dependency ID'leri parent'ın mutation öncesi pinlediği aggregate inventory dışına çıkamaz; active job, yeni descendant ve local authoritative zone mutation öncesi bloklanır. `not_applicable`/zone'suz authoritative state kabul edilir.
- Explicit parent continuation başına yalnız bir child lifecycle adımı ilerler: routing suspension, Website binding detach veya metadata finalization. Child içindeki certificate/mail/external-DNS step'leri gerçek handler gelmeden başarılı sayılmaz.
- Parent step yalnız exact parent-owned child operation `removed` olduğunda, bütün child step'leri succeeded ve final metadata evidence child Domain kimliğiyle eşleştiğinde kapanır.

## Recovery

- Startup running parent step için yalnız child operation inventory'sini okur. Exact removed child varsa parent evidence ikinci mutation olmadan tamamlanır.
- Child yoksa veya incomplete ise startup yeni preview, Nginx mutation, detach ya da metadata delete çalıştırmaz; parent `blocked` kalır ve yeni typed continuation ister.
- Parent'tan önce yaratılmış, foreign-owned, ambiguous veya intent'i drift etmiş child operation completion evidence sayılmaz.

## Doğrulama

- Node 24.21 ile resource-impact, Domain removal plan/registry/runtime, Domain suspension ve DNS retirement paketinde **93 test geçti, 0 test başarısız**.
- Tam repository `npm run check` kapısı Node 24.21 ile geçti: repository policy/lint, bütün workspace testleri ve web production build başarılıdır.
- İlk yanlış-runtime denemesi shell varsayılanı Node 22.12 olduğu için `node:crypto.argon2` ve `node:sqlite` importlarında çevre kaynaklı başarısız oldu; proje `engines.node >=24.11.1` kontratına uygun Node 24.21 ile tekrar çalıştırıldığında kapı temiz geçti.
- Bu turda hiçbir sunucuya bağlanılmadı; `.44` production sunucusuna dokunulmadı.

## Kalan P0.9 işi

1. Child Domain'e ait authoritative DNS snapshot/ownership/retention intent'ini parent planında child-specific olarak pinle ve aynı private DNS retirement runtime'ına aktar.
2. Certificate material/registry retirement, local mail + shared webmail mapping ve external DNS lifecycle handler'larını durable operation evidence ile bağla.
3. Eksik Unix/runtime/DB/SFTP/log/backup impact provider'larını tamamlamadan public delete apply yüzeyi açma.
