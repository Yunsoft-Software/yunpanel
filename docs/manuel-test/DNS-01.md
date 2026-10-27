# DNS-01 — Domain zone ve DNS kayıt CRUD; desteklenen RR türleri matrisi
Sonuç: ÇALIŞIYOR
Ajan: AGENT_4 · Tarih: 2026-10-27 13:06 · Senaryo: `e2e/ozellik/dns-01.spec.js` · Koşu: 2/2, test.fail 0

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: DNS zone görüntüleme, desteklenen RR türleri matrisi ve A/CNAME/TXT/MX CRUD işlemleri ile yerel PowerDNS dig fiziksel doğrulaması | geçti | SSH ile PowerDNS sorguları (`dig @127.0.0.1`): A (`157.180.11.105`), CNAME (`webrich.news.`), TXT (`"v=spf1 ~all"`), MX (`10 mail.webrich.news.`), silme sonrası boş yanıt |
| hatalı girdi: geçersiz IP formatı girildiğinde form hata verir, kayıt oluşturulmaz ve DNS sunucusunda yansımaz | geçti | Modal içinde `A record value is invalid` hatası, kayıt oluşmadı, `dig` sorgusu boş döndü |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| — | — | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `e2e/06-authoritative-dns.spec.js` | GEÇERLİ | Zone RRsets, manual TXT CRUD, Zone template diff ve DNSSEC durumunu inceler |
| `apps/api/test/dns-zone-records.test.js` | GEÇERLİ | Zone okuma, child zone yetki kontrolü ve manual kayıt apply/remove birim testi |
| `apps/api/test/dns-zone-records-validation.test.js` | GEÇERLİ | Manual DNS kayıt girdi ve gövde doğrulama kontrolleri |

## Panelde olmayan
—

## Temizlenemeyen kaynaklar
—
