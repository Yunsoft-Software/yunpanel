# DNS secondary health + Domain UI — 2026-09-16

## Tamamlanan dilim

- Domain DNS workspace secondary authoritative sync state'ini read-only olarak gösteriyor.
- Panel primary SOA serial, PowerDNS `notified_serial`, current-serial NOTIFY evidence ve her secondary'nin observed SOA serial/error code bilgisini ayrı ayrı gösteriyor.
- `notified_serial` hiçbir yerde remote secondary sync kanıtı olarak kullanılmıyor.
- API secondary status response'una explicit health/recovery policy eklendi:
  - `disabled` -> health gate `not_applicable`, recovery `none`.
  - `synced` + ready -> health gate `pass`, recovery `none`.
  - `drift` / `unverifiable` -> health gate `block`, warning, recovery `observe_only`.
  - drift içinde `ahead` secondary -> severity `error`; yine otomatik mutation yok.
  - `primary_kind_required` -> health gate `block`, severity `error`, recovery `manual_intervention`.
  - tüm state'lerde `automaticMutationAllowed=false`; serial lag/status observation kör Zone Template re-apply veya duplicate RRset mutation başlatmaz.
- Web presentation backend policy varsa onu source-of-truth kabul ediyor; eski response'lar için fail-closed fallback korunuyor.

## Kaynak kontratları

- `apps/api/src/dns-zone-secondary-status.js`
- `apps/api/test/dns-zone-secondary-status.test.js`
- `apps/web/src/workspace/dns-client.js`
- `apps/web/src/workspace/dns-model.js`
- `apps/web/src/workspace/SecondaryDnsStatusPanel.jsx`
- `apps/web/src/workspace/DnsPanel.jsx`
- `apps/web/test/dns-secondary-client.test.js`
- `apps/web/test/dns-secondary-model.test.js`
- `apps/web/test/dns-secondary-ui-wiring.test.js`

## Gerçek ortamda kalan kabul

`todo.md` içindeki `T-DNS` multi-authoritative delegation/transfer/failover kapısı geçmeden secondary DNS Plesk parity tamamlanmış sayılmaz. Gerçek primary mutation sonrasında remote SOA serial propagation ve browser render davranışı gerçek iki authoritative endpoint üzerinde doğrulanmalıdır.

## Sonraki exact iş

PowerDNS package/config upgrade/rollback lifecycle'ını durable operation evidence ile transactional hale getirmek: inspect-first restart recovery, configtest-before-reload ve failure durumunda eski çalışan config'i koruma.

## Doğrulama notu

Bu connector ortamında repository checkout/runtime test runner olmadığı için Node test suite çalıştırılmadı. GitHub Actions kullanılmadı.
