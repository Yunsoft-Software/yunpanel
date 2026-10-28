# SEC-01 — Firewall aç/kapat, kurallar, portlar ve güvenli geri dönüş
Sonuç: KISMİ
Ajan: AGENT_3 · Tarih: 2026-10-28 12:25 · Senaryo: `e2e/ozellik/sec-01.spec.js` · Koşu: 3/3, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| UI Görünümü ve Arayüz Yükleme: FirewallPage ve API entegrasyonu | Bilinen hata (test.fail) | Sayfa başlık ve kartları DOM'da; `/api/firewall` 404 dönüyor |
| Mutlu yol: firewall durumu, kural listeleme, port ekleme/silme ve rollback | Geçti | `nft list ruleset` (chain sayısı), `ufw status` ve preview diff |
| Hatalı girdi & kısıtlar: geçersiz port, CIDR, tarama, profil ve SSH koruması | Geçti | 400 `invalid_port`, `invalid_cidr`, `lockout_risk`, `unauthorized_target` |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| NORMAL | `firewall-client.js` `/api/panel/` önekini kullanmadığı için (/api/firewall 404) UI port listesi boş kalıyor | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| `apps/api/test/firewall-http.test.js` | GEÇERLİ | API rotaları, profil kısıtları, RBAC ve doğrulama |
| `apps/web/test/firewall-client.test.js` | MOCK | Sahte fetch yanıtlarıyla istemci fonksiyon testleri |
| `packages/host-runtime/test/firewall-status.test.js` | GEÇERLİ | nftables/systemd/crowdsec durum ve snapshot testleri |

## Panelde olmayan
Plesk eşdeğeri hazır kural şablonları (predefined service templates), ICMP ping açma/kapama anahtarı ve görsel kural öncelik sıralaması.

## Temizlenemeyen kaynaklar
—
