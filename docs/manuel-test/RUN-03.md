# RUN-03 — Apache/Nginx ayarları, ek direktifler ve testli uygulama
Sonuç: KISMİ
Ajan: AGENT_1 · Tarih: 2026-10-27 15:42 · Senaryo: `e2e/ozellik/run-03.spec.js` · Koşu: 3/3 (1 parite testi test.fail ile işaretli)

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| mutlu yol: site oluştur, Nginx ayarları ve ek direktifleri (client_max_body_size, custom headers, static cache) uygula ve canlı vhost + HTTP yanıtını doğrula | geçti | `/etc/nginx/sites-enabled/yunpanel-*.conf` (`client_max_body_size 64m;`, `add_header X-Run03-Directive "Antigravity-Verified" always;`), `nginx -t` OK, HTTP 200 + `x-run03-directive` başlığı |
| hatalı girdi: geçersiz Nginx ayarları ve sınır dışı değerler reddedilir, rollback ile mevcut config korunur | geçti | `client_max_body_size 99999` HTML5/UI doğrulaması engelledi, vhost konfigürasyonunda 64m korundu, `nginx -t` OK |
| Plesk paritesi: serbest metin Ek Nginx Direktifleri (Additional nginx directives) ve Apache direktifleri alanı | bilinen hata (test.fail) | YunPanel deklaratif form alanları (headers, gzip, limits, redirects) sunar; serbest metin Nginx direktif kutusu ve Apache bulunmuyor |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| NORMAL | Plesk serbest metin Ek Nginx direktifleri (textarea) ve Apache ayarları YunPanel'de yok | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| `apps/api/test/domain-nginx-file-settings.test.js` | GEÇERLİ | Nginx dosya ayarları (index, error pages, client_max_body_size) birim testi |
| `apps/api/test/domain-nginx-performance.test.js` | GEÇERLİ | Gzip ve performans direktifleri kontrolü |
| `packages/shared/test/nginx-settings.test.js` | GEÇERLİ | Başlıklar, sınır değerler, güvenlik validasyonları |

## Panelde olmayan
- Serbest metin "Ek Nginx direktifleri" (Additional nginx directives textarea) alanı
- Apache web sunucusu ve Apache ek direktifleri (YunPanel doğrudan Nginx kullanır)

## Temizlenemeyen kaynaklar
—
