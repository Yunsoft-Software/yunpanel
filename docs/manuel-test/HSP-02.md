# HSP-02 — Reseller oluştur/düzenle/askıya al/etkinleştir/sil
Sonuç: KISMİ
Ajan: AGENT_1 · Tarih: 2026-10-30 15:25 · Senaryo: `e2e/ozellik/hsp-02.spec.js` · Koşu: 4/4, test.fail 1 (2 kez art arda)

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
|---|---|---|
| 01. Mutlu yol: Bayi oluşturma, limit güncelleme, askıya alma ve yeniden açma | Geçti | UI akışı + `/api/auth/session` (200, kind: reseller) + askıya alma/açma giriş kontrolü |
| 02. Hatalı girdi ve sınırlar: Mükerrer kullanıcı adı, kapasite aşımı ve bağlı müşterili bayi profilini kaldırma engeli | Geçti | 409 `username_taken`, 409 `reseller_limit_reached` (1/1 kapasite dolumu), 409 `hosting_account_in_use` |
| 03. Rol ve kiracı sınırları: Bayi yetki izolasyonu | Geçti | Bayi `/resellers` → `/websites` yönlenmesi, 403 API engeli (bayiler ve kullanıcılar tablosu) |
| 04. Bilinen hata: /resellers ekranında bayi eklerken sınırsız (Sınırsız) limit onay kutusu bulunmalı | Bilinen hata (test.fail) | `AccountCreateDialog` modalında sınırsız limit checkbox'ı bulunmuyor, sadece zorunlu sayısal input var |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
|---|---|---|
| NORMAL | `/resellers` ekranında bayi eklerken sınırsız müşteri/site kotası seçeneğinin (`Sınırsız` checkbox) bulunmaması | — |
| NORMAL | `/resellers` ekranında bayi hesabını tek tıkla tamamen silme ve parola düzenleme butonlarının bulunmaması | — |

## Mevcut testler
| Dosya | Sınıf | Not |
|---|---|---|
| `e2e/ozellik/hsp-02.spec.js` | GEÇERLİ | .28'de 4/4 geçen gerçek Playwright özellik testi; sıfır mock, 2 ardışık koşu |
| `apps/api/test/hosting-account-store.test.js` | GEÇERLİ | 68/68 gerçek SQLite veri katmanı testi |
| `apps/api/test/hosting-account-http-boundary.test.js` | GEÇERLİ | 35/35 gerçek HTTP sınırları ve yetki ayrımı |
| `apps/web/test/reseller-customers-wiring.test.js` | YÜZEYSEL | Kaynak kodda regex arayan yüzeysel kontrol |

## Panelde olmayan
- `/resellers` ekranında tek tıkla bayi silme (profil + login hesabı) ve parola sıfırlama işlevi
- `AccountCreateDialog` modalında sınırsız adet seçeneği (`Sınırsız` checkbox)

## Temizlenemeyen kaynaklar
Yok (koşu sonrası `thsp02-a1-*` önekli müşteriler: 0, bayiler: 0, kullanıcılar: 0 doğrulandı)
