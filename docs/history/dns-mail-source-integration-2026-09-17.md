# DNS mail-source integration — 2026-09-17

Versioned PowerDNS zone re-apply artık production composition içinde canlı mail registry'lerini kullanır. Resolver yalnız exact Web Domain ilişkili local mail domainini kabul eder; enabled state için hazır server mail-service identity zorunludur. Shared identity hostname'i zone dışındaysa MX/SRV hedefi olarak kullanılabilir fakat o yabancı zone adına A/AAAA üretilmez.

Managed `mail` desired state şunları kapsar:

- local mail enabled iken MX, SPF ve DMARC;
- config'in gerçekten açtığı STARTTLS IMAP 143 ve authenticated submission 587 endpoint'leri;
- current DKIM public TXT kaydı;
- rotation tamamlanırken korunması gereken pending-retirement previous selector TXT kaydı.

Mail disabled/absent olduğunda intent boştur. Re-apply bu durumda yalnız YunPanel ownership comment'i `mail` olan RRset'leri silmeye aday yapar; manual RRset'leri korur. Shared Roundcube mapping ve gerçek autodiscover/autoconfig endpoint'i tamamlanmadığı için webmail/discovery kaydı üretilmez.

Mail-domain, mail-service identity, current DKIM ve retirement revision evidence'ı secret-free SHA-256 kimliğine çevrilir. Durable zone re-apply operation store v2 bu kimliği saklar ve restart recovery exact kimlik eşleşmeden eski operasyonu tamamlanmış saymaz. Store v1 okunup v2'ye taşınır; eski interrupted operation için olmayan mail evidence uydurulmaz.

Bu kaynak değişikliği gerçek PowerDNS, resolver ve mail endpoint kabulü değildir. Local previous-selector retirement sonradan `docs/history/dns-local-dkim-retirement-2026-09-17.md` içinde tamamlandı; kalan host/DNS kanıtları `todo.md` T-DNS ve T-MAIL altında tutulur.
