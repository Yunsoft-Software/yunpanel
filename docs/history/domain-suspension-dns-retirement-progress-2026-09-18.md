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

## Checkpoint sonrası Domain removal temeli

Bu checkpoint'ten sonra delete orchestrator'a doğrudan kullanılacak üç kaynak primitive'i eklendi.

- Domain registry yalnız exact suspended revision/checksum/suspension-operation evidence altında Website binding'ini idempotent detach edebilir. Binding drift'inde fail-closed kalır.
- Certificate binding aynı suspension evidence altında exact certificate ID ile detach edilir; bu işlem certificate resource'unu silmez, yalnız Domain bağını kaldırır.
- Child Domain, Website binding ve certificate binding kalmadığında; exact suspension operation/revision/checksum ve typed confirmation ile Domain metadata finalization yapılabilir. Active/resumed veya drift etmiş Domain finalization'a giremez.
- Local authoritative DNS retirement service/runtime artık API bootstrap'ta tek shared instance olarak initialize edilir ve durable operation store'u control-plane state root altında tutulur. Public standalone destructive start/retry route'u yine açılmamıştır; üst Domain/Website delete orchestrator'ı beklenir.
- Bu primitive'ler reverse-order durable Domain delete operation journal'ı yerine geçmez. Resource-impact digest pinleme, child operation/evidence ve restart recovery hâlâ açık iştir.

## Durable Domain removal parent operation

P0.9 Domain delete orchestrator'ının ilk durable parent katmanı da kaynakta eklendi.

- Side-effect-free removal planner current Domain state'ini resource-impact `previewDigest`/confirmation ile birleştirir; exact Domain revision, staged/applied Nginx checksum, current Website/certificate binding'leri, external DNS/mail dependency kimlikleri, additional dependency inventory ve authoritative DNS retirement digest'ini tek parent preview digest'ine pinler.
- Active Domain job, unavailable dependency inventory veya authoritative DNS tarafındaki manual RRset/DNSSEC/ownership/retention/inventory gibi üst orchestrator tarafından güvenle çözülemeyen blocker'lar parent start'ı fail-closed kapatır.
- Descendant Domain listesi alfabetik cascade değildir. Parent/child topology doğrulanır, disconnected/cyclic inventory reddedilir ve removal plan en derin descendant'tan doğrudan child'a doğru deterministic sıra üretir.
- Parent removal operation root-private durable JSON journal'dır. Step sırası routing suspend → deepest-first child Domains → certificate → mail domain → external DNS → Website binding → authoritative DNS → metadata finalization olarak pinlenir; exact impact/start confirmation public view'a çıkmaz.
- İlk gerçek step `routing_suspend` mevcut `DomainSuspensionRuntime`ı child operation olarak kullanır. Yeni bir Nginx lifecycle yazılmaz.
- Parent restart `running` routing step'inde child suspension operation'larını salt-okunur inceler. Exact child `suspended` evidence varsa parent step kapanır; child incomplete/failed/yoksa parent `blocked` olur ve explicit retry bekler. Startup child `start`/`retrySuspend` çağırmaz.
- Parent explicit routing retry current parent `updatedAt` + checksum + typed confirmation'a bağlıdır. Matching failed/suspending child varsa onun kendi typed retry confirmation'ı kullanılır; yoksa current suspension preview tekrar doğrulanarak child start edilir.
- Zaten suspended Domain için parent exact `suspensionOperationId`'yi reuse eder; foreign/ambiguous suspension operation state fail-closed kalır.
- Certificate, mail-domain ve external-DNS kaynaklarında full destructive lifecycle henüz olmadığı için parent journal bu step'leri başarılı varsaymaz ve public Domain delete apply yüzeyi henüz açılmamıştır.

## Test durumu

Bu checkpoint'te ilgili source test dosyaları ve failure-injection contract'ları repository'ye küçük commitlerle eklendi. Bu ortamda repository checkout + Node workspace test suite'i çalıştırılmadı; bu nedenle yeni testler için pass sayısı iddia edilmez.

## Kalan P0.9 işi

1. Domain delete parent journal'ındaki deepest-first child Domain, certificate/mail/webmail/external DNS, Website detach, authoritative DNS ve metadata finalization handler'larını tamamla.
2. Certificate/mail-domain/external-DNS için operation-owned destructive lifecycle ve inspect-first restart recovery ekle; kaynak gerçekten temizlenmeden parent step'i başarılı sayma.
3. Website delete: bağlı Domain delete operation'larını child operation/evidence olarak bitirip sonra runtime/Unix/files/database/SFTP/log/backup cleanup'a ilerle.
4. Website-wide suspend: bütün bağlı Domain route'ları + seçilen runtime/process access lifecycle.
5. Gerçek Ubuntu/Nginx/PowerDNS process-kill, reload, restart, browser ve provider kabulü.
