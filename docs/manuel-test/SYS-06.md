# SYS-06 — Cron/scheduled tasks; kullanıcı, zamanlama ve çıktı bildirimi
Sonuç: KISMİ
Ajan: AGENT_2 · Tarih: 2026-10-27 14:33 · Senaryo: `e2e/ozellik/sys-06.spec.js` · Koşu: 3/3 geçti, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| Mutlu yol: site zamanlanmış görevi ekleme, zamanlama ve komut inceleme, crontab fiziksel doğrulaması ve temizleme | Geçti | `/etc/cron.d/yunpanel-<taskId>` host dosyası doğrulandı, API `hostFileExists: true`, arayüzden silme sonrası dosya kaldırıldı |
| Hatalı girdi: geçersiz cron zamanlama sözdizimi ve eksik zorunlu alanlar arayüz ve API tarafından reddedilir | Geçti | Arayüz 5 alan kuralı uyarısı verdi, API 400 `cron_schedule_invalid` ve `cron_create_input_invalid` döndü |
| Plesk SYS-06 eksikliği: zamanlanmış görev çıktısı için e-posta bildirimi (MAILTO) ve kullanıcı seçimi sunulmalıdır | Bilinen hata (test.fail) | Plesk'teki e-posta çıktı bildirimi (MAILTO) ve kullanıcı seçimi arayüzde yer almıyor |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Zamanlanmış görev çıktısı için e-posta bildirimi (MAILTO) ve kullanıcı seçimi desteklenmiyor | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/website-cron-http.test.js` | MOCK | Express rotalarını mock servis sağlayıcı ile test eder; host/DB yok |
| `apps/api/test/local-website-cron-operation.test.js` | MOCK | In-memory fixture ile yerel operasyon ve hash hesaplamasını test eder |
| `apps/web/test/cron-task-wiring.test.js` | MOCK | Web bileşen durumlarını fake request fonksiyonu ile test eder |

## Panelde olmayan
Görev çıktısı e-posta bildirimi (MAILTO / her çalıştırmada ya da hata anında bildirim) ve site Unix kullanıcısı dışında kullanıcı seçimi.

## Temizlenemeyen kaynaklar
—
