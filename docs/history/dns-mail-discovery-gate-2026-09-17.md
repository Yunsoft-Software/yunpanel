# Mail discovery DNS readiness gate — 2026-09-17

PowerDNS mail desired state artık autodiscover/autoconfig kayıtlarını yalnız doğrulanmış endpoint capability evidence ile kabul eder.

- Legacy `autodiscoverEnabled` / `autoconfigEnabled` benzeri boolean değerler DNS kaydı üretemez.
- Optional endpoint resolver exact mail-domain, local server ve monoton revision kimliği vermelidir.
- Ready capability hostname'i yalnız `autodiscover.<domain>` veya `autoconfig.<domain>` olabilir; protokol `https`, route sırasıyla `/autodiscover/autodiscover.xml` ve `/mail/config-v1.1.xml` olmalıdır.
- Capability yoksa ya da ilgili endpoint `null` ise DNS intent yoktur. Yanlış hostname, HTTP veya route evidence fail-closed sonuç verir.
- Ready capability için yalnız YunPanel-owned `mail` A/AAAA RRset'leri üretilir. IPv6 kaydı ancak server DNS identity içinde IPv6 gerçekten varsa eklenir.
- Resolver revision'ı mail evidence digest'ine bağlanır; endpoint readiness değişimi eski durable zone operation hedefi olarak kabul edilmez.
- Production composition optional resolver dependency'sini taşır fakat gerçek discovery endpoint implementation'ı tamamlanana kadar resolver bağlı değildir. Bu nedenle mevcut production state dead discovery kaydı yayınlamaz.

Gerçek HTTPS endpoint, certificate, mailbox-domain response ve authoritative DNS kabulü `todo.md` T-MAIL içinde kalır; endpoint implementation'ı `plan.md` P0.4 kapsamındadır.
