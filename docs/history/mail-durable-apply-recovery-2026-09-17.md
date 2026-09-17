# Mail durable apply / recovery ilerlemesi — 2026-09-17

Bu kayıt P0.4 managed mail configuration lifecycle'ında kaynakta tamamlanan apply/recovery zincirini özetler. Gerçek Postfix, Dovecot, Rspamd ve Roundcube kabulü `todo.md` içindeki T-MAIL kapıları geçmeden production-accepted sayılmaz.

## Tamamlanan kaynak davranışı

- `MAIL_CONFIG_APPLY` control-plane desired-state geçişinden durable job olarak kuyruğa alınır; payload secret veya raw generated configuration taşımaz.
- Production local runtime job'u resource lock ve process-wide local execution lock altında claim eder. Protected mail materialization yalnız host operation sınırında açılır.
- Host operation sırası stage → pre-apply backup → activation şeklindedir. Backup exact queued configuration digest'ini ve staged plan digest'ini doğrulamadan service/config mutation başlamaz.
- Backup manager Postfix/Dovecot/Rspamd source ve compiled artifacts, `main.cf`, `master.cf` ve managed directory state'ini operation/job kimliği altında root-private saklar. Public sonucu dosya içerikleri yerine bounded digest evidence taşır.
- Backup manifest'in normalized tam içeriğinden deterministik SHA-256 üretilir. Yeni apply result schema v2 bu `backupSha256` değerini configuration, plan ve readiness digest'leriyle birlikte taşır.
- Job registry v2 sonucunu exact queued mail domain/status/preview/configuration ile doğrular. Eski running job/recovery kayıtları için v1 sonucu okunabilir kalır; v1'e sonradan backup kimliği yakıştırılmaz.
- Başarılı apply sonrası root-private operation receipt v2 aynı `backupSha256` değerini kaydeder. Store v1 receipt'i exact eski şemasıyla okuyabilir; yeni yazımlar yalnız v2'dir.
- Process host mutation'dan sonra fakat job completion acknowledgment'ından önce kesildiyse packaged startup recovery mutation'ı tekrar etmez. Exact receipt, current protected desired-state materialization ve active host evidence aynı configuration/plan/readiness zincirini kanıtlarsa job tamamlanır; eksik veya farklı evidence fail-closed kalır.
- Recovery v2 receipt'teki backup identity'yi bounded job result'ına taşır. Legacy v1 recovery çalışmayı sürdürür ancak `backupSha256` üretmez; bu kayıt gelecekteki explicit rollback için uygun değildir.

## Regression kapsamı

- Backup manifest digest'inin first apply, inspect ve idempotent retry boyunca sabit kalması.
- Backup configuration/plan/manifest evidence'ı eksik veya malformed ise activation'ın başlamaması.
- Activation plan digest'inin backup planıyla eşleşmesi ve bounded v2 result üretimi.
- Job registry'nin forged/malformed backup digest'ini reddetmesi ve exact legacy v1 uyumluluğu.
- Receipt v2 write/read, invalid backup digest reddi ve strict v1 schema read compatibility.
- Configured local runtime'ın yalnız v2 apply evidence'ıyla receipt yazması.
- Restart recovery'nin v2 backup identity'yi koruması, receipt drift'ini mutation öncesi reddetmesi ve v1 kaydı rollback-capable göstermemesi.

Odak regression çalıştırmasında desteklenen Node 24 ile 23/23 test geçti. Repository policy, bütün workspace testleri ve production build'ini içeren `npm run check` de başarıyla tamamlandı; build yalnız mevcut büyük chunk uyarısını verdi. Gerçek host acceptance çalıştırılmadı; GitHub Actions kullanılmadı.

## Açık kalan sınır

- `MAIL_CONFIG_ROLLBACK` için authenticated preview, operation/backup-bound typed confirmation ve ayrı durable job henüz yoktur.
- Restore başlamadan canlı active-config state'i exact expected current digest'e bağlanmalı; manual/concurrent drift ezilmemelidir.
- Rollback restore/validator/reload/readiness sırasında kesilirse restart mixed previous/current state'i yalnız operation-owned evidence ile tamamlamalı veya current state'e güvenli compensation yapmalıdır.
- Başarılı host rollback sonrası mail-domain desired/control-plane revision ve status exact previous state'e reconcile edilmelidir.
- Legacy v1 apply receipt backup identity taşımadığından explicit rollback unavailable kalmalıdır.
