# Local PowerDNS DKIM retirement — 2026-09-17

Local mail DKIM rotation sonrasındaki previous-selector temizliği artık PowerDNS zone lifecycle'ına revision-bound explicit preview/apply olarak bağlıdır.

- Retirement registry kalıcı `dns_retirement_applying` aşamasını destekler. Bu intent provider mutation'ından önce atomik store'a yazılır ve restart sonrasında eski selector'ın desired state'e yeniden eklenmesini engeller.
- Preview yalnız enabled local mail domaini ile onun aynı hosttaki root Web Domain ilişkisini kabul eder. Previous TXT kaydı exact selector, public value ve YunPanel `source=mail` / `mail-dkim-<selector>` ownership kimliğiyle eşleşmelidir.
- Manual veya ambiguous previous-selector RRset'i değiştirilmez. Previous selector dışındaki zone drift'i retirement mutation'ına gizlice dahil edilmez; temiz zone gereksinimi fail-closed blocker üretir.
- Apply current preview digest + typed confirmation kullanır, durable generic zone re-apply journal'ını çalıştırır ve retirement state'ini ancak authoritative zone yeniden okunup previous selector'ın yokluğu kanıtlandıktan sonra temizler.
- Intent persist ile PowerDNS mutation arasındaki kesintide applying state korunur. PowerDNS mutation ile state clear arasındaki kesintide retry provider mutation'ını tekrarlamadan authoritative yokluğu görüp state'i kapatır.
- Authenticated HTTP yüzeyi yalnız tam local DNS/mail composition'ında açılır. Preview/apply istekleri exact field/query doğrulaması ve common management audit sınıflandırması kullanır; public response private DKIM key taşımaz.

Kaynak testleri normal mutation, zaten-yok no-op, restart-persist state, manual conflict, unrelated drift, HTTP contract ve production dependency wiring senaryolarını kapsar. Gerçek PowerDNS authoritative cevapları ve process-kill kabulü `todo.md` T-DNS içinde kalır.
