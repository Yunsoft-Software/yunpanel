# DNS-03 — Master/secondary, DNS aç/kapat ve harici DNS davranışı
Sonuç: KISMİ
Ajan: AGENT_4 · Tarih: 2026-10-27 16:55 · Senaryo: `e2e/ozellik/dns-03.spec.js` · Koşu: 4/4, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: Master DNS zone rolü, SOA serial eşleşmesi, secondary senkronizasyon paneli ve SSH PowerDNS fiziksel doğrulaması | geçti | Arayüzde Zone türü (Master), SOA serial; SSH ile `pdnsutil show-zone webrich.news` çıktısında `This is a Master zone` ve eşleşen DB serial |
| harici DNS ve yerel zone olmayan durum davranışı: alt alan adı üst zone delegasyonu ve yerel zone yokluğu durumu | geçti | Subdomain panelinde üst zone delegasyonu ve yönlendirme; yerel zone yokluğunda "Yerel Authoritative DNS Zone Bulunmuyor" EmptyState ve oluşturma butonu |
| hatalı girdi ve sınır durum kontrolü: geçersiz domain ID ile secondary DNS sorgusu 404 döner | geçti | `/api/panel/domains/non-existent-domain-id-99999/dns/secondary` endpoint'i güvenli 404 döndürdü |
| Plesk eşdeğerliği: domain bazında Master/Secondary rol dönüştürme ve DNS servisini kapatma (Disable DNS) arayüzü kontrolü | bilinen hata | test.fail: BULGU DNS-03 — Master/Secondary rol dönüştürme ve domain bazında DNS servisini kapatma (Disable DNS) arayüzü panelde bulunmuyor |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | BULGU DNS-03: Panelde Plesk eşdeğeri Master/Secondary rol değiştirme (Switch to Secondary) ve domain bazında DNS servisini devre dışı bırakma (Disable DNS) arayüzü yok | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/web/test/dns-secondary-model.test.js` | GEÇERLİ | Secondary DNS senkronizasyon durum modeli ve etiketlemeleri |
| `apps/web/test/dns-secondary-ui-wiring.test.js` | GEÇERLİ | SecondaryDnsStatusPanel bileşeni render ve salt okunur evidence kontrolleri |
| `apps/api/test/powerdns-authoritative-service.test.js` | GEÇERLİ | PowerDNS backend servisinin secondaryDns hedef entegrasyonu |

## Panelde olmayan
Domain bazında Master DNS rolünden Secondary (Slave) rolüne dönüştürme ("Switch to Secondary" / "Switch to Primary"), Secondary modunda Master IP tanımlama ve domain bazında DNS servisini devre dışı bırakma ("Disable DNS Service" / "Switch DNS to Off") arayüzü ve mutation endpoint'i.

## Temizlenemeyen kaynaklar
—
