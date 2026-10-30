# HSP-03 — İletişim, şirket, açıklama ve hesap erişim bilgileri
Sonuç: KISMİ
Ajan: AGENT_2 · Tarih: 2026-10-30 15:40 · Senaryo: `e2e/ozellik/hsp-03.spec.js` · Koşu: 4/4, test.fail 1 (2 kez art arda)

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
|---|---|---|
| 01. Mutlu yol: E-posta biçimli erişim bilgileriyle bayi ve müşteri oluşturma, giriş bilgilerini düzenleme, normalizasyon ve oturum düşürme | Geçti | UI akışı + `/api/auth/session` (200, active: 1) + AccountDialog parola uyuşmazlığı kontrolü + `/api/panel/users/hosting/accounts/:id` (kind: customer) |
| 02. Hatalı girdi ve sınırlar: Mükerrer kullanıcı adı, şema dışı alanların ve geçersiz parolanın reddedilmesi | Geçti | UI 409 `username_taken` uyarısı, 400 şema dışı alan reddi (`contactName`, `company`), 400 `invalid_password` |
| 03. Rol ve yetki sınırları: Müşteri ve bayinin kiracı ve yetki izolasyonu | Geçti | Müşteri ve bayi için `/api/panel/users` (403), yabancı müşteri profili ve login güncelleme (403), kurtarma e-postası (403) |
| 04. Bilinen hata: Müşteri ve bayi oluşturma/düzenleme formlarında iletişim ve şirket alanları bulunmalı | Bilinen hata (test.fail) | Plesk HSP-03 paritesi: `Müşteri ekle` / `Bayi ekle` modallarında `İletişim adı`, `Şirket`, `Telefon` ve `Açıklama` alanları yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
|---|---|---|
| NORMAL | Müşteri ve bayi formlarında iletişim adı, şirket, telefon ve açıklama alanlarının bulunmaması (Plesk HSP-03 eşdeğerliği eksik) | — |
| NORMAL | Owner'ın `/customers` ve `/resellers` ekranlarından müşteri veya bayi parolasını sıfırlama seçeneğinin bulunmaması | — |
| NORMAL | `Hesabım` modalındaki Kurtarma E-postasının Müşteri ve Bayi rollerine kapalı olması (`403 forbidden`) | — |

## Mevcut testler
| Dosya | Sınıf | Not |
|---|---|---|
| `e2e/ozellik/hsp-03.spec.js` | GEÇERLİ | .28'de 4/4 geçen gerçek Playwright özellik testi; sıfır mock, 2 ardışık koşu |
| `apps/api/test/hosting-account-store.test.js` | GEÇERLİ | 68/68 gerçek SQLite veri katmanı testi |
| `apps/api/test/hosting-account-http-boundary.test.js` | GEÇERLİ | 35/35 gerçek HTTP sınırları ve yetki ayrımı |
| `apps/web/test/hosting-accounts-wiring.test.js` | YÜZEYSEL | Kaynak kodda regex arayan yüzeysel kontrol |

## Panelde olmayan
- Müşteri ve bayi hesaplarında İletişim Adı (`contactName`), Şirket (`company`), Telefon (`phone`), Adres ve Açıklama (`description`) alanları
- Owner için `/customers` ve `/resellers` profillerinden parola değiştirme / sıfırlama formu
- Müşteri ve Bayi rolleri için `Hesabım` üzerinden kurtarma e-postası tanımlama

## Temizlenemeyen kaynaklar
Yok (koşu sonrası `thsp03-a2-*` önekli kullanıcılar: 0, bayiler: 0, müşteriler: 0 fiziksel SQLite sorgusuyla doğrulandı)
