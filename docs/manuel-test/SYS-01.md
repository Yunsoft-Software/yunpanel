# SYS-01 — IP havuzu, IPv4/IPv6, shared/dedicated ve remap
Sonuç: KISMİ
Ajan: AGENT_4 · Tarih: 2026-10-28 12:30 · Senaryo: `e2e/ozellik/sys-01.spec.js` · Koşu: 3/3, test.fail 1

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
| mutlu yol: ağ arayüzleri ve IPv4/IPv6 adresleri tespiti | geçti | SSH `ip -br a` (ens18, 157.180.11.28) ve `/api/panel/servers` network envanteri |
| hatalı girdi: geçersiz sunucu ID ve IP parametre kontrolü | geçti | 404 local_server_required ve 400 invalid_dns_identity yanıtları |
| Plesk eşdeğerlik: IP havuz yönetimi ve IP remap aracı | bilinen hata | Plesk IP Addresses havuzu ve remap aracı UI/API'de bulunmuyor |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| NORMAL | Plesk IP Addresses havuzu, Shared/Dedicated IP türü ve IP Remap aracı eksik | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| `packages/host-runtime/test/inventory.test.js` | GEÇERLİ | Host runtime network interface tespiti birim testi |
| `apps/api/test/par-04-non-reseller-capabilities.test.js` | YÜZEYSEL | Statik capability kontrolü |
| `e2e/ozellik/sys-01.spec.js` | GEÇERLİ | Gerçek panel, API, SSH fiziksel kanıtı ve Plesk parite testi |

## Panelde olmayan
- Plesk Tools & Settings -> "IP Addresses" eşdeğeri IP havuzu yönetim arayüzü
- IP adresi bazında Shared / Dedicated tür ayrımı ve site/müşteri bazlı IP tahsisi
- IP Re-mapping aracı (toplu IP değiştirme / taşıma sihirbazı)

## Temizlenemeyen kaynaklar
—
