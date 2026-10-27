# PLN-08 — Disk, trafik, domain, mailbox, DB ve kullanıcı adet limitleri
Sonuç: KISMİ
Ajan: AGENT_1 · Tarih: 2026-10-27 15:30 · Senaryo: `e2e/ozellik/pln-08.spec.js` · Koşu: 2/3, test.fail 1

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
|---|---|---|
| 01. Mutlu yol: Kaynak limitlerinin atanması ve arayüzde gösterimi | geçti | GET /api/panel/users/hosting/accounts/{id} ile quotas nesnesi doğrulandı |
| 02. Sınır ve aşım senaryosu: Adet limitinde yeni kaynak engeli | geçti | UI 'Etkin (Kota Doldu)' rozeti, disabled buton ve API 409 customer_quota_exceeded |
| 03. Bilinen Bulgu: Reseller AllocateSiteDialog servers.read yetkisi | bilinen hata | test.fail: Reseller servers.read iznine sahip olmadığı için AllocateSiteDialog formu kilitli |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
|---|---|---|
| NORMAL | Reseller rolünde servers.read yetkisi eksikliği AllocateSiteDialog formunu kilitliyor | — |

## Mevcut testler
| Dosya | Sınıf | Not |
|---|---|---|
| `apps/api/test/customer-quotas.test.js` | GEÇERLİ | Kota doğrulama, aşım sınırları ve kapasite kontrolleri |
| `apps/api/test/reseller-limits.test.js` | GEÇERLİ | Reseller müşteri ve site sınırları (66 test) |
| `apps/api/test/mailbox-quota-http.test.js` | GEÇERLİ | Posta kutusu kotaları ve HTTP uç noktaları |

## Panelde olmayan
—

## Temizlenemeyen kaynaklar
—
