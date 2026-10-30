# ROL-01 — Yönetici Service Provider görünümü
Sonuç: KISMİ
Ajan: AGENT_3 · Tarih: 2026-10-30 15:50 · Senaryo: `e2e/ozellik/rol-01.spec.js` · Koşu: 4/4, test.fail 1

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
|---|---|---|
| mutlu yol: Owner Service Provider görünümü, bayi ve müşteri oluşturma, limit güncelleme | geçti | `GET /api/auth/session` (role: owner), `GET /api/panel/users/hosting/accounts?kind=reseller` (maxCustomers: 1, maxWebsites: 2) |
| hatalı girdi: bayi kotası aşımı, mükerrer kullanıcı, bağlı müşterili bayiyi silme engeli, geçersiz filtre | geçti | UI alert doğrulandı: 409 limit, 409 username_taken, 409 hosting_account_in_use, 404 filtre uyarısı |
| yetki ve rol izolasyonu: Reseller ve Customer yetki sınırları ve bayiyi askıya alma/etkinleştirme | geçti | Reseller rotaları /websites'e yönlendi, askıya alınınca bayi ve alt müşteri 401 oldu, doğrudan müşteri 200 kaldı |
| bilinen hata: /customers tablosunda ve profil modalında bağlı bayi kullanıcı adı görünmelidir | bilinen hata | `test.fail`: /customers tablosunda bağlı bayi sütunu yok ve profil modalında bayi adı yerine ham UUID gösteriliyor |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
|---|---|---|
| NORMAL | `/customers` tablosunda bağlı bayi sütunu olmaması ve profil modalında bayi kullanıcı adı yerine ham UUID gösterilmesi | — |
| NORMAL | Owner'ın `/customers` sayfasında müşteri kotalarını ve giriş bilgilerini doğrudan düzenleme formunun bulunmaması | — |
| NORMAL | `/dashboard` sayfasında `websites` koleksiyonu yüklenmediği için tekil site sayısı yerine domain sayısının gösterilmesi | — |

## Mevcut testler
| Dosya | Sınıf | Not |
|---|---|---|
| `e2e/ozellik/rol-01.spec.js` | **GEÇERLİ** | 4 senaryo .28'de 2 kez art arda koştu (4/4 passed, 1 test.fail), mock/page.route yok |
| `apps/api/test/hosting-account-store.test.js` | **GEÇERLİ** | SQLite üzerinde Owner/Reseller/Customer sınırları, askıya alma ve oturum iptali (56/56) |
| `apps/api/test/tenant-boundary.test.js` | **GEÇERLİ** | Çoklu tenant ve rol izolasyonu HTTP sınırları (44/44) |

## Panelde olmayan
- Yönetici görünüm geçişi (Service Provider ↔ Power User; `docs/plesk-feature-parity.md` ROL-02/ROL-08 Sonraki faz)
- `/customers` ve `/resellers` sayfalarından bağlı hesabı tek tıkla silme aksiyonu

## Temizlenemeyen kaynaklar
— (İki koşu sonunda .28 `auth.sqlite` üzerinde `trol01-%` kullanıcı ve hosting hesabı sayısı 0 doğrulandı)
