# BAK-04 — Zamanlama, rotasyon, saklama ve hariç tutmalar
Sonuç: ÇALIŞIYOR
Ajan: AGENT_1 · Tarih: 2026-10-27 13:05 · Senaryo: `e2e/ozellik/bak-04.spec.js` · Koşu: 2/2, test.fail 0

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| mutlu yol: otomatik yedekleme zamanlaması ve saklama politikası yapılandırma, UI doğrulaması ve fiziksel schedule/exclusion kanıtı | geçti | Panel (/api/panel/websites/:id/backups) schedule/retention, sunucu website-backup-schedules.json ve backup-set excludePatterns |
| hatalı girdi: geçersiz saklama sayısı ve geçersiz cron zamanlaması reddedilir | geçti | Doğrulama hata bildirimi, modalın açık kalması |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| — | — | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| apps/web/test/backup-schedule-form.test.js | GEÇERLİ | Form draft, request ve retention doğrulama testleri |
| apps/api/test/website-backup-schedule-registry.test.js | GEÇERLİ | Kalıcı schedule kayıt deposu, lock ve advance testleri |
| apps/api/test/website-backup-scheduler.test.js | GEÇERLİ | Zamanlayıcı sweep, yetkilendirme ve durable job kuyruğu testleri |

## Panelde olmayan
Plesk'teki gibi kullanıcı tanımlı hariç tutma maskeleri / özel dosya exclusion girdi alanı panel arayüzünde bulunmuyor; varsayılan sistem dışlama kalıpları (.git, node_modules/.cache, tmp) otomatik uygulanıyor.

## Temizlenemeyen kaynaklar
—
