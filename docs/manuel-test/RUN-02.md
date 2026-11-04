# RUN-02 — PHP sürümü/handler, php.ini ve PHP-FPM ayarları
Sonuç: KISMİ
Ajan: AGENT_3 · Tarih: 2026-11-04 11:25 · Senaryo: `e2e/ozellik/run-02.spec.js` · Koşu: 4/4, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
|---|---|---|
| mutlu yol: PHP sitesi oluştur, PHP ayarları ekranından limitleri güncelle, sayfa yenileme ve fiziksel çalışma zamanında doğrula | Geçti | `ini_get('memory_limit') === '512M'`, `ini_get('max_execution_time') === '120'`, `/etc/php/8.3/fpm/pool.d/yunpanel-<user>.conf`, Unix soketi |
| hatalı girdi ve sınır durumları: değişiklik yapmadan kaydetme uyarısı ve sınır dışı değer doğrulaması | Geçti | `409 php_config_no_changes`, HTML5 min/max validation, API `400 php_fpm_limit_invalid` / `php_fpm_version_unsupported` |
| yetki (RBAC): sitenin sahibi olan müşteri PHP ayarlarını günceller, yabancı müşteri erişemez | Geçti | Sitenin müşterisi güncellemesi HTTP probe ile doğrulandı (`384M`/`90s`), yabancı müşteri API'de `403 site_scope_forbidden` |
| Plesk paritesi: upload_max_filesize, post_max_size ve serbest php.ini direktifleri alanı | Bilinen hata (`test.fail`) | Plesk'teki `upload_max_filesize`, `post_max_size` ve serbest `php.ini` direktifleri metin alanı arayüzde bulunmuyor |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
|---|---|---|
| NORMAL | Değişiklik yapmadan kaydederken API hata mesajı İngilizce (`PHP configuration does not change current state`) | — |
| NORMAL | `.28` üzerinde yalnız PHP 8.3 kurulu, çoklu PHP sürümü (`8.1`, `8.2`, `8.4`) seçilemiyor / panelden kurulamıyor | — |

## Mevcut testler
| Dosya | Sınıf | Not |
|---|---|---|
| `packages/config-templates/test/php-fpm.test.js` | GEÇERLİ | PHP-FPM havuz şablonu, Unix kullanıcı/grup doğrulaması, limit sınırları |
| `apps/api/test/website-registry-php.test.js` | GEÇERLİ | PHP ayarları kalıcılığı, revizyon kontrolü |
| `apps/api/test/website-php-fpm-configuration.test.js` | MOCK | `mockFpmManager` ve `mockAuthorizeActor` ile sahte servis |

## Panelde olmayan
PHP handler seçimi, `upload_max_filesize`/`post_max_size`/`max_input_vars` ve serbest `php.ini` direktif kutusu, `pm` modu (`ondemand`/`dynamic`/`static`), panelden ek PHP sürümü kurma.

## Temizlenemeyen kaynaklar
— (Tüm test siteleri, FPM havuzları, soketleri ve müşteri hesapları test sonunda tamamen temizlendi, `ZERO_LEFTOVER`)
