# DNS-05 — Zone transfer yetkileri ve secondary doğrulama
Sonuç: KISMİ
Ajan: AGENT_4 · Tarih: 2026-10-28 11:20 · Senaryo: `e2e/ozellik/dns-05.spec.js` · Koşu: 3/3, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| sunucu DNS kimliği, secondary hedefleri ve fiziksel PowerDNS AXFR doğrulaması | geçti | dig @127.0.0.1 AXFR webrich.news (başarılı), dig @157.180.11.28 AXFR (failed), journalctl (denied: client IP has no permission) |
| secondary DNS endpoint doğrulama, root domain zorunluluğu ve geçersiz domain | geçti | API 200 secondary status/policy, API 409 dns_secondary_root_domain_required, API 404 domain_not_found |
| Plesk eşdeğerliği: domain bazında Zone Transfer ACL ve Secondary/Slave Zone yönetim arayüzü | bilinen hata (test.fail) | DnsPanel arayüzünde per-domain Zone Transfer ACL ve Slave Zone oluşturma/yönetim arayüzü yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| NORMAL | Panelde Plesk eşdeğeri domain bazında Zone Transfer ACL (İzinli Secondary IP adresleri tanımlama) arayüzü eksik; transfer kısıtlamaları yalnızca sunucu genelinde tanımlanabiliyor | — |
| NORMAL | Panelde harici Master DNS sunucusunu kaynak alarak alanı Secondary/Slave Zone olarak barındırma arayüzü bulunmuyor | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| `packages/config-templates/test/powerdns.test.js` | GEÇERLİ | PowerDNS allow-axfr-ips ve also-notify şablon birim testleri |
| `packages/host-runtime/test/dns-secondary-sync-inspector.test.js` | GEÇERLİ | Secondary SOA serial sync/stale/ahead/timeout inspector birim testleri |
| `apps/api/test/dns-zone-secondary-status.test.js` | GEÇERLİ | Secondary DNS status ve health policy servis birim testleri |

## Panelde olmayan
Plesk eşdeğeri her domain için ayrı Zone Transfer ACL (Transfer Restrictions) tanımlama sekmesi ve harici sunucudan zone replike eden Slave/Secondary Zone yönetim arayüzü.

## Temizlenemeyen kaynaklar
—
