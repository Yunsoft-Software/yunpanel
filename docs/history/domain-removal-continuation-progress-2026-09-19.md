# Domain removal continuation progress — 2026-09-19

Bu checkpoint P0.9 Domain removal parent journal'ında güvenle tamamlanan control-plane continuation dilimini kaydeder. Full Domain/Website delete apply yüzeyi açılmamıştır; gerçek Ubuntu/Nginx/PowerDNS failure-injection kabulü `todo.md` içinde açıktır.

## Website binding step'i

- Parent journal'ın sıradaki step'i `website_binding` olduğunda continuation exact operation `updatedAt`, step ID, Domain checksum ve typed confirmation'a bağlıdır. Stale continuation Domain registry mutation'ına ulaşmaz.
- Step host/control-plane mutation'ından önce durable `running` durumuna alınır.
- Detach yalnız parent routing step'inin tamamlanmış suspension operation ID'si ile exact Domain ID/server/hostname/revision/staged+applied checksum ve `suspended` state eşleştiğinde çalışır.
- Journal'daki Website ID ile canlı binding farklıysa işlem fail-closed `blocked` kalır. Binding detach sonucu exact postcondition'ı kanıtlamazsa step başarılı sayılmaz.
- Restart `running` step'i salt-okunur inceler. Exact binding zaten yoksa ikinci detach çağrısı yapmadan stable evidence ile step'i kapatır; binding hâlâ varsa mutation'ı replay etmez ve yeni typed continuation bekler.

## Domain metadata finalization step'i

- Finalization yalnız journal'daki son dependency step'i olarak, Website/certificate binding'leri yokken ve exact suspension evidence korunurken çalışır.
- Registry'nin mevcut typed `finalize-domain-remove` confirmation kontratı yeniden kullanılır; ayrı veya daha gevşek bir delete primitive'i açılmaz.
- Dönen removed snapshot Domain ID/server/hostname/revision/suspension operation/checksum ile eşleşmeden parent operation `removed` olmaz.
- Process finalization mutation'ından sonra fakat journal success yazılmadan kesilirse startup Domain'in yokluğunu inspect eder ve mutation'ı yeniden çağırmadan running step'i kapatır. Domain hâlâ varsa startup yalnız `blocked` bırakır.

## Plan doğruluğu

- Local authoritative zone'u olmayan removal planında `authoritativeDns: null` artık yanlışlıkla `authoritative_dns` step'i üretmez. Bu kenar durum leaf Domain zincirinin Website detach'ten doğrudan metadata finalization'a ilerlemesini sağlar.
- Child Domain, certificate, mail-domain, external DNS ve authoritative DNS step'leri için gerçek destructive lifecycle handler'ı hâlâ yoktur. Parent runtime bu step'leri otomatik başarılı saymaz.
- Public Domain delete apply route'u veya standalone authoritative DNS delete mutation route'u açılmadı.

## Kaynak doğrulama

Node 24 ile Domain removal plan/registry/runtime, Domain suspension ve DNS retirement testlerinden oluşan ilgili paket çalıştırıldı: **52 test geçti, 0 test başarısız**.

Bu sonuç gerçek host kabulü değildir. `.44` production sunucusuna veya başka bir sunucuya bağlantı kurulmadı.

## Kalan P0.9 işi

1. Deepest-first child Domain step'lerini ayrı child removal operations ve exact completion evidence ile bağla.
2. Certificate, webmail/mail ve external DNS için operation-owned destructive lifecycle ile inspect-first recovery tamamla.
3. Hazır durable DNS retirement runtime'ını parent `authoritative_dns` step'ine private mutation surface üzerinden bağla.
4. Tüm dependency provider'ları parent intent'e pinlenmeden ve gerçek-host failure-injection kabulü geçmeden public delete apply açma.
