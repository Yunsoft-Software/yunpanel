# TLS-04 — Panel, website ve mail servisine doğru sertifika atama
Sonuç: KISMİ
Ajan: AGENT_1 · Tarih: 2026-10-27 13:16 · Senaryo: `e2e/ozellik/tls-04.spec.js` · Koşu: 2/3, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: Website ve Mail servisine doğru sertifika atama ve fiziksel doğrulama | geçti | Nginx vhost `ssl_certificate`, Postfix `smtpd_tls_cert_file`, Dovecot `ssl_cert` ve 993 IMAPS canlı TLS `CN=mail.webrich.news` |
| hatalı girdi: Geçersiz parametreler, var olmayan domain veya revizyon çakışması reddedilir | geçti | 404 domain_not_found, 400 bind_input_invalid, 409 revision_conflict ve 404/409 select-preview |
| panel sertifikası ve web sitesi sertifika seçici: Plesk eşdeğerlik eksiklikleri | bilinen hata | Paneli koruyan SSL sertifikasını atama/değiştirme (Plesk Tools & Settings -> Certificate for securing Plesk) ve sitede sertifika seçici UI bulunmuyor |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Paneli koruyan SSL sertifikasını seçme/atama UI/API ve sitede sertifika seçici UI eksik | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/certificate-http.test.js` | GEÇERLİ | Domain certificate select-preview / select ve custom import testleri |
| `apps/api/test/certificate-mail-reload.test.js` | GEÇERLİ | Mail identity sertifika çözümleme ve Dovecot/Postfix reload testleri |
| `apps/api/test/mail-service-identity-http.test.js` | GEÇERLİ | Mail service identity API binding, validation ve revizyon testleri |

## Panelde olmayan
- Plesk Tools & Settings -> SSL/TLS Certificates altındaki "Certificate for securing Plesk" (panelin kendi Nginx vhost sertifikasını atama/değiştirme) arayüzü ve API'si.
- Web sitesi SSL arayüzünde aktif veya alternatif sertifikalar arasından seçim yapma dropdown/formu (yalnızca ACME yenileme veya ilk sertifika alma formu mevcut).

## Temizlenemeyen kaynaklar
—
