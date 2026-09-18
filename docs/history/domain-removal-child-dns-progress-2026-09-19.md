# Domain removal child authoritative DNS progress — 2026-09-19

Bu checkpoint P0.9 Domain removal parent journal'ında descendant Domain'lerin local authoritative DNS intent'ini child-specific pinleyen ve mevcut private DNS retirement runtime'ına aktaran kaynak dilimini kaydeder. Public Domain delete apply veya standalone DNS delete mutation route'u açılmamıştır.

## Tam impact coverage ve pinned intent

- Authoritative DNS impact provider sonucu artık affected Domain kümesini exactly-one olarak kapsamak zorundadır. Eksik, fazla veya duplicate Domain reference fail-closed `authoritative_dns_impact_invalid` üretir.
- Parent removal plan her descendant snapshot'ına kendi DNS state, preview digest, zone snapshot digest, provisioning ownership evidence digest, retention günü ve blocker kümesini ekler.
- Child zone'un manual RRset/DNSSEC gibi orchestration dışı blocker'ları parent start'ı mutation öncesi kapatır. Zone bulunan her child için ownership ve retention kanıtı zorunludur.
- DNS provider bağlı değilken descendant içeren yeni parent plan `authoritative_dns_impact_unavailable` ile başlatılamaz.

## Journal ve geriye uyum

- Yeni operation journal'ı child DNS intent'i eksikse yaratılamaz.
- Önceki child snapshot shape'i okunabilir kalır fakat eksik DNS intent'i `null` olarak hydrate edilir; geçmiş state için ownership veya policy kanıtı uydurulmaz ve runtime fail-closed kalır.
- Root ve child authoritative DNS plan doğrulaması aynı bounded schema'yı kullanır; private confirmation veya snapshot içeriği public operation görünümüne eklenmez.

## Parent-owned child DNS lifecycle

- Parent continuation current leaf child preview'ındaki DNS intent'ini parent'ın exact pinned child intent'iyle state/preview/snapshot/ownership/retention/blocker düzeyinde karşılaştırır. Drift varsa child journal veya routing mutation yaratılmaz.
- Exact child operation routing suspension ve Website detach sonrasında kendi `authoritative_dns` step'ini mevcut shared private DNS retirement runtime'ıyla yürütür. Ayrı veya ikinci bir destructive DNS motoru eklenmemiştir.
- Zone retirement current suspended Domain revision'ı, boş Website/certificate binding'i, descendant yokluğu, inactive routing, exact zone snapshot, ownership ve retention policy kanıtlarını tekrar doğrular.
- Child DNS sonucu exact durable deleted-operation evidence'ı olmadan başarılı sayılmaz; ardından metadata finalization çalışır ve parent child step'i yalnız tam removed child evidence'ıyla kapanır.
- Startup child veya DNS mutation'ı replay etmez. Exact completed evidence reconcile edilir; incomplete state explicit typed continuation bekler.

## Kaynak doğrulama

- Node 24.21 ile resource-impact, Domain removal plan/registry/runtime paketindeki ilgili **52 test geçti, 0 test başarısız**.
- `@yunpanel/api` test paketinin tamamında **2.517 test geçti, 0 test başarısız**.
- Tam repository `npm run check` kapısı Node 24.21 ile geçti: repository policy/lint, bütün workspace testleri ve web production build başarılıdır.
- Child local-zone success zinciri ve snapshot/ownership/retention driftinin routing mutation öncesi bloklanması test edildi.
- Bu turda hiçbir sunucuya bağlanılmadı; `.44` production sunucusuna dokunulmadı.

## Kalan P0.9 işi

1. Certificate material/registry retirement handler'ını operation-owned evidence ile bağla.
2. Local mail + shared webmail mapping cleanup ve external DNS lifecycle handler'larını durable child evidence ile bağla.
3. Eksik Unix/runtime/DB/SFTP/log/backup impact provider'larını tamamlamadan public delete apply yüzeyi açma.
