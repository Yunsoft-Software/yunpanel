# TLS-02 — Wildcard/DNS-01, SAN ve www/mail/webmail kapsamı
Sonuç: KISMİ
Ajan: AGENT_3 · Tarih: 2026-10-28 11:32 · Senaryo: `e2e/ozellik/tls-02.spec.js` · Koşu: 3/3, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: Gerçek domain SAN kapsamı, SSL formundaki alt alan adı seçenekleri ve fiziksel sertifika içeriği | geçti | Nginx vhost SAN `DNS:webrich.news, DNS:www.webrich.news`, 443 canlı TLS el sıkışması, Postfix/Dovecot SNI ve UI formunda www/webmail/mail/assignToMail/wildcard toggle |
| hatalı girdi ve sınır kontrolleri: Yetkisiz SAN ekleme, DNS-01 olmadan wildcard talebi ve SAN limitleri reddedilir | geçti | 409 certificate_domain_mismatch, 409 wildcard_not_supported, 400 invalid_certificate_domains, 400 invalid_certificate_domain, 404 dns_zone_not_found |
| Plesk SSL It! eşdeğerlik eksiklikleri: DNS-01 sağlayıcı yapılandırması, yerel DNS entegrasyonu ve sertifika kapsamını genişletme (Reissue with SAN) UI eksik | bilinen hata | Arayüzde DNS-01 sağlayıcı/token seçimi, yerel DNS TXT veya harici prompt yok; aktif sertifikada SAN genişletme (Reissue with SAN) UI eksik |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Arayüzde Wildcard için DNS-01 / Cloudflare token yapılandırma ve aktif sertifikada SAN genişletme (Reissue) UI eksik | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/certificate-multi-san.test.js` | GEÇERLİ | Multi-SAN alan adı doğrulaması, foreign domain ve wildcard HTTP-01 ret testleri |
| `apps/api/test/certificate-dns-challenge.test.js` | GEÇERLİ | Cloudflare DNS-01 wildcard issue & renew birim ve entegrasyon testleri |
| `apps/web/test/ssl-form-wiring.test.js` | GEÇERLİ | SSL formu www, mail, webmail, assignToMail ve includeWildcard checkbox kontrol testleri |

## Panelde olmayan
- Plesk SSL It! / Let's Encrypt eşdeğeri olarak arayüzde Wildcard talep ederken DNS-01 sağlayıcı/token seçimi veya harici DNS için manuel `_acme-challenge` TXT prompt doğrulama ekranı.
- Yerel PowerDNS üzerinden otomatik `_acme-challenge` TXT kaydı ekleyerek Wildcard sertifika çıkarma desteği.
- Aktif sertifikaya sahip bir alan adında sertifika kapsamını genişletme (Reissue Certificate with SANs) arayüzü (yalnızca ACME renew mevcut).

## Temizlenemeyen kaynaklar
—
