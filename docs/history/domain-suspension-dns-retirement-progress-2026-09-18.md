# Domain suspension + DNS retirement progress — 2026-09-18

Bu checkpoint P0.9 suspend/delete çalışmasının kaynak kod durumunu kaydeder. Gerçek Ubuntu/PowerDNS/browser failure-injection kabulü bu belgede tamamlanmış sayılmaz; kabul kapıları `todo.md` içindedir.

## Domain-level suspend/resume

Domain public web trafiği için ayrı, operation-owned suspend/resume lifecycle kaynakta vardır.

- Nginx deactivation activation-compensation receipt'ini yeniden kullanmaz. Exact active config checksum'ına bağlı ayrı root-private deactivation receipt'i yazar.
- Active vhost checksum drift etmişse suspend başlamaz. Dosya zaten yoksa ve operation receipt'i yoksa YunPanel bu yokluğu sahiplenmez.
- Deactivation Nginx config'i kaldırır, `nginx -t` ve reload çalıştırır; failure'da exact active bytes geri konur ve reload tekrar doğrulanır.
- Resume yalnız aynı deactivation receipt'inden exact vhost'u geri getirir; foreign config üstüne yazılmaz.
- Domain registry v4 explicit `suspended` state, current suspension operation ID/checksum/timestamp ve last-resumed ownership metadata'sını tutar. Suspend desired/applied revision'ı değiştirmez.
- Suspended Domain normal update/stage/activate/certificate/generic-failure yollarından değiştirilemez; resume yalnız aynı durable suspension operation'ı ile yapılır.
- Durable operation state'i `pending -> suspending -> suspended -> resuming -> resumed` zincirini ve ayrı suspend/resume failure state'lerini tutar.
- API startup `suspending` / `resuming` operation'larda host mutation replay etmez. Host postcondition zaten oluşmuşsa yalnız control-plane state reconcile edilir; mutation gerekiyorsa explicit typed retry beklenir.
- Nginx mutation başarılı olup Domain state commit'i başarısız olursa source runtime exact host compensation dener. Resume'da bunun tersi uygulanır.
- HTTP yüzeyinde suspend preview/apply, operation list/detail, suspend retry, resume ve resume retry route'ları strict body/query contract ile mount edilir; Read Only mutation yüzeyine giremez.
- Bu lifecycle yalnız Domain route/public web erişimini suspend eder. Website process/runtime'ının tamamını durdurmuş sayılmaz; Website-wide suspend P0.9 içinde açık iştir.

## Authoritative DNS retirement

Local PowerDNS zone silme authority'si standalone public destructive endpoint olarak açılmadan önce reverse-dependency-safe parçalar kaynakta tamamlandı.

- Domain delete impact graph authoritative DNS retirement digest/blocker'larını first-class dependency olarak taşır; live zone state değişirse üst delete preview digest'i de değişir.
- Public retirement impact exact zone snapshot digest, kind, DNSSEC ve managed/manual RRset sayıları gösterir fakat record content açmaz.
- YunPanel RRset comments'ını whole-zone ownership kabul etmez. Operation-created zone origin'i durable Website provisioning history'deki exact server/webDomain/zone `dns_zone` step + `created=true` evidence'ından çözülür.
- Ownership lookup Website'in current binding'inden bağımsızdır; Domain finalization öncesi/sonrası historical operation evidence kaybolmaz.
- Manual RRset, DNSSEC, local mail-domain dependency, active Domain job, child Domain, certificate, active routing ve ownership belirsizliği açık blocker'dır.
- Snapshot retention policy default uydurmaz. `YUNPANEL_DNS_ZONE_SNAPSHOT_RETENTION_DAYS` yalnız 1..3650 arası explicit verilirse retirement confirmation açılır.
- Private snapshot capture public preview/confirmation'ı tekrar doğrular, live zone digest ve Domain revision'ı re-check eder ve full snapshot'ı yalnız private durable operation store'a verir.
- Host-runtime exact snapshot delete canlı zone'u retained snapshot ile birebir eşleştirir; drift'te PowerDNS DELETE göndermez, DNSSEC açık snapshot'ı reddeder, zone zaten yoksa retry idempotent başarıdır.
- Durable retirement journal full snapshot/confirmation'ı public response'tan gizler; root-private store, monoton revision ve retained snapshot deadline evidence'ı tutar.
- Retirement runtime provider DELETE lost-ack sonrasında absent postcondition'ı görürse ikinci DELETE atmadan kapanır. Startup `deleting` state'te yalnız inspect yapar; zone hâlâ exact snapshot ise explicit retry ister.
- Durable retirement operations read-only list/detail endpoint'lerinde görülebilir. Standalone public start/retry mutation route'u özellikle mount edilmemiştir; destructive invocation Domain/Website reverse-dependency delete orchestrator'ına bırakılmıştır.

## Test durumu

Bu checkpoint'te ilgili source test dosyaları ve failure-injection contract'ları repository'ye küçük commitlerle eklendi. Bu ortamda repository checkout + Node workspace test suite'i çalıştırılmadı; bu nedenle yeni testler için pass sayısı iddia edilmez.

## Kalan P0.9 işi

1. Domain delete durable orchestrator: mevcut resource-impact preview'ı operation intent'ine pinle.
2. Reverse-order dependency cleanup/finalize adımları: routing suspend/deactivate, certificate/mail/webmail/external DNS, authoritative DNS retirement, Domain metadata finalization.
3. Website delete: bağlı Domain delete operation'larını child operation/evidence olarak bitirip sonra runtime/Unix/files/database/SFTP/log/backup cleanup'a ilerle.
4. Website-wide suspend: bütün bağlı Domain route'ları + seçilen runtime/process access lifecycle.
5. Gerçek Ubuntu/Nginx/PowerDNS process-kill, reload, restart, browser ve provider kabulü.
