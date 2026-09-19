# Certificate Material Retention & GC Lifecycle — 2026-09-19

## Özet

Domain removal ve sertifika emeklilik (`retired`) süreçlerinde ayrılan sertifika materyalleri (`cert.pem`, `fullchain.pem`, `privkey.pem`) için paylaşım ve sahiplik duyarlı (ownership-aware) retention ve çöp toplama (GC) yaşam döngüsü tamamlandı:
- **Registry retirement fiziksel silme sayılmaz**: Domain kaldırıldığında sertifika `state: 'retired'` olarak işaretlenir; on-disk materyaller korunur.
- **Retention süresi denetimi**: Varsayılan 30 günlük retention süresi (`retentionDays = 30`, `YUNPANEL_CERTIFICATE_RETENTION_DAYS`) dolmadan materyaller temizlenmez.
- **Aktif sertifika koruması**: Emekliye ayrılmış olsa dahi, materyali (`materialDigest`, ACME `certName` veya disk yolları) herhangi bir aktif/emekli olmayan sertifika ile paylaşılan materyaller asla silinmez (`shared_active`).
- **Domain referans koruması**: `domainRegistry` içindeki herhangi bir domain tarafından referans verilen sertifikalar temizlenmez.
- **Paylaşılan emekli sertifika koruması**: İki veya daha fazla emekli sertifika aynı materyali paylaşıyorsa, tümünün retention süresi dolmadıkça materyal silinmez (`shared_retained`).
- **Fiziksel temizlik & Purge kanıtı**:
  - Custom sertifikalar: `certificateMaterialManager.removeCustom(id)`.
  - ACME sertifikalar: `acmeManager.deleteCertificate({ certName })` ve `certificateMaterialManager.removeAcme(certName)`.
  - Temizlik sonrasında registry'de `materialPurgedAt` ISO zaman damgası güncellenir (`STORE_VERSION = 7`).
- **Yan etkisiz önizleme ve süpürme**:
  - `inspectGcCandidates`: Yan etkisiz durum raporu (`eligible`, `retained`, `sharedActive`, `sharedRetained`, `alreadyPurged`, `notRetired`).
  - `sweep`: Güvenli süpürme (opsiyonel `dryRun: true` simülasyonu destekli).
  - HTTP endpointleri: `GET /api/certificates/gc/preview` ve `POST /api/certificates/gc/sweep` (`requirePanelRouteAccess`).

## Test & Doğrulama
- `apps/agent/test/acme-manager.test.js`: `deleteCertificate` birim testi.
- `apps/api/test/certificate-material-manager.test.js`: `removeAcme` birim testi.
- `apps/api/test/certificate-source-registry.test.js`: `STORE_VERSION = 7`, `markMaterialPurged`, `materialPurgedAt` testleri.
- `apps/api/test/certificate-material-gc.test.js`: Retention penceresi, aktif paylaşım koruması, domain bağı koruması, cross-retired paylaşım koruması, fiziksel silme ve dryRun testleri.
- `apps/api/test/certificate-http.test.js`: GC preview ve sweep HTTP route testleri.
