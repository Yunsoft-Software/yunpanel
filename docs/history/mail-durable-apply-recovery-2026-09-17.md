# Mail durable apply / recovery ilerlemesi — 2026-09-17

Bu kayıt P0.4 managed mail configuration lifecycle'ında kaynakta tamamlanan apply/recovery zincirini özetler. Gerçek Postfix, Dovecot, Rspamd ve Roundcube kabulü `todo.md` içindeki T-MAIL kapıları geçmeden production-accepted sayılmaz.

## Tamamlanan kaynak davranışı

- `MAIL_CONFIG_APPLY` control-plane desired-state geçişinden durable job olarak kuyruğa alınır; payload secret veya raw generated configuration taşımaz.
- Production local runtime job'u resource lock ve process-wide local execution lock altında claim eder. Protected mail materialization yalnız host operation sınırında açılır.
- Host operation sırası stage → pre-apply backup → activation şeklindedir. Backup exact queued configuration digest'ini ve staged plan digest'ini doğrulamadan service/config mutation başlamaz.
- Backup manager Postfix/Dovecot/Rspamd source ve compiled artifacts, `main.cf`, `master.cf` ve managed directory state'ini operation/job kimliği altında root-private saklar. Public sonucu dosya içerikleri yerine bounded digest evidence taşır.
- Backup manifest'in normalized tam içeriğinden deterministik SHA-256 üretilir. Apply result schema v3 bu `backupSha256` değerini configuration, plan ve readiness digest'lerinin yanında materialize edilen previous mail-domain revision/status ile birlikte taşır.
- Job registry v3 sonucunu exact queued mail domain/status/revision/preview/configuration ile doğrular. Eski running job/recovery kayıtları için v1 ve v2 sonucu okunabilir kalır; eski sürümlere sonradan previous control-plane identity yakıştırılmaz.
- Başarılı apply sonrası root-private operation receipt v3 aynı backup ve previous transition evidence'ını kaydeder. Store v1/v2 receipt'leri exact eski şemalarıyla okuyabilir; yeni yazımlar yalnız v3'tür.
- Process host mutation'dan sonra fakat job completion acknowledgment'ından önce kesildiyse packaged startup recovery mutation'ı tekrar etmez. Exact receipt, current protected desired-state materialization ve active host evidence aynı configuration/plan/readiness zincirini kanıtlarsa job tamamlanır; eksik veya farklı evidence fail-closed kalır.
- Packaged recovery context reader güncel durable job registry ile aynı `mail_domain`, `dns_zone` ve `docker_project` resource scope'larını kabul eder. Böylece gerçek mail recovery, test double dışında private queued payload okunurken eski resource allowlist'ine takılmaz.
- Recovery v3 receipt'teki backup ve previous control-plane identity'yi bounded job result'ına taşır. Legacy v1/v2 recovery çalışmayı sürdürür fakat eksik evidence uydurmaz; bu kayıtlar full control-plane explicit rollback için uygun değildir.
- Authenticated rollback preview source apply job ID'sini exact local mail domain ve server scope'unda çözer. Yalnız başarılı v3 evidence, exact current status/revision ve sunucu çapındaki en son başarılı `MAIL_CONFIG_APPLY` kabul edilir; başka bir mail domain apply'ı dahi eski global Postfix/Dovecot snapshot'ını supersede eder.
- Preview backup/current configuration/plan digest'leri, source apply kimliği, previous status/revision provenance'ı, expected current revision ve monoton resulting revision üzerinden deterministik digest + typed confirmation üretir. Secret, backup path'i veya artifact içeriği public cevaba girmez.

## Regression kapsamı

- Backup manifest digest'inin first apply, inspect ve idempotent retry boyunca sabit kalması.
- Backup configuration/plan/manifest evidence'ı eksik veya malformed ise activation'ın başlamaması.
- Activation plan digest'inin backup planıyla eşleşmesi ve bounded v2 result üretimi.
- Job registry'nin forged/malformed backup/previous transition evidence'ını reddetmesi ve exact legacy v1/v2 uyumluluğu.
- Receipt v3 write/read, invalid backup/previous state reddi ve strict v1/v2 schema read compatibility.
- Configured local runtime'ın yalnız v3 apply evidence'ıyla receipt yazması.
- Restart recovery'nin v3 backup/previous identity'yi koruması, materialized transition drift'ini host inspection öncesi reddetmesi ve v1/v2 kaydı full rollback-capable göstermemesi.
- Rollback preview'ın v1/v2 evidence, global superseding apply, current control-plane drift, active mail mutation ve cross-server source job'u fail-closed reddetmesi.

İlk backup-binding odak regresyonunda desteklenen Node 24 ile 23/23, v3 previous-state zinciri regresyonunda 31/31 ve rollback preview/audit regresyonunda 18/18 test geçti. Son değişiklikte repository policy, bütün workspace testleri ve production build'ini içeren `npm run check` de başarıyla tamamlandı; build yalnız mevcut büyük chunk uyarısını verdi. Gerçek host acceptance çalıştırılmadı; GitHub Actions kullanılmadı.

## Açık kalan sınır

- `MAIL_CONFIG_ROLLBACK` protocol/enqueue/executor ve typed confirmation doğrulayan durable job henüz yoktur.
- Restore başlamadan canlı active-config state'i exact expected current digest'e bağlanmalı; manual/concurrent drift ezilmemelidir.
- Rollback restore/validator/reload/readiness sırasında kesilirse restart mixed previous/current state'i yalnız operation-owned evidence ile tamamlamalı veya current state'e güvenli compensation yapmalıdır.
- Başarılı host rollback sonrası mail-domain desired/control-plane revision ve status exact previous state'e reconcile edilmelidir.
- Legacy v1 apply receipt backup identity, v2 receipt previous control-plane identity taşımadığından full explicit rollback unavailable kalmalıdır.
