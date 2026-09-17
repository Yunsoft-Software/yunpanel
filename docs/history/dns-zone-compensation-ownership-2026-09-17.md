# DNS zone compensation ownership — 2026-09-17

Website local-DNS provisioning compensation'ı artık zone adını tek başına destructive ownership kanıtı saymaz.

- Control plane persisted step evidence içindeki exact server, Web Domain, zone, template snapshot, DNS identity revision, serial, secondary topology ve DNSSEC bağını yeniden doğrular.
- Yalnız apply evidence'ı `created=true` olan operation zone DELETE'e adaydır. Pre-existing ve değişmemiş zone compensation sırasında korunur; pre-existing zone'u değiştiren eski apply için exact pre-operation RRset snapshot bulunmadığından işlem açık `website_dns_zone_compensation_rollback_unavailable` ile fail-closed kalır.
- Host manager DELETE öncesinde canlı zone'un her RRset'ini exact desired content, TTL ve YunPanel ownership metadata'sıyla karşılaştırır. Manual RRset, eksik/fazla managed RRset veya metadata/content drift'i deletion'ı engeller.
- Initial zone create sonrasındaki PATCH hatası artık kör best-effort DELETE çalıştırmaz. Cleanup yalnız canlı state exact creation baseline'ı veya exact tamamlanmış desired state ise yapılır; eşzamanlı manual kayıt ya da belirsiz partial state korunur.
- Compensation inspection aynı ownership ayrımını salt-okunur raporlar; API key ve record content public operation evidence'ına eklenmez.

Odak testleri 14/14 geçti. Host-runtime paketi 524/524, API paketi 2205/2205 geçti. Gerçek PowerDNS/failure-injection kabulü çalıştırılmadı; kalan host doğrulaması `todo.md` T-DNS altında tutulur.

Kalan lifecycle işi: pre-existing zone re-apply için exact pre-operation RRset snapshot/record-level rollback, explicit zone suspend/delete operation'ları ve bunların P0.9 retryable reverse-dependency zincirine bağlanması.
