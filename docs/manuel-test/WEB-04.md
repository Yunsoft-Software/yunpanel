# WEB-04 — Hosting, forwarding ve hosting olmadan domain davranışı
Sonuç: GEÇTİ
Ajan: AGENT_1 · Tarih: 2026-10-27 11:14 · Senaryo: `e2e/ozellik/web-04.spec.js` · Koşu: 2/2 passed (29.6s), test.fail 0

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: web hosting oluştur, barındırma ayarlarını uygula ve fiziksel HTTP cevabı al | geçti | Nginx HTTP yanıtı alındı (status=301, server=nginx/1.24.0 (Ubuntu)). Barındırma ayarları kaydedildi ve afterAll ile Nginx conf/domain temizlendi. |
| hatalı girdi: geçersiz domain ve Nginx alt yol yönlendirmesinde hatalı girdiler reddedilir | geçti | Boş/geçersiz domain HTML5 form validasyonuyla engellendi; Nginx alt yol proxy builder geçersiz format uyarısı gösterdi. |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| — | — | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/web/test/domain-hosting.test.js` | GEÇERLİ | Barındırma ayarları form, preview, save, Nginx ayarları ve concurrency kontrolleri |
| `apps/web/test/jamstack-nginx-and-hosting-settings.test.js` | GEÇERLİ | JAMstack Nginx header önayarları ve alt yol reverse proxy testleri |
| `apps/web/test/domain-hosting-form.test.js` | GEÇERLİ | Barındırma ayarları form state, reload ve dirty kontrolleri |

## Panelde olmayan
Plesk tarzı bağımsız Domain Forwarding (hosting olmadan doğrudan dış URL'ye 301/302 veya Frame yönlendirme) ve No-Hosting (yalnızca DNS/Mail veya parked domain açma) tipi bulunmuyor; yönlendirmeler ek alan adlarının canonical URL'ye yönlendirilmesi ve HTTP→HTTPS ile sınırlı, tüm domainler bir web hosting nesnesine bağlanmak zorundadır.

## Temizlenemeyen kaynaklar
—
