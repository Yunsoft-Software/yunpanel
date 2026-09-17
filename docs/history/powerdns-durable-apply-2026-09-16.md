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
- Durable journal'ın current/latest operation projection'ı API status ve Network DNS paneline bağlandı. Projection operation durumu, API-key revision, secondary topology, tamamlanmış inspect evidence'ı, timestamps ve recovery reason gösterir; raw API key ile persisted hata mesajını public response'a çıkarmaz. `applying` operation panelde `automaticReplayBlocked` olarak görünür.
- Interrupted operation artık Network DNS panelinden operation ID + journal timestamp fence ile explicit inspect edilebilir. Bu yol package/config/service mutation'ını replay etmez; journal'ı yalnız mevcut host state aynı intent'in tamamlandığını kanıtlarsa `succeeded` kapatır.
- Aynı süreçte gelen PowerDNS apply/resolve mutasyonları durable manager sınırında serialize edilir. Paralel iki panel isteği package/config/service mutation'ını iki kez başlatamaz; ikinci istek ilk sonucun güncel journal ve host evidence'ını yeniden değerlendirir.
- Explicit retry ayrı operation/timestamp-bound typed confirmation ve common audit action kullanır. Durable manager retry öncesinde hostu yeniden inspect eder, authorization checkpoint'ini journal'a yazar ve ancak hedef hâlâ eksikse aynı intent'i replay eder; inspect yoksa mutation başlamaz, retry sonucu belirsizse operation yeniden `applying`/automatic-replay-blocked kalır.
- Durable operation ID secure manager'a apply context'i olarak iletilir. Previous managed config ile authoritative receipt, host mutation başlamadan önce aynı operation'a bağlı SHA-256 kimlikli rollback snapshot'ına alınır.
- Snapshot atomik yazılır; parent dizin `0700`, dosya root-owned `0600` contract'ıyla restart sonrasında yeniden okunur. Public rollback status yalnız availability/reason/digest/önceki secondary topology/zaman alanlarını verir; dosya içerikleri ve API secret public projection'a çıkmaz.
- Aynı operation'ın explicit retry'si ilk snapshot'ı yeniden kullanır; kısmen uygulanmış state previous state diye snapshot'ı ezemez. Yeni operation eski snapshot'ın yerini ancak kendi pre-mutation snapshot hazırlığı tamamlandığında alır.
- Previous config/receipt bulunmayan fresh install ve artık materialize edilemeyen eski credential revision açık `rollback unavailable` evidence bırakır. Snapshot güvenliği veya doğrulaması host mutation'dan önce başarısızsa durable operation belirsiz `applying` yerine güvenli `failed` kapanır.

## Regression kapsamı

Kaynağa aşağıdaki regression testleri eklendi:

- configtest failure sonrası previous config restore;
- first-install rejected candidate cleanup;
- operation journal'ın mutation'dan önce yazılması ve raw API key taşımaması;
- ambiguous apply sonrası ikinci çağrının underlying mutation'ı replay etmemesi;
- interrupted operation hedefi inspect ile sağlanmışsa mutation olmadan success reconciliation;
- config validation rollback'in deterministic failed operation olarak journal edilmesi;
- ready-manager production default'unun durable manager'a bağlı kalması.
- operation context'in initial apply ve explicit retry'da aynı durable operation ID'sini taşıması;
- rollback snapshot'ın restart sonrasında doğrulanması, retry sırasında değişmemesi, raw API key taşımaması ve eksik receipt/credential-rotation durumlarının explicit unavailable kalması.

2026-09-17 snapshot diliminde host-runtime odak testleri desteklenen Node 24 ile çalıştırıldı ve 18/18 geçti. Ardından repository policy, bütün workspace testleri ve production build'i içeren `npm run check` başarıyla tamamlandı. Gerçek host acceptance çalıştırılmadı; GitHub Actions kullanılmadı.

## Açık kalan acceptance / lifecycle sınırı

- Fresh Ubuntu 24.04 üzerinde gerçek `pdns-server` configtest/service/package failure injection yapılmalı.
- Process/API kesintisi mutation ile evidence checkpoint arasına enjekte edilip restart sonrası inspect-first davranış doğrulanmalı.
- Belirsiz apt/systemd sonucunda aynı mutation'ın otomatik ikinci kez çalışmadığı host command loglarıyla kanıtlanmalı.
- Root-private rollback snapshot'ın gerçek dosya sahipliği/izinleri, process restart sonrası okunması, symlink/tamper reddi ve retry sırasında değişmemesi doğrulanmalı.
- Snapshot'tan explicit config + receipt restore, configtest/service health ve başarısız restore compensation henüz kaynakta tamamlanmadı.
- Package upgrade boyunca operation journal, authoritative receipt ve root-owned private izinlerin korunduğu doğrulanmalı.
- Public UDP/TCP 53, delegation, secondary transfer/failover ve browser yüzeyi ayrı T-DNS kabul kapıları olarak açık kalır.
