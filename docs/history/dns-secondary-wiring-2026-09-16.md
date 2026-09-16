# DNS secondary status production wiring — 2026-09-16

## Tamamlanan dilim

- `mountDnsZoneSecondaryStatusRoutes()` artık `mountPowerDnsRoutes()` içinde production route composition'a bağlı.
- Authenticated read-only endpoint: `GET /api/domains/:domainId/dns/secondary`.
- Route mevcut `dnsIdentityRegistry` ve `authoritativeService` dependency'lerini yeniden kullanıyor; PowerDNS API key public response state'ine taşınmıyor.
- `apps/api/test/powerdns-secondary-wiring.test.js` production composition'ın secondary route'u register etmeye devam ettiğini regression contract olarak kilitliyor.

## Sonraki kalan iş

- Secondary sync state'ini Network/DNS veya Domain DNS panelinde göstermek.
- `synced`, `stale`, `ahead`, `unverifiable` ve `primary_kind_required` durumlarının health/warning politikasını source contract'ta sabitlemek.
- Gerçek multi-authoritative host/browser kabulü `todo.md` kapsamında kalır.

## Doğrulama notu

Bu ortamda repository checkout/runtime test runner erişimi olmadığı için Node test suite burada çalıştırılmadı. GitHub Actions kullanılmadı.
