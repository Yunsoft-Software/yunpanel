# RUN-08 — Dil/runtime eklentilerinin kurulum ve erişim politikası
Sonuç: KISMİ
Ajan: AGENT_4 · Tarih: 2026-10-27 15:50 · Senaryo: `e2e/ozellik/run-08.spec.js` · Koşu: 3/3 (1 parite testi test.fail ile işaretli)

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| hatalı girdi: PHP/runtime yapılandırmasında geçersiz alanlar, yetkisiz modül parametreleri ve geçersiz sürümler reddedilir | geçti | API 400 (`Unexpected PHP configuration field: extensions`, `PHP 5.6 is not supported`) |
| mutlu yol: PHP sitesi oluşturma, runtime ayarlarını inceleme ve SSH & HTTP üzerinden fiziksel PHP eklentilerini (curl, mbstring, gd, pdo_mysql, opcache) doğrulama | geçti | Hostta `php -m` (curl, mbstring, gd, pdo_mysql, opcache), Unix user altında `php8.3 -r` JSON çıktısı, HTTP yanıtı |
| Plesk paritesi: PHP eklentilerini (extensions/modüller) açma-kapatma ve müşteri/domain bazlı modül erişim politikası arayüzü | bilinen hata (test.fail) | Plesk eşdeğeri PHP modülleri/eklentileri (extensions) checkbox açma-kapatma listesi ve domain/müşteri erişim politikası UI eksik |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk eşdeğeri PHP modül/eklenti açma-kapatma (checkbox) ve domain/müşteri bazlı erişim politikası arayüzü yok | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/website-php-fpm-configuration.test.js` | GEÇERLİ | PHP-FPM yapılandırma validasyonu ve izinli alan sınırları |
| `apps/api/test/par-04-non-reseller-capabilities.test.js` | GEÇERLİ | RUN-08 capability ve rol sınırları doğrulaması |
| `apps/api/test/application-operations.test.js` | GEÇERLİ | Python ve Docker ürün uzantısı (product extension) izolasyonu |

## Panelde olmayan
- Plesk PHP Settings / Extensions tablosu (modülleri checkbox ile açıp kapatma)
- Müşteri veya alan adı bazlı izinli/yasaklı dil eklentileri erişim politikası kuralı

## Temizlenemeyen kaynaklar
—
