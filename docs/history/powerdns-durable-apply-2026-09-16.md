# PowerDNS durable apply / rollback ilerlemesi — 2026-09-16

Bu kayıt P0.2 PowerDNS lifecycle hardening diliminde kaynakta tamamlanan işleri özetler. Gerçek Ubuntu/package/failure-injection kabulü `todo.md` içindeki T-DNS kapıları geçmeden production-accepted sayılmaz.

## Tamamlanan kaynak davranışı

- Managed PowerDNS config apply öncesi mevcut regular-file config içerik + uid/gid/mode snapshot'ı alınır.
- `pdns_server --config=check` candidate config'i reddederse önceki managed config atomik olarak geri yüklenir; fresh install'da önceki dosya yoksa reddedilen candidate temizlenir.
- Config snapshot veya restore kanıtı güvenilir değilse rollback başarılı varsayılmaz ve fail-closed hata bırakılır.
- PowerDNS authoritative apply host-runtime seviyesinde durable operation journal'a alınır; journal raw API key içermez.
- Journal server ID, API-key revision, secondary DNS topology, public-safe bounded error evidence, post-condition package versions ve authoritative receipt zamanını tutar.
- İlk host mutation başlamadan operation `applying` olarak durable yazılır.
- Belirsiz package/service/apply sonucu sonrası operation `applying` kalır; sonraki aynı-intent apply çağrısı host mutation'ı körlemesine replay etmez.
- Interrupted operation için önce underlying host `inspect` çalışır. Hedef zaten sağlanmışsa operation inspect evidence ile `succeeded` kapatılır; hedef kanıtlanamıyorsa `powerdns_recovery_pending` ile mutation bloklanır.
- Farklı intent, unresolved `applying` operation üstüne yazılamaz (`powerdns_operation_conflict`).
- Config validation rollback gibi deterministik ve güvenli failure operation'ı `failed` evidence ile kapatır; belirsiz sonuçlar terminal başarı/başarısızlık diye uydurulmaz.
- `createPowerDnsAuthoritativeReadyManager()` production default-chain'i durable manager üzerinden çalışır.

## Regression kapsamı

Kaynağa aşağıdaki regression testleri eklendi:

- configtest failure sonrası previous config restore;
- first-install rejected candidate cleanup;
- operation journal'ın mutation'dan önce yazılması ve raw API key taşımaması;
- ambiguous apply sonrası ikinci çağrının underlying mutation'ı replay etmemesi;
- interrupted operation hedefi inspect ile sağlanmışsa mutation olmadan success reconciliation;
- config validation rollback'in deterministic failed operation olarak journal edilmesi;
- ready-manager production default'unun durable manager'a bağlı kalması.

Bu çalışma ortamında private repository checkout/test runner bulunmadığı için testler çalıştırılmış gibi işaretlenmedi. GitHub Actions kullanılmadı.

## Açık kalan acceptance / lifecycle sınırı

- Fresh Ubuntu 24.04 üzerinde gerçek `pdns-server` configtest/service/package failure injection yapılmalı.
- Process/API kesintisi mutation ile evidence checkpoint arasına enjekte edilip restart sonrası inspect-first davranış doğrulanmalı.
- Belirsiz apt/systemd sonucunda aynı mutation'ın otomatik ikinci kez çalışmadığı host command loglarıyla kanıtlanmalı.
- Package upgrade boyunca operation journal, authoritative receipt ve root-owned private izinlerin korunduğu doğrulanmalı.
- Public UDP/TCP 53, delegation, secondary transfer/failover ve browser yüzeyi ayrı T-DNS kabul kapıları olarak açık kalır.
