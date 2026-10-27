# MON-03 — Domain web istatistikleri, trafik ve kullanım raporları
Sonuç: KISMİ
Ajan: AGENT_1 · Tarih: 2026-10-27 15:00 · Senaryo: `e2e/ozellik/mon-03.spec.js` · Koşu: 3/4 geçti, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: GoAccess web istatistiklerini görüntüle, statik rapor üret, HTML raporunu aç ve realtime servisi yönet | geçti | Nginx loglarından GoAccess HTML raporu üretildi, API 200 ve realtime daemon doğrulandı |
| hatalı girdi: geçersiz website kimliği ve parametrelerle istatistik sorguları reddedilir | geçti | Olmayan UUID ve güvensiz kimlikler 400/403/404 ile güvenli reddedildi |
| fiziksel kanıt: Nginx erişim günlüğü, GoAccess ikili dosyası ve üretilen HTML rapor dosyası doğrulanır | geçti | `/var/log/nginx/*.access.log`, GoAccess 1.8.1 ve `/var/lib/yunpanel/reports/goaccess/*.html` doğrulandı |
| Plesk eşdeğerliği: Tarih aralıklı trafik/bant genişliği kullanım grafikleri ve istatistik sağlayıcı yapılandırması | bilinen hata (test.fail) | BULGU MON-03: Tarih aralıklı trafik/bant genişliği ve sağlayıcı seçimi eksik |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Sitede Plesk eşdeğeri tarih aralıklı trafik/bant genişliği kullanım raporları, protokol kırılımı (HTTP/FTP/Mail) ve istatistik sağlayıcı (Awstats/Webalizer/GoAccess) seçim ayarları eksik | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/website-analytics-acceptance.test.js` | GEÇERLİ | Analytics HTTP uç noktaları, RBAC ve kiracı sınırları |
| `apps/web/test/site-analytics-acceptance.test.js` | GEÇERLİ | Ön yüz analytics istemcisi, durum ve rapor akışı |
| `packages/host-runtime/test/goaccess-manager.test.js` | GEÇERLİ | GoAccess daemon yönetimi, rapor üretimi ve parametre güvenliği |

## Panelde olmayan
- Tarih aralığı filtresi (günlük/aylık trafik tablosu) ve protokol kırılımlı (HTTP/FTP/Mail) bant genişliği kullanım raporları
- Awstats / Webalizer alternatif istatistik sağlayıcı seçimi ve webstat dizini parola koruma ayarları

## Temizlenemeyen kaynaklar
—
