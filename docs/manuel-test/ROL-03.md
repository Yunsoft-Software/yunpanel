# ROL-03 — Reseller paneli ve kendi kaynak/kullanıcı sınırı
Sonuç: KISMİ
Ajan: AGENT_4 · Tarih: 2026-11-04 10:35 · Senaryo: `e2e/ozellik/rol-03.spec.js` · Koşu: 3/3, test.fail 1

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
|---|---|---|
| Mutlu yol: Bayi ve müşteri oluşturma, sol menü, kota tahsisi | Geçti | `POST /accounts` (reseller/customer), `auth_customer_quotas` (1/1024/2048/2) |
| Hatalı girdi & sınırlar: 409 limit engeli, yetkisiz rotalar ve API uçları | Geçti | 409 müşteri kotası, 409 site kotası, 4x `/websites` yönlendirmesi, 403 API |
| Bilinen hata: Bayinin müşterisine site tahsis akışı | Bilinen hata | `p:has-text("Yerel sunucu bilgisi yükleniyor…")` kilidi |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
|---|---|---|
| KRİTİK | Bayi müşterisine site tahsis etme akışı sunucu yükleme kilidi ve 403 tenant boundary hatası | T804 |

## Mevcut testler
| Dosya | Sınıf | Not |
|---|---|---|
| `e2e/ozellik/rol-03.spec.js` | GEÇERLİ | .28 üzerinde 3/3 geçti (1 test.fail), iki kez art arda yeşil |
| `apps/api/test/reseller-scope.test.js` | GEÇERLİ | 41/41 geçti; SQLite üzerinde bayi kapsam ve kotalarını ölçüyor |
| `apps/api/test/par-02-reseller-customer-management.test.js` | GEÇERLİ | 6/6 geçti; bayi müşteri CRUD ve sınırlarını sınıyor |

## Panelde olmayan
- Bayi ekranında müşteri silme (`deleteCustomerLogin`) butonu ve `/websites?customer=<id>` filtresi

## Temizlenemeyen kaynaklar
— (Tüm `trol03-a4-*` kaynakları temizlendi; `CLEANUP_CHECK: remaining users = 0, remaining accounts = 0`)
