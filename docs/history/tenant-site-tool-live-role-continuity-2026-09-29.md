# Tenant site-tool live role continuity — 2026-09-29

Dal: `development`.

## Amaç

Plesk benzeri Customer/Reseller akışında Website grant'i olan tenant aktörünün mevcut site araçlarını kullanabilmesi gerekir. Bu kaynak denetimi, HTTP katmanında izin verilmesine rağmen gateway/WebSocket/worker/recovery katmanında eski `owner/site_manager` rol whitelist'i nedeniyle doğrudan `reseller` ve `customer` rollerinin yarıda kesildiği yolları kapatır. Root/server yönetimi Owner-only kalır; bütün tenant yolları current `websiteIds` ve canlı oturum yetkisiyle fail-closed çalışmaya devam eder.

## Tamamlanan kaynak değişiklikleri

### Terminal WebSocket
- `apps/api/src/terminal-websocket.js`: site terminali canlı hedef yetkisi `site_manager`, `reseller` ve `customer` rollerini aynı `site_management + websiteIds` sınırında kabul eder.
- Pasif tenant aktörü WebSocket upgrade/periyodik reauthorization sırasında reddedilir.
- Server/root terminal hâlâ yalnız aktif Owner management oturumudur.
- Kaynak commitleri: `9107747f`, test `06eaeba6`.

### elFinder / Files gateway
- `apps/api/src/elfinder-handoff-http.js`: bootstrap ve Website handoff üretimi direct reseller/customer oturumlarında yalnız atanmış Website için açıldı; pasif aktör fail-closed reddedilir.
- `apps/api/src/elfinder-handoff-service.js`: vendor gateway state reauthorization artık reseller/customer rollerinde de current `websiteIds` grant'ini zorunlu tutar.
- Kaynak commitleri: `a620fc76`, `e6659f83`; test kaynakları `f919d35e`, `dc4a9f44`.

### Website Cron durable mutation
- `apps/api/src/website-cron-http.js`: mutation actor projection direct reseller/customer rollerini kabul eder; pasif aktör reddedilir.
- `apps/api/src/website-cron-apply-service.js`: queued job authorization aktör rolünü reseller/customer için de korur.
- `apps/api/src/local-website-cron-operation.js`: host mutation başlamadan live actor reauthorization reseller/customer rollerinde de zorunludur.
- Kaynak commitleri: `abe992a1`, `d39af411`, `096cdde7`; test kaynakları `a5c172cb`, `99a80bac`, `f6158be1`.

### Reviewed WP/Composer crash recovery
- `apps/api/src/website-php-tool-operation-receipt.js`: güvenli reviewed action receipt kanıtı reseller/customer actor rolünü de kabul eder. Böylece normal worker yolunda kabul edilen tenant işi crash recovery aşamasında eski rol whitelist'i yüzünden geçersizleşmez.
- Recovery hâlâ durable job context ile actor session/user/role, Website/Application, preview digest ve confirmation eşitliğini birebir doğrular; receipt host komutunu tekrar çalıştırmaz.
- Kaynak commitleri: `db212496`; test kaynakları `ffb96271`, `38ac50d5`.

## Güvenlik sınırı

- Bu değişiklikler foreign Website erişimi vermez. Non-owner site aktörü için current `websiteIds` membership zorunlu kalır.
- Owner root terminali, raw WP-CLI/Composer mutation'ı ve Owner-only host yönetim yolları genişletilmedi.
- phpMyAdmin'ın panel-bound vendor session modeli değiştirilmedi; mevcut live Website grant doğrulaması korunur.
- Kaynak audit gerçek host/browser production kabulü değildir.

## Bu ortamda yapılamayan kabul

Temiz `development` checkout'u ile hedef testleri ve full check/build çalıştırılmak istendi ancak ortamın Git DNS erişimi `Could not resolve host: github.com` hatası verdi. Yerel runtime Node `v22.16.0`, npm `10.9.2`; hedef kabul Node24/npm11'dir. Bu nedenle yeni test kaynakları yazılmış olsa da bu turda çalıştırılmış sayılmaz.

Gerçek kabul `todo.md / T-DEV-RESELLER-LIVE` altında açık bırakıldı: Node24/npm11 checkout/test/build, Owner + iki reseller + customer matrisi, logout/suspend/grant-removal sırasında açık terminal/elFinder/gateway/cron/job davranışı ve crash-recovery senaryoları.
