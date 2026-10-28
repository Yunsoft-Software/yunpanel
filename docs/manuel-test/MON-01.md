# MON-01 — CPU/RAM/disk/ağ/servis ölçümleri ve geçmiş grafikler
Sonuç: KISMİ
Ajan: AGENT_4 · Tarih: 2026-10-28 12:35 · Senaryo: `e2e/ozellik/mon-01.spec.js` · Koşu: 4/4 geçti (1 test.fail beklenen)

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: Canlı telemetri akışı, CPU/RAM/Disk kullanım yüzdeleri ve geçmiş grafiği | geçti | Dashboard Performans (3s canlı), UsageRing (% ve GB), UsageHistory SVG grafiği ve /servers servisleri doğrulandı |
| hatalı girdi ve yetkisiz istek koruması: geçersiz sunucu ID ve anonim erişim reddedilir | geçti | Cookie'siz anonim istek 401, geçersiz sunucu UUID 404 ile güvenli reddedildi |
| fiziksel kanıt: SSH ile çekirdek, bellek, disk ve ağ metriklerinin panel envanteriyle eşleşmesi | geçti | SSH nproc, hostname, df -B1 /, MemTotal ile panel inventory tam eşleşti |
| Plesk Advanced Monitoring eşdeğerliği: kalıcı geçmiş zaman aralığı (24s/7g) ve servis/ağ I/O grafikleri | bilinen hata (test.fail) | BULGU MON-01: Kalıcı zaman serisi (24s/7g), Ağ I/O ve servis bazlı CPU/RAM dağılım grafiği eksik |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk Advanced Monitoring eşdeğeri kalıcı geçmiş zaman aralığı (24s/7g) ve servis bazlı CPU/RAM ile Ağ I/O transfer grafikleri YunPanel çekirdeğinde henüz desteklenmiyor | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/web/test/aapanel-notification-and-live-telemetry.test.js` | GEÇERLİ | Canlı telemetri snapshot aralığı ve UI bileşen kontrolleri |
| `apps/web/test/scenarios-telemetry-alerts-rbac-resources.test.js` | GEÇERLİ | Telemetri zaman serisi, UsageRing ve eşik sınıfları |
| `packages/host-runtime/test/inventory.test.js` | GEÇERLİ | Host donanım envanteri, CPU, RAM ve kök dosya sistemi okuma |

## Panelde olmayan
- Plesk Advanced Monitoring tarzı sunucu tarafı kalıcı zaman serisi (24 saat, 7 gün, 30 gün) ve aralık seçici
- Servis/proses bazlı (Nginx, PHP, MariaDB) CPU/RAM tüketim döküm grafiği ve Ağ/Disk I/O transfer hızı grafikleri

## Temizlenemeyen kaynaklar
—
