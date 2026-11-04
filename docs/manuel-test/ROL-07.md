# ROL-07 — Profil, iletişim bilgisi, parola, oturum ve MFA
Sonuç: KISMİ
Ajan: AGENT_4 · Tarih: 2026-11-04 11:00 · Senaryo: `e2e/ozellik/rol-07.spec.js` · Koşu: 7/7 (iki kez art arda), test.fail 3

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
|---|---|---|
| mutlu yol: parola değiştirme, diğer oturumu sonlandırma, yeni parola ile giriş, kurtarma e-postası, aktif oturumlar | geçti | /api/auth/recovery-email güncellendi/silindi; ctxB 401 oldu; eski parola 401 reddedildi |
| hatalı girdi ve sınırlar: eşleşmeyen/yanlış parola, geçersiz e-posta, geçersiz reset token | geçti | UI 'Yeni parolalar eşleşmiyor'; API 400 invalid_email; #reset-token 400 hatası |
| MFA (TOTP) uçtan uca: kurulum, iptal, doğrulama, kurtarma kodu ile giriş, MFA kapatma | geçti | 10 kurtarma kodu üretildi; 1. kodla giriş sonrası kalan kod 9'a düştü; 2. kodla MFA kapatıldı |
| rol ve yetki: Bayi hesabı oluşturma, Hesabım modalı ve temel bölümler | geçti | Bayi ile Parola, MFA ve Oturumlar bölümleri aktif ve kullanılabilir |
| bilinen hata: üst oturum çubuğunda Bayi için Site Manager rol rozeti | bilinen hata | test.fail: .auth-sessionbar .auth-role içinde Bayi yerine 'Site Manager' gösteriliyor |
| bilinen hata: Bayi hesabında Kurtarma E-postası formu gizli | bilinen hata | test.fail: AccountDialog içinde Kurtarma E-postası alanı gizli ve API 403 Forbidden |
| bilinen hata: /settings?section=account sayfasında profil yönetim formu yok | bilinen hata | test.fail: /settings?section=account sayfasında profil formu/butonu yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
|---|---|---|
| NORMAL | Üst çubuk rol rozeti Bayi/Müşteri hesaplarında 'Site Manager' gösteriyor | — |
| NORMAL | Kurtarma/iletişim e-postası ve şifremi unuttum yalnız Owner rolüne açık | — |
| NORMAL | /settings?section=account sayfasında doğrudan profil/oturum yönetim formu yok | — |

## Mevcut testler
| Dosya | Sınıf | Not |
|---|---|---|
| `e2e/ozellik/rol-07.spec.js` | GEÇERLİ | 7 senaryo gerçek panele karşı 2 kez art arda geçti; mock yok |
| `apps/api/test/auth-store.test.js` | GEÇERLİ | Argon2id, SQLite oturum/parola geçişleri |
| `apps/api/test/mfa-store.test.js` | GEÇERLİ | SQLite üzerinde TOTP, replay engeli, kurtarma kodları |

## Panelde olmayan
Plesk My Profile eşdeğeri kişisel/kurumsal iletişim bilgileri (Ad Soyad, Telefon, Şirket, Adres) ve kullanıcı adı düzenleme alanı panelde bulunmuyor.

## Temizlenemeyen kaynaklar
— (Tüm test hesapları ve ilişkili kayıtlar panel/API üzerinden silindi; `SELECT username FROM users WHERE username LIKE 'trol07-%'` → boş)
