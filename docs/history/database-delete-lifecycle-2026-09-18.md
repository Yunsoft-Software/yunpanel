# Website database delete lifecycle progress — 2026-09-18

Bu kayıt P0.5 Website database silme lifecycle'ının güncel main branch kaynak durumunu özetler. Bu çalışma gerçek Ubuntu/MariaDB acceptance değildir; todo.md içindeki gerçek host, process-kill, restart ve rollback kapıları geçmeden database delete production-ready sayılmaz.

## Tamamlanan lifecycle

Website'e bağlı bir schema artık global DELETE /databases/:name akışıyla silinmez. Canonical Website delete yüzeyi:

- GET /api/servers/:serverId/websites/:websiteId/database-bindings/:bindingId/delete-preview
- POST /api/servers/:serverId/websites/:websiteId/database-bindings/:bindingId/delete
- POST /api/servers/:serverId/websites/:websiteId/database-bindings/:bindingId/delete-finalize

Lifecycle sırası:

1. Managed database credential daha önce durable credential-delete akışıyla kaldırılmış olmalıdır.
2. Current Website database binding revizyonuna ait başarılı scoped vendor dump backup evidence bulunmalıdır.
3. Delete preview canlı schema, credential, backup, active database job ve exact binding ownership state'ini doğrular.
4. Typed confirmation + preview digest + backup id/checksum + binding revision fence'i geçmeden DROP job açılmaz.
5. DROP job payload'ı name + websiteId + databaseBindingId + expectedBindingRevision + backupId + expectedBackupSha256 ownership evidence'ını durable job context'ine taşır.
6. Website binding metadata DROP sırasında korunur. Host mutation başarısız veya belirsiz kalırsa ownership kanıtı kaybedilmez.
7. Binding yalnız exact successful scoped database.delete job, credential yokluğu ve canlı schema yokluğu doğrulandıktan sonra finalize/unbind edilir.

## Backup ve ownership fence

Delete için herhangi bir eski database backup yeterli değildir.

- Backup job aynı local Server'a ait olmalıdır.
- resourceType=database ve resourceId=databaseName exact eşleşmelidir.
- Backup payload'ındaki websiteId, databaseBindingId ve expectedBindingRevision current binding ile bire bir eşleşmelidir.
- Backup result backup identity, database adı, engine/version, SHA-256, byte count ve successful side-effect evidence taşımalıdır.
- Unscoped legacy backup veya önceki binding revision delete eligibility sağlamaz.
- Cross-Website backup delete fence'i olarak kullanılamaz.

## Delete protocol ve receipt evidence

database.delete protocol backward-compatible kalır:

- unbound/admin database için legacy { name } payload geçerlidir,
- Website scope kullanılıyorsa ownership/backup alanları all-or-none zorunludur,
- partial scope, invalid UUID/revision, invalid backup id/SHA veya private extra alanlar reddedilir.

Database deletion receipt artık optional scoped ownership evidence taşır:

- websiteId
- databaseBindingId
- expectedBindingRevision
- backupId
- expectedBackupSha256

Legacy receipt'ler ownership=null olarak desteklenmeye devam eder.

Configured local runtime, delete receipt yazmadan önce job'ın resourceType=database ve resourceId === payload.name kimliğini de doğrular.

## Restart recovery

Mevcut running-job database delete recovery, scoped delete için receipt ownership evidence'ını private durable job context'iyle bire bir karşılaştırır.

- exact scoped receipt + exact private context kabul edilir,
- receipt ownership kaybı fail-closed kalır,
- binding revision/backup identity/checksum drift'i recovery'yi kapatır,
- legacy unscoped delete recovery backward-compatible kalır,
- receipt olmadan yalnız schema'nın yok olması successful recovery kanıtı sayılmaz.

Bu sınır, process host mutation sonrasında fakat receipt yazılmadan ölürse kör başarı veya duplicate mutation üretmemek için bilerek fail-closed tutulur.

## Binding finalization ve retry

Binding DROP'tan önce silinmez.

Successful scoped delete job tamamlandıktan sonra:

- canlı inventory schema'nın yokluğunu tekrar doğrular,
- credential'ın hâlâ absent olduğunu doğrular,
- delete job payload/result exact Server/Website/binding/revision/schema ownership'ine bağlanır,
- ardından binding registry'den unbind edilir.

Finalization idempotent'tir:

- ilk finalize binding'i kaldırır ve alreadyFinalized=false döndürür,
- binding persist edildikten sonra HTTP response kaybolursa aynı successful delete job ile tekrar finalize edilebilir,
- ikinci finalize alreadyFinalized=true döndürür,
- ikinci unbind veya ikinci DROP yapılmaz.

## Reload sonrası continuation

Successful DROP tamamlanmış fakat binding finalize edilmemiş durumda panel yeniden açılırsa delete preview:

- schema'nın absent olduğunu,
- current binding'e ait exact successful scoped delete job'ı,
- delete job'ın backup id/SHA evidence'ını

birlikte doğrular ve readyToFinalize=true döndürür.

Panel bu durumda:

- “DROP tamamlandı, binding finalization bekliyor” durumunu gösterir,
- successful delete job id'sini reuse eder,
- yeni DROP kuyruğa almaz,
- typed confirmation ile yalnız binding finalization'ı devam ettirir.

Stale veya başka binding revision'ına ait successful delete job continuation evidence sayılmaz.

## Web UI

Website Bağlı Kaynaklar ekranında silme akışı:

- önce safe preview,
- blocker varsa yalnız teşhis,
- ready-to-delete ise “Silme onayına geç”,
- schema adı typed confirmation,
- durable DROP job observation/wait,
- evidence-gated binding finalize,
- successful DROP sonrası finalization hata verirse aynı job tutulur ve “Binding finalization’ı tamamla” ile retry edilir,
- reload sonrası backend continuation evidence'ı üzerinden aynı finalization yolu açılır.

Browser prompt/confirm/alert kullanılmaz.

## Source kontratları ve bu turdaki doğrulamalar

Kaynak testleri eklendi/güncellendi:

- scoped delete protocol
- scoped deletion receipt + legacy compatibility
- configured local receipt resource identity
- running delete recovery ownership drift
- Website delete HTTP preview/apply/finalize
- idempotent finalization
- reload sonrası readyToFinalize
- Website delete API client
- frontend delete preview model
- Website UI lifecycle/recovery wiring
- production app route wiring

Bu çalışma turunda GitHub Actions kullanılmadı.

Container'ın GitHub checkout erişimi olmadığı için full repository test suite koşturulduğu iddia edilmez. Bunun yerine güncel main source'u connector üzerinden tekrar okunarak:

- ilgili source/test dosyaları V8 parser kapısından geçirildi,
- delete protocol validator doğrudan çalıştırıldı,
- Website delete route fake registry/job/inventory adapter'larıyla çalıştırıldı,
- preview -> 202 scoped queue -> schema absence -> finalize akışı doğrulandı,
- aynı finalize iki kez çalıştırılarak yalnız tek unbind yapıldığı ve ikinci çağrının alreadyFinalized=true döndüğü doğrulandı,
- delete recovery receipt matching helper'ı legacy/exact/drift senaryolarıyla çalıştırıldı,
- frontend client request body'lerinin caller-selected schema/password/SQL/dump path taşımadığı doğrulandı,
- frontend delete modelinde exact finalization recovery kabul, drift/inconsistent state reject davranışı çalıştırıldı,
- panel kaynakta old global drop çağrısının kalmadığı ve reload continuation'ın successful job'ı reuse ettiği kontrol edildi.

## Gerçek ortam acceptance

todo.md T-DATABASE altında gerçek Ubuntu 24.04 + MariaDB/MySQL üzerinde özellikle şu kapılar geçmelidir:

- current binding-revision backup olmadan DROP oluşmaması,
- credential varken DROP oluşmaması,
- stale/cross-site backup ve delete evidence reddi,
- process kill: host DROP öncesi, DROP sonrası/receipt öncesi, receipt sonrası/job-completion öncesi,
- receipt-backed recovery'nin ikinci DROP göndermemesi,
- successful DROP sonrası API kill ve panel reload'da readyToFinalize continuation,
- binding persist sonrası response kaybında idempotent finalize,
- package/API restart sonrası job + receipt + binding evidence persistence,
- backup artifact'ın gerçek restore kabiliyeti ve checksum doğrulaması.

## Kaldığımız exact nokta

P0.5 için kalan işler kaynak kod değil, gerçek-host acceptance kapılarıdır ve todo.md içindedir.

Normal geliştirme sırasındaki bir sonraki ürün/kod alanı P0.6 elFinder + homegrown File Manager removal'dır.
