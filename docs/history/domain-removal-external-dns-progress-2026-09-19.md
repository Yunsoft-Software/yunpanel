# Domain removal External DNS metadata lifecycle — 2026-09-19

Bu kayıt P0.9 Domain removal parent journal'ındaki \`external_dns_zone\` step'inin kaynak tarafındaki durable lifecycle ilerlemesini özetler.

## Sorun

Domain removal operation registry daha önce external DNS zone ID'leri için step üretiyordu fakat:

- plan yalnız zone ID'sini pinliyor, revision/update/domain identity evidence'ını tutmuyordu;
- runtime \`external_dns_zone\` step'ini continuable kabul etmiyor ve handler taşımıyordu;
- \`dns-hosting-registry\` altında mevcut guarded delete primitive'i public registry contract'ına expose edilmiyordu;
- parent plan child Domain zone'larını da kendi external-DNS step listesine ekleyerek child operation ile duplicate cleanup riski taşıyordu.

## Uygulanan lifecycle

- Domain removal preview artık her tracked external DNS zone için exact intent pinler:
  - id
  - zoneName
  - webDomainId
  - managementMode=external
  - status
  - revision
  - updatedAt
- Operation registry yeni \`dnsZoneIntents\` evidence'ını persist eder; eski journal bu evidence'a sahip değilse destructive continuation fail-closed kalır.
- Parent operation yalnız kendi root Domain'ine bağlı external zone için step üretir. Descendant zone cleanup child Domain operation'a bırakılır.
- Child preview parent'ın pinned external-DNS intent subset'iyle alan bazında exact eşleşmeden child journal oluşturamaz.
- \`dns-hosting-registry\` mevcut guarded registry deletion primitive'ini \`deleteZone\` olarak expose eder.
- \`domain-removal-runtime\` external DNS step'ini continuable hale getirir.
- Explicit continuation:
  - Domain'in exact suspended ownership evidence'ını doğrular;
  - zone ID/name/webDomain/revision/status/updatedAt drift'ini mutation öncesi kontrol eder;
  - yalnız exact \`delete-dns-zone:<id>:<revision>\` confirmation ile tracked metadata relationship'ini kaldırır;
  - evidence digest'i parent journal step sonucuna yazar.
- Startup inspect provider veya metadata mutation'ı replay etmez.
  - Step daha önce \`running\` olmuş ve metadata artık yoksa lost-ack post-condition olarak step'i kapatabilir.
  - Step mutation ownership almadan metadata yok olmuşsa fail-closed kalır.
  - Revision/status/update drift'inde delete çağrısı yapılmaz.

## Provider ownership sınırı

Bu lifecycle external DNS provider üzerindeki A/AAAA/CNAME/MX/TXT kayıtlarını körlemesine silmez. Mevcut DNS hosting registry yalnız external lifecycle relationship'i track eder. Provider record silme ancak ayrı operation-owned record identity/snapshot evidence modeli varsa güvenli biçimde eklenebilir.

Dolayısıyla bu dilimde tamamlanan destructive sınır **tracked External DNS Zone metadata unlink**'tir; Cloudflare veya başka provider kayıtlarının implicit cascade deletion'ı değildir.

## Küçük commitler

- \`df83d281\` — guarded DNS zone metadata deletion'ı registry contract'ına expose et.
- \`10f7d1d3\` — External DNS removal intent'ini preview'a pinle.
- \`8756e567\` — External DNS intent'ini durable Domain removal journal'a persist et.
- \`950e9c3d\` — parent runtime External DNS metadata unlink lifecycle'ı.
- \`8e8eba12\` — parent step'i yalnız root Domain external DNS scope'una daralt.
- \`e4badaa0\` — production runtime'a DNS hosting registry wiring.
- \`9288fe7c\` — child Domain External DNS intent subset fence.
- \`15e81b00\` — explicit unlink / restart lost-ack / drift source test kontratları.
- \`ee31c5f9\`, \`5d9a4a7e\`, \`f7bcf0bd\` — plan/registry/runtime source fixture kontratlarını yeni intent evidence'a taşı.

## Doğrulama durumu

Bu sohbet ortamında repository checkout/Node runner yoktur. Yeni ve regresyon test komutları \`todo.md\` içindeki T-CODEX-SOURCE bölümüne eklendi. Testler gerçekten koşmadan "passed" denmez.

Gerçek Ubuntu/provider kabulünde ayrıca şunlar doğrulanmalıdır:

- tracked external metadata unlink sonrasında external provider kayıtlarının değişmediği;
- stale revision/update state'in fail-closed kaldığı;
- process metadata delete response sınırında öldürülünce startup'ın ikinci delete göndermediği;
- child Domain external DNS relationship'inin parent tarafından duplicate unlink edilmediği.
