# API-01 — REST işlevleri ve API anahtarı yaşam döngüsü
Sonuç: ÇALIŞIYOR — kapsam: API anahtarları ve otomasyon kimlik doğrulaması.
Ajan: CODEX · Tarih: 2026-10-28 · Senaryo: `e2e/ozellik/api-01.spec.js` · Koşu: 3/3, test.fail 0 (49,5 sn)

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
| --- | --- | --- |
| Owner oluşturma, tek gösterim, makine erişimi ve iptal | Geçti | Gerçek host kaydında SHA-256 eşleşmesi; whoami 200 → 401; iptal diskte kalıcı |
| Hatalı domain/port, eksik alan ve CSRF | Geçti | DOM alt/üst sınırları; gerçek 400/403; başarısız girdide kayıt oluşmadı |
| Customer ve Reseller sınırı | Geçti | Arayüzden oluşturulmuş gerçek hesaplarla GET/POST/DELETE 403; Owner anahtarı 200 kaldı |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| — | Ürün hatası gözlenmedi; ilk koşunun form seçicisi düzeltildi | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/api-key-store.test.js` | GEÇERLİ | Gerçek dosya kaydı, hash/iptal; geçti |
| `apps/api/test/api-key-http.test.js` | MOCK | Gerçek HTTP; kimlik bağlamı ve audit taklit; geçti |
| `apps/api/test/automation-http.test.js` | MOCK | Gerçek HTTP; session/auth store taklit; geçti |

## Panelde olmayan
Tam REST eşdeğerliği ayrı kapsamdır; bu senaryo anahtar yaşam döngüsünü ve otomasyon erişim sınırını ölçer.

## Temizlenemeyen kaynaklar
Yok. İki koşunun anahtarları iptal edildi; Customer/Reseller profilleri ve giriş hesapları arayüzden silindi, sayfalı API ile yokluk doğrulandı. İptal geçmişi korunur.
