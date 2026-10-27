# HSP-04 — Hesap altında domain, müşteri ve abonelik listeleri
Sonuç: ÇALIŞIYOR
Ajan: AGENT_3 · Tarih: 2026-10-27 15:02 · Senaryo: `e2e/ozellik/hsp-04.spec.js` · Koşu: 3/3, test.fail 0

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| 01. Mutlu yol: Müşteri listesi, arama ve müşteri siteleri | geçti | `/api/panel/users/hosting/accounts?kind=customer` 200, `/websites?customer=<id>` filtreleme |
| 02. Yetki ve sınır: Bayi müşteri izolasyonu | geçti | Bayi arayüzünde yabancı müşteri 0 adet, yalnız kendi müşterisi ve siteleri |
| 03. Fiziksel kanıt: Bayi API izolasyonu ve kiracı sınırı | geçti | Bayi `/api/panel/users/hosting/accounts?kind=reseller` 403, `/websites` tenant izolasyonu |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| — | — | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/web/test/hosting-account-client.test.js` | GEÇERLİ | Web istemcisi hesap/müşteri API sorgu ve filtreleme birim testleri (57 test) |
| `apps/api/test/hosting-account-http.test.js` | GEÇERLİ | Hesap API HTTP yetki, sınır ve kiracı entegrasyon testleri (60 test) |
| `e2e/01-auth-users.spec.js` | KISMEN GEÇERLİ | Kullanıcı yetki ve oturum yaşam döngüsü E2E senaryoları |

## Panelde olmayan
Plesk'teki ayrı "Abonelikler" (Subscriptions) listesi/sekmesi panelde yer almamaktadır; YunPanel MVP mimarisinde siteler doğrudan müşteriye bağlanır, paket/abonelik nesneleri PLN-01..PLN-07 kapsamında sonraki faza ertelenmiştir.

## Temizlenemeyen kaynaklar
—
