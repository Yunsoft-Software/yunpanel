# DNS-06 — Harici sağlayıcı entegrasyonları ve kayıt yayılım tanılaması
Sonuç: KISMİ
Ajan: AGENT_1 · Tarih: 2026-10-28 11:35 · Senaryo: `e2e/ozellik/dns-06.spec.js` · Koşu: 4/4, test.fail 2

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| DNS gereksinimleri, yayılım durumu API denetimi ve fiziksel dig trace / NS tanılama | geçti | API 200 dns-requirements, SSH dig @127.0.0.1 SOA, dig SOA +trace +nodnssec |
| desteklenmeyen harici sağlayıcı (AWS Route53 / DigitalOcean) ve geçersiz onay reddedilir | geçti | API 409 dns_provider_unsupported, API 400 bad confirmation, API 404 fake zone |
| panel arayüzünde harici DNS sağlayıcı (Cloudflare / AWS Route53 / DigitalOcean) yönetim kartının eksikliği | bilinen hata (test.fail) | DNS sekmesinde harici DNS sağlayıcı kartı/eklentisi bulunmuyor |
| panel arayüzünde DNS kayıt yayılım tanılaması (Propagation Check / dig trace / Health tools) eksikliği | bilinen hata (test.fail) | DNS sekmesinde kayıt yayılım tanılaması ve dig trace aracı bulunmuyor |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| NORMAL | Panel arayüzünde Harici DNS Sağlayıcı (Cloudflare, AWS Route53, DigitalOcean) entegrasyon kartı bulunmuyor; backend yalnızca Cloudflare destekliyor | — |
| NORMAL | Panel arayüzünde DNS kayıt yayılım tanılaması (Propagation Check, dig +trace, genel DNS sağlık aracı) görsel arayüzü bulunmuyor | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| `apps/api/test/dns-requirements-service.test.js` | GEÇERLİ | External DNS gereksinimleri, public DNS ve Cloudflare yayılım testleri |
| `apps/api/test/external-lifecycle-http.test.js` | GEÇERLİ | Provider credential, preview/apply ve external lifecycle HTTP testleri |
| `apps/api/test/dns-provider-credential-registry.test.js` | GEÇERLİ | Provider credential şifreleme ve doğrulama birim testleri |

## Panelde olmayan
Plesk eşdeğeri Harici DNS Eklentileri (Amazon Route 53, DigitalOcean DNS, Cloudflare DNS arayüzü) ve görsel DNS Yayılım / Tanılama (Propagation Check & dig +trace) aracı.

## Temizlenemeyen kaynaklar
—
