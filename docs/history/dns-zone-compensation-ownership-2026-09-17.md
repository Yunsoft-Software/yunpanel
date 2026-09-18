# DNS zone compensation ownership — 2026-09-17

Website local-DNS provisioning compensation'ı artık zone adını tek başına destructive ownership kanıtı saymaz.

- Control plane persisted step evidence içindeki exact server, Web Domain, zone, template snapshot, DNS identity revision, serial, secondary topology ve DNSSEC bağını yeniden doğrular.
- Yalnız apply evidence'ı `created=true` olan operation zone DELETE'e adaydır. Pre-existing ve değişmemiş zone compensation sırasında korunur; pre-existing zone'u değiştiren eski apply için exact pre-operation RRset snapshot bulunmadığından işlem açık `website_dns_zone_compensation_rollback_unavailable` ile fail-closed kalır.
- Host manager DELETE öncesinde canlı zone'un her RRset'ini exact desired content, TTL ve YunPanel ownership metadata'sıyla karşılaştırır. Manual RRset, eksik/fazla managed RRset veya metadata/content drift'i deletion'ı engeller.
- Initial zone create sonrasındaki PATCH hatası artık kör best-effort DELETE çalıştırmaz. Cleanup yalnız canlı state exact creation baseline'ı veya exact tamamlanmış desired state ise yapılır; eşzamanlı manual kayıt ya da belirsiz partial state korunur.
- Compensation inspection aynı ownership ayrımını salt-okunur raporlar; API key ve record content public operation evidence'ına eklenmez.

Odak testleri 14/14 geçti. Host-runtime paketi 524/524, API paketi 2205/2205 geçti. Gerçek PowerDNS/failure-injection kabulü çalıştırılmadı; kalan host doğrulaması `todo.md` T-DNS altında tutulur.

## 2026-09-18 — pre-existing zone re-apply rollback authority

Domain-scoped local zone re-apply artık provisioning compensation'dan ayrı exact before/after rollback authority taşır.

- Preview live PowerDNS zone'u RRset content/comment, kind ve DNSSEC dahil canonical snapshot + SHA-256 digest olarak pinler.
- Apply başlamadan önce source snapshot ve desired/template/mail intent'ten deterministik expected-after snapshot/digest journal'a yazılır; bu evidence persist edilmeden provider mutation başlamaz.
- Durable operation store güncel şemada before/after snapshot'ları private tutar; eski store sürümleri eksik yeni alanları `null` migrate eder, evidence uydurmaz.
- Lost-ack/restart exact expected-after digest'i görürse ikinci PATCH atmadan operation'ı başarıya uzlaştırır. Operation-owned mixed before/after state `dns_zone_reapply_partial_apply_detected` ile failed-but-rollbackable kalır; foreign/manual üçüncü state fail-closed bloklanır.
- Host rollback zone DELETE/recreate yapmaz. Exact before/after RRset state'lerini record-level sınıflandırır; yalnız operation-owned after→before REPLACE/DELETE ve gerekirse kind transition uygular, pre-existing manual RRset'leri korur.
- Rollback operation ID + monoton journal revision + source/applied digest'e bağlı typed confirmation ister. `rolling_back` restart'ında host mutation otomatik replay edilmez; inspect-first reconciliation kullanılır.
- HTTP yüzeyi rollback preview/apply endpoint'lerini yalnız exact journal revision/digest/confirmation ile açar; private RRset snapshot content'i public operation response'una çıkmaz.
- Partial provider mutation sonrası exact apply result evidence yoksa bile failed operation rollbackable kalabilir; rollback sonucu ayrı durable lifecycle ile `rolled_back` / `rollback_failed` olarak izlenir.

Bu turdaki yeni source/test kontratları repository'ye küçük commitlerle eklendi. Bu çalışma ortamında GitHub checkout için dış ağ çözümlemesi başarısız olduğu için yeni Node test suite'i yerelde tekrar koşturulamadı; önceki 14/14, host-runtime 524/524 ve API 2205/2205 sayıları yalnız 2026-09-17 checkpoint'ine aittir. Gerçek PowerDNS/failure-injection kabulü `todo.md` T-DNS altında açık bırakıldı.

Kalan lifecycle işi: explicit zone suspend/delete operation'ları ve bunların P0.9 retryable reverse-dependency/retention zincirine bağlanması.
