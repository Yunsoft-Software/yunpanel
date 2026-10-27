# WEB-05 — Tercih edilen domain, HTTP→HTTPS ve yönlendirmeler
Sonuç: ÇALIŞIYOR
Ajan: AGENT_3 · Tarih: 2026-10-27 10:35 · Senaryo: `e2e/ozellik/web-05.spec.js` · Koşu: 2/2, test.fail 0

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| Mutlu yol: site oluştur, tercih edilen www seç, canonical yönlendirmeyi uygula | geçti | HTTP 301, Location: http://www.tweb05-*.webrich.news/ (Nginx vhost return 301) |
| Hatalı girdi / sınır durumu: SSL olmadan HTTPS uyarısı ve form sınır değer kontrolü | geçti | Henüz sertifika yokken uyarı bildirimi, body size 2000 MB ve -10 MB HTML5 engeli |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| — | — | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/web/test/domain-hosting-form.test.js` | GEÇERLİ | Form state, reload, stale guard ve writeBlock birim testleri (38/38) |
| `apps/api/test/domain-update-registry.test.js` | GEÇERLİ | canonicalRedirect, preferredDomain ve httpsRedirect güncelleme ve preview (9/9) |
| `packages/config-templates/test/nginx.test.js` | GEÇERLİ | Nginx server bloklarında 301 redirect ve canonicalRedirect şablon üretimi (15/15) |

## Panelde olmayan
—

## Temizlenemeyen kaynaklar
—
