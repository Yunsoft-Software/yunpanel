# MIG-02 — Desteklenen diğer hosting panellerinden taşıma (cPanel, DirectAdmin vb.)
Sonuç: KISMİ
Ajan: AGENT_1 · Tarih: 2026-10-28 13:25 · Senaryo: `e2e/ozellik/mig-02.spec.js` · Koşu: 6/6, test.fail 4

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: Sistem MIG-02 yetenek envanteri ve fiziksel servis sağlığı kontrolü | geçti | HTTP 200, yetenek envanteri (partial/owner), SSH systemd teyidi |
| hatalı girdi ve güvenlik: geçersiz ID, bulunamayan kayıt ve yetkisiz erişim | geçti | HTTP 400 (invalid_capability_id), HTTP 404, HTTP 401/403 |
| eksiklik 1: cPanel ve DirectAdmin içe aktarma arayüzü ve geçiş sihirbazı yokluğu | bilinen hata (test.fail) | Ön yüz navigasyon ve `/settings` rotasında cPanel/DirectAdmin yok |
| eksiklik 2: cPanel yedek arşivini (cpmove) ayrıştırma/önizleme rotası yokluğu | bilinen hata (test.fail) | POST `/api/panel/importer/cpanel/preview` 404 dönüyor |
| eksiklik 3: DirectAdmin yedek arşivini ayrıştırma/önizleme rotası yokluğu | bilinen hata (test.fail) | POST `/api/panel/importer/directadmin/preview` 404 dönüyor |
| eksiklik 4: Uzak cPanel/WHM ve DirectAdmin sunucusundan SSH/RPC ile çekme yokluğu | bilinen hata (test.fail) | POST `/api/panel/importer/cpanel/remote-connect` 404 dönüyor |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk Migrator eşdeğeri cPanel / DirectAdmin içe aktarma arayüzü ve sihirbazı ön yüzde bulunmuyor | — |
| NORMAL | cPanel yedek arşivini (cpmove) ayrıştırma ve önizleme API rotası tanımlanmamış (404) | — |
| NORMAL | DirectAdmin yedek arşivini ayrıştırma ve önizleme API rotası tanımlanmamış (404) | — |
| NORMAL | Canlı uzak cPanel/WHM ve DirectAdmin sunucularından SSH/RPC ile uzaktan doğrudan aktarma yeteneği yok | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/par-04-non-reseller-capabilities.test.js` | GEÇERLİ | MIG-02 yetenek tanımı ve RBAC denetimleri |
| `apps/api/test/plesk-importer.test.js` | GEÇERLİ | Plesk içe aktarıcı (cPanel/DirectAdmin desteklemiyor) |

## Panelde olmayan
- cPanel / DirectAdmin içe aktarma ve geçiş sihirbazı kullanıcı arayüzü.
- cPanel cpmove / full backup arşiv ayrıştırıcı ve önizleme rotası (`/api/importer/cpanel`).
- DirectAdmin backup arşiv ayrıştırıcı ve önizleme rotası (`/api/importer/directadmin`).
- Canlı uzak cPanel/WHM ve DirectAdmin sunucularından SSH/API ile uzaktan aktarma yeteneği.

## Temizlenemeyen kaynaklar
—
