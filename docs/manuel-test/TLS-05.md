# TLS-05 — HTTPS yönlendirme, HSTS ve desteklenen TLS seçenekleri
Sonuç: KISMİ
Ajan: AGENT_2 · Tarih: 2026-10-27 13:35 · Senaryo: `e2e/ozellik/tls-05.spec.js` · Koşu: 2/3, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: HTTPS yönlendirme, HSTS başlığı yapılandırması ve canlı TLS fiziksel kanıtı | geçti | Nginx HTTP 301 `return 301 https://$host$request_uri;`, Nginx conf `add_header Strict-Transport-Security`, HTTP yanıtında HSTS başlığı ve port 443 canlı TLSv1.2 & TLSv1.3 el sıkışması |
| hatalı girdi: Geçersiz HSTS başlık değerleri ve SSL olmadan HTTPS yönlendirmesi kural ihlali | geçti | UI SSL uyarısı, 400 invalid_nginx_header (enjeksiyon/karakter sınırı), 400 blocked_nginx_header ve 400 invalid_redirect_policy |
| Plesk eşdeğerlik eksiklikleri: Yerleşik HSTS anahtarı ve TLS protokol/şifre seçenekleri arayüzü | bilinen hata | Plesk SSL It! yerleşik HSTS anahtarı (max-age, subdomains, preload) ve Tools & Settings TLS sürüm (TLS 1.2/1.3) seçicisi panelde yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk yerleşik HSTS anahtarı (max-age, includeSubDomains) ve TLS protokol/şifre seçici arayüzü eksik (yalnızca özel yanıt başlıkları üzerinden manuel HSTS girilebiliyor) | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `packages/config-templates/test/nginx.test.js` | GEÇERLİ | Nginx HTTPS redirect, headerLines ve TLS blok şablon oluşturma testleri |
| `packages/shared/test/nginx-performance.test.js` | GEÇERLİ | Nginx headers validation, character set ve 12-header limit kontrolleri |
| `e2e/ozellik/web-05.spec.js` | GEÇERLİ | Tercih edilen alan adı ve HTTP 301 yönlendirmesi e2e testi |

## Panelde olmayan
- Plesk SSL It! / SSL/TLS Certificates altındaki yerleşik "HSTS" (HTTP Strict Transport Security) açma/kapatma, max-age süresi seçimi, includeSubDomains ve Preload onay kutuları (YunPanel'de yalnızca Web Sunucusu ayarlarından özel yanıt başlığı olarak manuel eklenebiliyor).
- Plesk Tools & Settings -> "TLS versions and ciphers by default" veya domain bazlı TLS protokol sürümü (TLS 1.2, TLS 1.3) ve şifreleme paketi (ciphers) seçici arayüzü (sunucu Nginx/OpenSSL varsayılanı olan TLS 1.2 ve 1.3'ü kullanıyor, arayüzden yönetilemiyor).

## Temizlenemeyen kaynaklar
—
