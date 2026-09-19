# External DNS Domain Exact Pending DNS Requirements ve Provider Apply İlerlemesi (2026-09-20)

## 1. Özet
P0.4 mail core parity ve DNS gereksinimleri doğrultusunda, DNS yönetimi harici olan (`managementMode === 'external'`) DNS zonları ve alan adları için tam ve deterministik DNS gereksinimleri inceleme (`inspect`), sağlayıcı uygulama önizlemesi (`preview`) ve onaylı uygulama (`apply`) servisi ve HTTP rotaları tamamlanmıştır.

Harici DNS modundaki bir alan adı veya zon için:
1. Web yönlendirme (apex A, apex AAAA, domain alias CNAME/A) gereksinimleri türetilir.
2. Bağlı Mail Domain varsa ve yerel moddaysa (`managementMode === 'local'`), posta yönlendirme (MX, SPF TXT, DMARC TXT, mail host A/AAAA, webmail A/AAAA ve `mailDkimRegistry` üzerinden DKIM TXT) gereksinimleri deterministik olarak türetilir. Mail Domain harici moddaysa (`managementMode === 'external'`), yerel sunucu kayıtları üretilmeden harici durum korunur.
3. Her gereksinim mevcut canlı DNS sağlayıcısı (Cloudflare `inspectRecord`) veya genel DNS çözümleyicileri üzerinden incelenerek `fulfilled` veya `pending` (`missing`, `mismatch`, `unresolved`, `conflict`) olarak sınıflandırılır.
4. Desteklenen kayıtlar (`A`, `AAAA`, `CNAME`, `TXT`) için Cloudflare sağlayıcısına yönelik deterministik `previewDigest` ve `confirmation` üretilir.
5. Zon başına işlemler serileştirildiğinden ve her kayıt mutasyonu sağlayıcı `snapshotDigest`'ini güncellediğinden, `apply` adımı anahtar (`key`) bazında tekil kayıt mutasyonlarını kuyruğa alır (`OPERATIONS.DNS_RECORD_APPLY`, `resourceType: 'dns_zone'`), çakışmaları ve bayat önizlemeleri fail-closed engeller.

## 2. Gerçekleştirilen Değişiklikler

### `apps/api/src/dns-requirements-service.js`
- `createDnsRequirementsService` servisi oluşturuldu:
  - `inspectZoneRequirements(dnsZoneId)`: Canonical web ve mail gereksinimlerini türetir, genel DNS ve sağlayıcı canlı durumunu denetler.
  - `previewRequirementsApply({ dnsZoneId, expectedRevision, key, keys })`: Desteklenen bekleyen kayıtlar için deterministik önizleme, `previewDigest` ve onay dizgisi üretir.
  - `applyRequirements({ dnsZoneId, expectedRevision, previewDigest, confirmation, key, keys })`: Onaylı `dns.record.apply` işini kuyruklar; zon kilidi ve çakışma kontrollerini uygular.
  - `inspectDomainRequirements(webDomainId)`: Web alan adı ID'si üzerinden bağlı harici zonu bularak gereksinimleri inceler.

### `apps/api/src/external-lifecycle-http.js`
- 4 yeni kimlik doğrulamalı yönetim rotası eklendi:
  - `GET /api/dns-zones/:dnsZoneId/requirements`
  - `POST /api/dns-zones/:dnsZoneId/requirements/preview`
  - `POST /api/dns-zones/:dnsZoneId/requirements/apply`
  - `GET /api/domains/:domainId/dns-requirements`

### `apps/api/src/management-audit.js`
- Yönetim denetim izi (audit) eşleşmelerine `POST /api/dns-zones/:dnsZoneId/requirements/preview` (`dns.requirements.preview`) ve `POST /api/dns-zones/:dnsZoneId/requirements/apply` (`dns.requirements.apply`) rotaları eklendi.

### `apps/api/src/app.js`
- `dnsRequirementsService` servisi ve `DnsRequirementsServiceError` hata sınıfı eklendi, rotalara ve hata yakalama katmanına bağlandı.

## 3. Eklenen Testler ve Doğrulama
- `apps/api/test/dns-requirements-service.test.js`:
  - 8 test birimi ile web, harici mail, yerel mail (MX, SPF, DMARC, DKIM), Cloudflare denetimi, önizleme ve anahtar bazlı kuyruklama doğrulandı.
- `apps/api/test/external-lifecycle-http.test.js`:
  - HTTP rotaları, yetki ve zon izolasyonu doğrulandı.
- `apps/api/test/management-audit-route-parity.test.js`:
  - Audit rotaları ile tam uyum doğrulandı.
- Node 24 (`v24.21.0`) ortamında `npm test` (2,869 test) ve `npm run check` sıfır hata ile geçti.
