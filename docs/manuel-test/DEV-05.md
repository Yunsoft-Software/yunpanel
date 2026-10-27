# DEV-05 — Laravel environment, Artisan, Composer ve Node komutları
Sonuç: KISMİ
Ajan: AGENT_4 · Tarih: 2026-10-27 16:10 · Senaryo: `e2e/ozellik/dev-05.spec.js` · Koşu: 2/5 geçen, test.fail 3

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| mutlu yol: PHP sitesi oluştur, Composer araçlarını incele, composer/status ve site dosyaları/yapısını doğrula | geçti | Nginx vhost, `/var/lib/yunpanel/sites/*`, HTTP yanıtı, Composer status API |
| hatalı girdi / güvenlik: Geçersiz veya desteklenmeyen PHP tool / Composer aksiyonu backend tarafından 400 ile engellenir | geçti | `php_tool_action_unsupported` 400 yanıtı |
| eksiklik: Plesk Laravel Toolkit eşdeğeri Environment (.env) editörü ve ortam değişkenleri yönetimi bulunmuyor | bilinen hata | `test.fail` BULGU DEV-05-A |
| eksiklik: Plesk Laravel Toolkit eşdeğeri arayüzden Artisan komutları çalıştırma (Run Artisan Command) aracı bulunmuyor | bilinen hata | `test.fail` BULGU DEV-05-B |
| eksiklik: Plesk Laravel / PHP eşdeğeri serbest Composer bağımlılık yönetimi (install, update, require) ve Node/npm komutları arayüzü bulunmuyor | bilinen hata | `test.fail` BULGU DEV-05-C |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| NORMAL | Plesk Laravel Toolkit eşdeğeri Environment (.env) editörü ve ortam değişkenleri yönetimi yok | BULGU DEV-05-A |
| NORMAL | Plesk Laravel Toolkit eşdeğeri arayüzden Artisan komutları çalıştırma aracı yok | BULGU DEV-05-B |
| NORMAL | Serbest Composer (install/update/require) ve Node/npm komutları çalıştırma arayüzü yok | BULGU DEV-05-C |

## Mevcut testler
| Dosya | Sınıf | Not |
| `apps/api/test/website-php-tool-action.test.js` | GEÇERLİ | PHP tool aksiyon önizleme, digest ve revision kontrolü |
| `packages/host-runtime/test/php-cli-tool-manager.test.js` | GEÇERLİ | Composer binary tespiti, parametre doğrulama ve site kullanıcısı izolasyonu |
| `apps/web/test/php-tools-client.test.js` | GEÇERLİ | Composer ve WP araç durum yönetimi, hata izolasyonu ve aksiyon akışı |

## Panelde olmayan
- Plesk Laravel Toolkit eşdeğeri `.env` ortam dosyası ve çevre değişkenleri editörü.
- Arayüzden tek tıkla veya parametreyle Artisan komutu koşturma (Run Artisan Command / migrate / cache:clear).
- Serbest Composer bağımlılık yönetimi (`composer install`, `update`, `require`) ve Node/npm komut çalıştırma arayüzü.

## Temizlenemeyen kaynaklar
—
