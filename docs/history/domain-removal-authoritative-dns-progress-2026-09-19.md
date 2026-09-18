# Domain removal authoritative DNS progress — 2026-09-19

Bu checkpoint P0.9 Domain removal parent journal'ının hazır durable authoritative DNS retirement runtime'ına bağlanan private child-operation dilimini kaydeder. Public Domain delete apply veya standalone DNS delete mutation route'u açılmamıştır.

## Pinned DNS intent

- Domain resource-impact reference artık live zone snapshot digest'ine ek olarak provisioning-origin ownership evidence digest'ini ve explicit snapshot retention gününü taşır.
- Parent removal preview/journal bu üç alanı operation intent'ine pinler. Ownership veya retention kanıtı olmayan yeni bir local-zone planı destructive start'a açılamaz.
- Eski journal shape'i okunabilir kalır fakat eksik ownership/retention alanları `null` olarak hydrate edilir; sistem geçmiş state için kanıt uydurmaz ve authoritative step fail-closed kalır.
- Policy, ownership veya live zone snapshot değişirse parent child mutation başlatmadan DNS preview drift'i üretir.

## Suspended routing semantiği

- Domain suspension desired/staged/applied revision'ları kasıtlı olarak koruduğu için DNS retirement routing kontrolü artık yalnız exact suspended revision/checksum/suspension-operation evidence varsa route'u inactive kabul eder.
- Yalnız `state=suspended` etiketi yeterli değildir. Checksum, revision, hostname, operation ID veya error state uyuşmazsa retirement preview `domain_routing_active` blocker'ını korur.

## Parent → child lifecycle

- Parent `authoritative_dns` step'i mutation'dan önce durable `running` checkpoint yazar.
- Yeni child gerektiğinde current DNS retirement preview exact pinned snapshot/ownership/retention intent'ine karşı doğrulanır; mevcut durable runtime `start` çağrısıyla private snapshot journal ve PowerDNS delete lifecycle'ı yeniden kullanılır.
- Matching child `deleting` veya `failed` ise explicit parent continuation child'ın kendi `updatedAt + snapshotDigest + retryConfirmation` fence'ini kullanır. Yeni ve paralel bir delete operation üretilmez.
- Parent success evidence child operation ID, exact zone/domain kimliği, snapshot/ownership/retention ve retained snapshot deadline'ından türetilir.
- Parent yalnız kendi journal `createdAt` zamanından sonra oluşturulmuş matching child evidence'ını kabul eder. Daha eski bir `deleted` operation aynı-byte zone sonradan yeniden oluşturulduğunda sahiplik kanıtı sayılmaz; retirement registry yeni private operation üretir.
- Startup yalnız child inventory inspect eder. Exact child `deleted` ise ikinci DELETE atmadan parent step kapanır; pending/deleting/failed/yok durumunda mutation replay edilmez ve parent `blocked` + typed continuation bırakır.

## Sınırlar

- External DNS zone kayıtları authoritative local PowerDNS lifecycle'ıyla birleştirilmedi; ayrı parent step olarak kalır.
- DNSSEC açık zone hâlâ parent DS retirement/propagation lifecycle'ı olmadan silinmez.
- Child Domain, certificate, webmail/mail ve external DNS step handler'ları hâlâ açıktır; bu nedenle full public Domain delete apply yüzeyi açılmadı.

## Kaynak doğrulama

Node 24 ile resource-impact, Domain removal plan/registry/runtime, Domain suspension ve DNS retirement source paketinde **92 test geçti, 0 test başarısız**. Tam repository `npm run check` kapısı da bu checkpoint turunda ayrıca çalıştırılır.

Gerçek host kabulü değildir. `.44` production sunucusuna veya başka bir sunucuya bağlantı kurulmadı.
