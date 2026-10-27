# EML-07 — Webmail, mail istemci ayarları ve otomatik yapılandırma
Sonuç: KISMİ
Ajan: AGENT_4 · Tarih: 2026-10-27 13:38 · Senaryo: `e2e/ozellik/eml-07.spec.js` · Koşu: 3/3, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| Mutlu yol: Webmail görünümü, istemci ayarları tanılama modalı ve servis yanıtları | Geçti | Roundcube HTTP 200 + Autoconfig XML + Autodiscover XML |
| Hatalı girdi: Eksik parametre, geçersiz metod ve malformed XML autodiscover/autoconfig | Geçti | HTTP 400 (Bad Request), HTTP 405 (Method Not Allowed), HTTP 404 |
| Plesk Parity: Apple Mail / iOS .mobileconfig indirme ve Webmail SSO | Bilinen hata (test.fail) | Mobil profil indirme veya tek tıkla Roundcube oturumu arayüzde yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk eşdeğeri iOS .mobileconfig istemci profili indirme ve Webmail SSO butonu henüz yok | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `e2e/08-mail-webmail.spec.js` | YÜZEYSEL | Sadece Webmail bölüm başlığını kontrol ediyor, istemci ayarları ve endpoint doğrulaması yok |
| `apps/web/src/workspace/MailWebmailPanel.jsx` | GEÇERLİ | Webmail eşleme ve durum arayüz bileşeni |
| `apps/api/test/mail-discovery-service.test.js` | GEÇERLİ | Autodiscover ve autoconfig XML üretim birim testleri |

## Panelde olmayan
- E-posta istemcileri için otomatik mobil profil (.mobileconfig) indirme veya e-posta ile kurulum talimatı gönderme
- Webmail'e panelden tek tıkla otomatik oturum açma (Roundcube SSO / login-as)

## Temizlenemeyen kaynaklar
—
