# RUN-01 — Document root, sistem kullanıcısı ve hosting ayarları
Sonuç: ÇALIŞIYOR
Ajan: AGENT_1 · Tarih: 2026-10-27 11:55 · Senaryo: `e2e/ozellik/run-01.spec.js` · Koşu: 2/2, test.fail 0

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: site oluştur, sistem kullanıcısı ve izolasyonunu doğrula, document root değiştir ve Nginx yayına al | geçti | SSH ile Linux id (uid!=0), Nginx config root ve disable_symlinks, HTTP 200 |
| hatalı girdi: geçersiz document root (path traversal / absolute path) reddedilir ve Nginx config korunur | geçti | UI hata uyarısı, SSH ile Nginx config dosyasında traversal yolunun yer almadığı doğrulaması |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| — | — | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/web/test/domain-hosting.test.js` | GEÇERLİ | Hosting formu, revizyon ve Nginx ayar önizleme doğrulaması |
| `apps/web/test/jamstack-nginx-and-hosting-settings.test.js` | GEÇERLİ | Document root alanı ve Nginx ayar bileşen birim testi |
| `apps/web/test/scenarios-websites-nginx-jamstack.test.js` | GEÇERLİ | Document root traversal ve şema doğrulama senaryoları |

## Panelde olmayan
Plesk'te olan arayüz içi docroot klasör gezgini/seçicisi (YunPanel'de alt dizinin önceden oluşturulması gerekir).

## Temizlenemeyen kaynaklar
—
