# WEB-02 — Subdomain ve ayrı document root
Sonuç: ÇALIŞIYOR
Ajan: AGENT_1 · Tarih: 2026-10-27 10:37 · Senaryo: `e2e/ozellik/web-02.spec.js` · Koşu: 2/2, test.fail 0

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| hatalı girdi: geçersiz subdomain adı reddedilir | geçti | HTML5 constraint validation ve backend validation uyarısı |
| mutlu yol: subdomain oluştur, ayrı document root doğrula ve fiziksel HTTP cevabı al | geçti | Nginx HTTPS yanıtı: 200/301, Server: nginx, document root: `/var/www/vhosts/webrich.news/subdomains/<prefix>` |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| — | — | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/domain-hierarchy.test.js` | GEÇERLİ | Subdomain parent-child ilişkileri, yetki sınırları ve döngü reddi |
| `apps/api/test/docker-plesk-parity-and-subdomain-root.test.js` | GEÇERLİ | Subdomain file root dizin çözümleme ve path traversal koruması |
| `apps/api/test/site-create-independent-subdomain.test.js` | GEÇERLİ | Subdomain bağımsız website ve unix kullanıcısı izolasyonu |

## Panelde olmayan
—

## Temizlenemeyen kaynaklar
—
