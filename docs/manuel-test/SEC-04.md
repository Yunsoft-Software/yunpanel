# SEC-04 — Oturum/MFA/parola politikası ve API erişim sınırı
Sonuç: KISMİ
Ajan: AGENT_4 · Tarih: 2026-10-27 14:50 · Senaryo: `e2e/ozellik/sec-04.spec.js` · Koşu: 4/4, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| mutlu yol: oturum çerezleri, MFA & aktif oturum listesi ve CSRF sınır kontrolü | geçti | auth.sqlite sessions tablosunda aktif oturum sayısı >= 1, HttpOnly/SameSite=Strict/Secure çerez, sahte Origin 403 engeli |
| hatalı girdi 1: parola politikası (12 karakter kuralı ve uyuşmazlık denetimi) | geçti | HTML5 minLength=12 kısıtı (checkValidity=false), AccountDialog uyuşmazlık uyarısı |
| hatalı girdi 2: API erişim sınırı ve kaba kuvvet (brute-force rate limit) koruması | geçti | 10 hatalı istek sonrası HTTP 429 rate_limited, auth.sqlite auth_limits attempts >= 10 |
| Plesk Eşdeğerliği: Global Güvenlik Politikası yönetim arayüzü | bilinen hata (test.fail) | Tools & Settings altında genel oturum aşımı ve parola kuralı sayfası yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| NORMAL | Plesk Security Policy eşdeğeri global oturum aşımı/parola karmaşıklık UI eksik | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| e2e/01-auth-users.spec.js | GEÇERLİ | Kullanıcı yaşam döngüsü, MFA ve AccountDialog doğrulaması |
| apps/api/test/user-admin-store.test.js | GEÇERLİ | Backend kullanıcı ve parola karmaşıklık politikası birim testleri |
| apps/api/src/auth-store.js | GEÇERLİ | Oturum, parola ve kaba kuvvet rate limit motoru |

## Panelde olmayan
Global Güvenlik Politikası ekranı (Tools & Settings -> Security Policy: oturum boşta kalma süresi, parola karmaşıklığı seçimi, zorunlu 2FA kuralı).

## Temizlenemeyen kaynaklar
—
