# EML-11 — Mail servisi sertifikası ve hostname/SNI davranışı
Sonuç: KISMİ
Ajan: AGENT_2 · Tarih: 2026-10-28 12:15 · Senaryo: `e2e/ozellik/eml-11.spec.js` · Koşu: 3/3, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| Mutlu yol: Mail ana sertifikası, Postfix/Dovecot TLS ve SMTP/IMAP el sıkışmaları | Geçti | GET /api/panel/mail-service-identity 200 + OpenSSL port 465 & 993 CN=mail.webrich.news |
| Hatalı girdi & koruma: Geçersiz domain, uyuşmayan revizyon reddi | Geçti | PUT 404 domain_not_found + PUT 409 conflict + PUT 400 invalid input |
| Plesk Parity: Çoklu domain Mail SNI (Postfix sni_maps & Dovecot local_name) | Bilinen hata (test.fail) | postconf -h tls_server_sni_maps boş; Dovecot local_name SNI blokları yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk eşdeğeri alan adı bazlı çoklu Mail SNI haritası (Postfix tls_server_sni_maps & Dovecot local_name) eksik | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/mail-configuration-tls-identity.test.js` | GEÇERLİ | TLS identity resolver, Postfix cert parametreleri ve preview digest testleri |
| `apps/api/test/mail-service-identity-http.test.js` | GEÇERLİ | /api/mail-service-identity GET/PUT/DELETE RBAC ve revizyon testleri |
| `packages/config-templates/test/mail-tls-identity.test.js` | GEÇERLİ | Postfix & Dovecot ana TLS yapılandırması şablon ve hash testleri |

## Panelde olmayan
- Postfix `tls_server_sni_maps` ile alan adı bazlı ayrı TLS sertifikası sunma
- Dovecot `local_name <hostname> { ssl_cert = ... ssl_key = ... }` SNI desteği
- Çoklu alan adı için farklı SSL sertifikalarını mail servisine ayrı ayrı atama arayüzü

## Temizlenemeyen kaynaklar
—
