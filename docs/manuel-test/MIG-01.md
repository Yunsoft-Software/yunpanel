# MIG-01 — Plesk'ten kaynakları içe aktarma
Sonuç: KISMİ
Ajan: AGENT_4 · Tarih: 2026-10-28 13:20 · Senaryo: `e2e/ozellik/mig-01.spec.js` · Koşu: 6/6, test.fail 4

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: Plesk çevrimdışı dışa aktarma önizlemesi ve normalizasyonu | geçti | HTTP 200, preview JSON doğrulaması, SSH ile readOnly teyidi |
| hatalı girdi ve güvenlik: .44 sunucu engeli, boş yük ve yetkisiz erişim | geçti | HTTP 403 (forbidden server), HTTP 400 (no websites), HTTP 401/403 |
| eksiklik 1: Plesk Migrator UI (arayüz/sihirbaz) yokluğu | bilinen hata (test.fail) | Ön yüz navigasyon ve `/settings` rotasında Plesk Migrator yok |
| eksiklik 2: Plesk Müşteri, Bayi, Plan ve Abonelik desteği yokluğu | bilinen hata (test.fail) | Ayrıştırıcı özette reseller, customer, plan, subscription üretmiyor |
| eksiklik 3: Gerçek içe aktarma yürütme rotası yokluğu | bilinen hata (test.fail) | POST `/api/panel/importer/plesk/import` 404 dönüyor |
| eksiklik 4: Uzak Plesk sunucusundan SSH/RPC Agent ile çekme yokluğu | bilinen hata (test.fail) | POST `/api/panel/importer/plesk/remote-connect` 404 dönüyor |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk Migrator kullanıcı arayüzü ve yükleme sihirbazı ön yüzde bulunmuyor | — |
| NORMAL | Dışa aktarım ayrıştırıcısında Müşteri, Bayi, Paket ve Abonelik nesneleri desteklenmiyor | — |
| NORMAL | Plesk kaynaklarını sisteme içe aktaran yürütme rotası (/api/panel/importer/plesk/import) bulunmuyor | — |
| NORMAL | Canlı Plesk sunucusundan SSH/RPC Migration Agent ile uzaktan doğrudan aktarma yeteneği bulunmuyor | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/plesk-importer.test.js` | GEÇERLİ | Çevrimdışı JSON ayrıştırıcı, normalizasyon ve .44 güvenlik engeli |
| `apps/api/test/plesk-importer-http.test.js` | GEÇERLİ | `/api/importer/plesk/preview` rotası ve RBAC denetimleri |

## Panelde olmayan
- Plesk Migrator web arayüzü, sihirbazı ve dosya yükleme arayüzü.
- Plesk Müşteri, Bayi, Hizmet Paketi ve Abonelik nesnelerinin ayrıştırılması ve içe aktarımı.
- Önizlenen kaynakları sisteme kalıcı olarak kuran `/api/importer/plesk/import` yürütme rotası.
- Canlı Plesk sunucusundan SSH/RPC Migration Agent ile uzaktan doğrudan veri çekme yeteneği.

## Temizlenemeyen kaynaklar
—
