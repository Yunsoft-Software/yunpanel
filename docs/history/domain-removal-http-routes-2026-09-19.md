# Domain Removal HTTP Routes & Production Runtime Wiring — 2026-09-19

## Özet

Domain removal runtime ve parent journal yetenekleri authenticated panel route'ları üzerinden HTTP API'ına bağlandı:
- `POST /api/domains/:domainId/removal-preview`: Side-effect-free removal plan & impact preview.
- `POST /api/domains/:domainId/removal-operations`: Deepest-first parent removal operation başlatma.
- `POST /api/domains/:domainId/removal-operations/:operationId/retry-routing`: Failed/stalled routing suspension retry.
- `POST /api/domains/:domainId/removal-operations/:operationId/continue`: Step-bound typed continuation.
- `GET /api/domains/:domainId/removal-operations`: Domain removal operation listesi.
- `GET /api/domains/:domainId/removal-operations/:operationId`: Tekil removal operation durumu.

Tüm route'lar `requirePanelRouteAccess` yetki denetimiyle korunur ve `domainRemovalRuntime` üzerinden production API'ya bağlanmıştır.

## Test & Doğrulama
- `apps/api/test/domain-removal-http.test.js` eklendi; preview, start, continue ve retry-routing istekleri doğrulandı.
- `npm run check` (lint, test [2534 test], build) Node 24 ortamında başarıyla tamamlandı.
