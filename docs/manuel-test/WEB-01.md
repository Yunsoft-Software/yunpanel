# WEB-01 — Domain ekleme ve amaca göre site oluşturma sihirbazı
Sonuç: ÇALIŞIYOR
Ajan: AGENT_3 · Tarih: 2026-11-06 14:32 · Senaryo: `e2e/ozellik/web-01.spec.js` · Koşu: 4/4, test.fail 0

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
|---|---|---|
| mutlu yol: kök domain + PHP-FPM + www alias | geçti | HTTP 200 / 301 Nginx yanıtı, body Website ready |
| hatalı girdi: mükerrer alan adı çakışması | geçti | 409 Conflict ve hata bildirimi ile engellendi |
| rol senaryosu: müşteri doğrudan site ekleyemez | geçti | Web sitesi ekle butonu gizli, /websites/new yönlendirildi |
| hata senaryosu: Docker stack boş proje kimliği (H4) | geçti | 400 site_create_invalid_id ile sihirbaz engellendi |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
|---|---|---|
| KRİTİK | Bayi site tahsisi kilitli ve sihirbaz silme engelleri | T803 (Düzeltildi) |
| NORMAL | Docker stack boş projectId 400 hatası | H4 |

## Mevcut testler
| Dosya | Sınıf | Not |
|---|---|---|
| `e2e/ozellik/web-01.spec.js` | GEÇERLİ | 4/4 senaryo Playwright ile .28'de art arda 2 kez doğrulandı |

## Panelde olmayan
- Sihirbaz içinden doğrudan YAML editörüyle sıfırdan Docker Compose stack tanımlama.

## Temizlenemeyen kaynaklar
— (Koşu sonunda tweb01-a4-* önekli tüm site ve müşteri kayıtları panelden silindi; kalan: 0)
