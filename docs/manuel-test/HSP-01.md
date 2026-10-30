# HSP-01 — Müşteri oluştur/düzenle/askıya al/etkinleştir/sil
Sonuç: KISMİ
Ajan: AGENT_1 · Tarih: 2026-10-30 15:00 · Senaryo: `e2e/ozellik/hsp-01.spec.js` · Koşu: 4/4, test.fail 1 (2 kez art arda)

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
|---|---|---|
| 01. Mutlu yol: Müşteri oluşturma, düzenleme, kota atama, askıya alma ve yeniden açma | Geçti | UI akışı + `/api/auth/session` (200, active: 1) + `/api/panel/users/hosting/accounts/:id` kotalar (2 site, 1024MB disk, 5120MB trafik, 2 DB) |
| 02. Hatalı girdi ve sınırlar: Mükerrer kullanıcı adı, bayi müşteri ve site kotası sınırı aşımı | Geçti | 409 `username_taken`, 409 `reseller_limit_reached` (müşteri adedi ve web sitesi kotası) |
| 03. Rol ve kiracı sınırları: Müşteri ve bayi yetki izolasyonu | Geçti | Müşteri `/customers` → `/websites` yönlenmesi, 403 API engeli; Bayi yabancı müşteri 403/404 |
| 04. Bilinen hata: Bayi arayüzünde müşteri silme (Sil) butonu bulunmalı | Bilinen hata (test.fail) | `ResellerCustomersPage.jsx` tablosunda `DELETE /login` arayüze bağlanmadığı için Sil butonu yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
|---|---|---|
| NORMAL | Bayi ekranında müşteri silme (`Sil`) butonunun bulunmaması (`DELETE /login` arayüze bağlanmamış) | — |
| NORMAL | Owner `/customers` ekranında müşteri giriş ve kotalarını düzenleme formunun bulunmaması | — |

## Mevcut testler
| Dosya | Sınıf | Not |
|---|---|---|
| `e2e/ozellik/hsp-01.spec.js` | GEÇERLİ | .28'de 4/4 geçen gerçek Playwright özellik testi; sıfır mock, 2 ardışık koşu |
| `apps/api/test/hosting-account-store.test.js` | GEÇERLİ | 68/68 gerçek SQLite veri katmanı testi |
| `apps/api/test/hosting-account-http-boundary.test.js` | GEÇERLİ | 35/35 gerçek HTTP sınırları ve yetki ayrımı |
| `apps/web/test/hosting-accounts-wiring.test.js` | YÜZEYSEL | Kaynak kodda regex arayan yüzeysel kontrol |

## Panelde olmayan
- Bayi ekranında (`ResellerCustomersPage.jsx`) ve Owner müşteri ekranında tek tıkla müşteri silme (`Sil`) butonu
- Owner'ın `/customers` ekranından müşteri kotalarını ve parolasını düzenleyebileceği form

## Temizlenemeyen kaynaklar
Yok (koşu sonrası `thsp01-a1-*` önekli müşteriler: 0, bayiler: 0, kullanıcılar: 0 doğrulandı)
