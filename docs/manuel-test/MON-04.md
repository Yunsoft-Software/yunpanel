# MON-04 — Web/mail/sistem log görüntüleme, filtre/arama ve rotasyon
Sonuç: KISMİ
Ajan: AGENT_1 · Tarih: 2026-10-27 14:18 · Senaryo: `e2e/ozellik/mon-04.spec.js` · Koşu: 3/4 geçti, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: web access/error logları filtrele, indir, mail/audit logları doğrula | geçti | Probe HTTP isteği loglandı, mail logları ve audit tablosu yüklendi |
| hatalı girdi: geçersiz website kimliği ve zararlı log parametreleri | geçti | Geçersiz UUID 404/400 ile güvenli reddedildi |
| fiziksel kanıt: sunucu Nginx log dosyaları ve logrotate yapılandırması | geçti | `/var/log/nginx/access.log`, `/var/log/mail.log`, `/etc/logrotate.d/nginx` doğrulandı |
| Plesk eşdeğerliği: Sitede kullanıcı tarafından yapılandırılabilir Log Rotation | bilinen hata (test.fail) | BULGU MON-04: Sitede Log Rotation UI ayarları eksik |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Sitede Plesk eşdeğeri Log Rotation (günlük döndürme/boyut/sıkıştırma) UI yapılandırması yok | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `e2e/06-logs-and-audit.spec.js` | GEÇERLİ | Temel site logları ve audit ekran kontrolleri |
| `e2e/14-logs-audit-jobs.spec.js` | GEÇERLİ | Log filtreleme, arama ve indirme akışları |
| `apps/api/test/website-site-logs.test.js` | GEÇERLİ | Müşteri izolasyonu ve Nginx log reader birim testleri |

## Panelde olmayan
- Plesk'teki site bazlı "Log Rotation" (günlük döndürme frekansı, boyut limiti, sıkıştırma/gzip ve saklama adedi) UI ayarları

## Temizlenemeyen kaynaklar
—
