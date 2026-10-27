# DNS-02 — TTL, SOA, zone şablonu ve şablon değişimini uygulama
Sonuç: KISMİ
Ajan: AGENT_1 · Tarih: 2026-10-27 16:49 · Senaryo: `e2e/ozellik/dns-02.spec.js` · Koşu: 5/5, test.fail 2

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: Özel TTL değeri tanımlama, güncelleme ve yerel PowerDNS üzerinden TTL fiziksel doğrulaması | geçti | SSH `dig @127.0.0.1` ile TXT yanıtında TTL 7200 ve 1800 doğrulaması; silme sonrası boş yanıt |
| mutlu yol: Sunucu SOA politikası ayarlarını görüntüleme ve zone template diff doğrulaması | geçti | SSH `dig @127.0.0.1 webrich.news SOA` ile NS, hostmaster, refresh/retry/expire/min değerleri doğrulaması |
| hatalı girdi: Geçersiz TTL ve geçersiz SOA parametreleri reddedilir | geçti | HTML5 min/max kısıtı ve UI'da `SOA expire must be greater than refresh` doğrulama hatası |
| Plesk eşdeğerliği: Panel arayüzünde Genel DNS Zone Şablonu kayıt yönetim arayüzü bulunmamaktadır | bilinen hata | `test.fail` — Panel UI'da şablon kayıt editörü eksik (yalnızca API mevcut) |
| Plesk eşdeğerliği: Şablon değişikliklerini tüm mevcut alan adlarının zone'larına topluca uygulama özelliği bulunmamaktadır | bilinen hata | `test.fail` — Toplu senkronizasyon (Apply DNS Template Changes) eksik (yalnız tekil Reapply) |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Panel UI'da Genel DNS Zone Şablonu kayıt editörü ve toplu şablon uygulama eksik | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/dns-zone-template-registry.test.js` | GEÇERLİ | Şablon versiyonlama, normalizasyon ve diff birim testi |
| `apps/api/test/dns-zone-reapply.test.js` | GEÇERLİ | Zone Template re-apply, diff ve managed RRset entegrasyonu |
| `apps/api/test/powerdns-http.test.js` | GEÇERLİ | Template preview/apply ve SOA identity HTTP rotaları |

## Panelde olmayan
- Plesk eşdeğeri Genel DNS Zone Şablonu (DNS Zone Template) kayıt yönetim ekranı (yalnızca backend API mevcut)
- Şablon değişikliklerini tüm mevcut alan adlarının zone'larına topluca uygulama (Apply DNS Template Changes)

## Temizlenemeyen kaynaklar
—
