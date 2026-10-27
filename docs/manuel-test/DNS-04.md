# DNS-04 — DNSSEC anahtar/DS/rollover ve güvenli kapatma
Sonuç: KISMİ
Ajan: AGENT_3 · Tarih: 2026-10-27 17:00 · Senaryo: `e2e/ozellik/dns-04.spec.js` · Koşu: 3/3, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| DNSSEC imzalama, KSK/ZSK üretimi, DS ve güvenli kapatma | geçti | SSH pdnsutil show-zone (NSEC/keys), dig DNSKEY, journal |
| Alt alan adı DNSSEC izolasyonu ve API reddi | geçti | UI DnssecPanel yokluğu, API 409 dnssec_root_domain_required |
| Plesk eşdeğeri anahtar rollover (Key Rollover) | bilinen hata (test.fail) | DnssecPanel arayüzünde rollover butonu/akışı yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| NORMAL | Panel arayüzünde Plesk eşdeğeri DNSSEC anahtar rollover (Key Rollover) butonu ve iş akışı eksik | — |
| NORMAL | DNSSEC kapatılıp tekrar açıldığında eski succeeded operasyon kaydı idempotency takılmasına yol açabiliyor | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| `packages/host-runtime/test/powerdns-dnssec-manager.test.js` | GEÇERLİ | PowerDNS backend dnssec manager birim testleri |
| `apps/web/test/dns-client.test.js` | GEÇERLİ | DNSSEC preview/apply REST istemci birim testleri |
| `apps/web/test/dns-model.test.js` | GEÇERLİ | DNSSEC durum ve rozet gösterimi birim testleri |

## Panelde olmayan
UI üzerinden Plesk eşdeğeri KSK/ZSK Rollover (Anahtar yenileme) başlatma ve aşama takibi.

## Temizlenemeyen kaynaklar
—
