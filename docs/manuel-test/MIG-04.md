# MIG-04 — Ön kontrol, tekrar senkronizasyon ve taşıma sonrası doğrulama
Sonuç: KISMİ
Ajan: AGENT_3 · Tarih: 2026-10-28 13:30 · Senaryo: `e2e/ozellik/mig-04.spec.js` · Koşu: 6/6, test.fail 4

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: Taşıma öncesi ön kontroller (pre-migration check), kaynak analizi ve fiziksel durum | geçti | HTTP 200, summary doğrulaması, SSH ile readOnly ve servis aktiflik teyidi |
| hatalı girdi ve güvenlik: .44 yasaklı sunucu engeli, boş yük ve geçersiz alan adı uyarısı | geçti | HTTP 403 (.44 forbidden), HTTP 400 (no websites/invalid json), HTTP 401/403 |
| eksiklik 1: Sunucu donanım/kaynak ve PHP sürüm uyumluluk ön kontrol rotası yokluğu | bilinen hata (test.fail) | POST `/api/panel/importer/plesk/precheck` 404 dönüyor |
| eksiklik 2: Tekrar senkronizasyon (Re-sync) API uç noktası yokluğu | bilinen hata (test.fail) | POST `/api/panel/importer/plesk/resync` 404 dönüyor |
| eksiklik 3: Taşıma sonrası otomatik doğrulama (Post-migration validation) rotası yokluğu | bilinen hata (test.fail) | POST `/api/panel/importer/plesk/validate` 404 dönüyor |
| eksiklik 4: Ön yüzde Ön Kontrol, Re-sync ve Doğrulama kontrolleri yokluğu | bilinen hata (test.fail) | Arayüzde ön kontrol, re-sync ve doğrulama bileşenleri bulunmuyor |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk Migrator hedef sunucu disk alanı ve PHP uyumluluk ön kontrol rotası bulunmuyor | — |
| NORMAL | Taşıma sonrası artımlı tekrar senkronizasyon (Re-sync) rotası ve motoru bulunmuyor | — |
| NORMAL | Taşıma sonrası otomatik web/DB/SSL sağlık doğrulama rotası (/validate) bulunmuyor | — |
| NORMAL | Ön yüzde taşıma ön kontrolü, re-sync ve doğrulama arayüz kontrolleri bulunmuyor | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/website-migration-preview.test.js` | GEÇERLİ | Alan adı/site/uygulama ön kontrol eşleme, digest ve tutarsızlık denetimi |
| `apps/api/test/website-migration-http.test.js` | GEÇERLİ | `/api/websites/migration/preview` ve ledger durum sorguları |
| `apps/api/test/local-migration-validation.test.js` | GEÇERLİ | Yerel kontrol düzlemi paketli durum ve loopback HTTP sağlık doğrulaması |

## Panelde olmayan
- Hedef sunucuda disk alanı, RAM ve PHP sürüm paketlerini denetleyen ön kontrol rotası.
- Taşıma sonrası kaynak sunucudaki güncel değişiklikleri aktaran tekrar senkronizasyon (Re-sync) API/motoru.
- Taşınan sitelerin HTTP yanıtı, SSL ve DB bağlantılarını test eden otomatik doğrulama rotası.
- Ön yüzde ön kontroller, tekrar senkronizasyon ve doğrulama sonuçları arayüz bileşenleri.

## Temizlenemeyen kaynaklar
—
