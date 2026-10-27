# DEV-06 — Laravel scheduled task, log ve deployment senaryosu
Sonuç: KISMİ
Ajan: AGENT_1 · Tarih: 2026-10-27 16:15 · Senaryo: `e2e/ozellik/dev-06.spec.js` · Koşu: 2/5 geçen, test.fail 3

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| mutlu yol: PHP sitesi oluştur, cron sekmesini aç, Laravel schedule:run görevini ekle, fiziksel cron.d dosyasını doğrula ve görevi temizle | geçti | `/etc/cron.d/yunpanel-*`, HTTP yanıtı, UI onay |
| hatalı girdi / güvenlik: Geçersiz veya eksik parametrelerle cron oluşturma backend tarafından 400 ile engellenir ve var olmayan site 404 döner | geçti | `cron_create_input_invalid` 400 ve 404 yanıtı |
| eksiklik: Plesk Laravel Toolkit eşdeğeri hazır Schedule (Scheduled Tasks) yöneticisi ve artisan schedule:run otomatik entegrasyonu bulunmuyor | bilinen hata | `test.fail` BULGU DEV-06-A |
| eksiklik: Plesk Laravel Toolkit eşdeğeri Laravel günlükleri (storage/logs/laravel.log) görüntüleyici, seviye filtreleme ve temizleme aracı bulunmuyor | bilinen hata | `test.fail` BULGU DEV-06-B |
| eksiklik: Plesk Laravel Toolkit eşdeğeri Laravel dağıtım senaryoları (Deployment Script / composer install, artisan migrate, maintenance mode) otomasyonu bulunmuyor | bilinen hata | `test.fail` BULGU DEV-06-C |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| NORMAL | Plesk Laravel Toolkit eşdeğeri hazır Schedule (Scheduled Tasks) yöneticisi ve artisan schedule:run otomatik entegrasyonu yok | BULGU DEV-06-A |
| NORMAL | Plesk Laravel Toolkit eşdeğeri Laravel uygulama günlükleri (storage/logs/laravel.log) görüntüleyici, filtreleme ve temizleme aracı yok | BULGU DEV-06-B |
| NORMAL | Plesk Laravel Toolkit eşdeğeri Laravel dağıtım senaryoları (Deployment Script) ve dağıtım adımları otomasyonu yok | BULGU DEV-06-C |

## Mevcut testler
| Dosya | Sınıf | Not |
| `apps/api/test/website-cron-http.test.js` | GEÇERLİ | Cron API doğrulama, mutation ve route yetkilendirme |
| `packages/host-runtime/test/website-cron-manager.test.js` | GEÇERLİ | `/etc/cron.d` dosya üretimi, izinler ve içerik hash doğrulama |
| `apps/web/test/cron-task-client.test.js` | GEÇERLİ | Cron istemci durum yönetimi, hata yakalama ve kuyruk takibi |

## Panelde olmayan
- Plesk Laravel Toolkit eşdeğeri otomatik `artisan schedule:run` entegrasyonu ve Kernel console görev listeleme (Scheduled Tasks).
- Laravel uygulama günlükleri (`storage/logs/laravel.log`) okuma, log seviyesi (error/info/warning) filtreleme ve log temizleme arayüzü.
- Hazır Laravel dağıtım senaryoları (Deployment Script / composer install, artisan migrate, maintenance mode toggle) otomasyonu.

## Temizlenemeyen kaynaklar
—
