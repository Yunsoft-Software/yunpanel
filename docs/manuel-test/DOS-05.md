# DOS-05 — Dosya indirme ve URL'den içe aktarma; SSRF koruması
Sonuç: KISMİ
Ajan: AGENT_2 · Tarih: 2026-10-27 15:18 · Senaryo: `e2e/ozellik/dos-05.spec.js` · Koşu: 4/4, test.fail 2

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: panel arayüzünden dosya indirme bağlantısı ve fiziksel sunucu doğrulaması | geçti | HTTP 200 GET `/api/panel/websites/<id>/files/download`, attachment header ve SSH ile `/var/www/yunpanel/apps/...` dosya içeriği doğrulandı |
| güvenlik: dosya indirme path traversal engeli ve sistem dosyası izolasyonu | geçti | HTTP 400 Bad Request (`site_file_path_invalid`), `/etc/passwd` sistem izolasyonu korundu |
| mutlu yol 2 (Plesk eşdeğerliği): URL'den dosya içe aktarma (Import via URL) arayüzü ve akışı | bilinen hata (test.fail) | Panel dosya yöneticisi araç çubuğunda "URL'den İçe Aktar" butonu ve modalı bulunmuyor |
| güvenlik ve hatalı girdi (Plesk eşdeğerliği): URL'den içe aktarmada SSRF koruması (localhost / dahili IP / metadata engeli) | bilinen hata (test.fail) | URL içe aktarma API'si (`/files/remote-download`) ve dahili IP/metadata SSRF filtreleme motoru panelde mevcut değil |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Panelde Plesk eşdeğeri URL'den dosya içe aktarma (Import via URL) arayüzü ve API desteği yok | — (test.fail ile işaretli) |
| NORMAL | URL içe aktarma bulunmadığından SSRF filtreleme ve dahili IP/metadata bloklama motoru mevcut değil | — (test.fail ile işaretli) |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/site-file-http.test.js` | GEÇERLİ | File download HTTP uç noktası ve başlık kontrolleri |
| `apps/api/test/site-file-worker.test.js` | GEÇERLİ | Worker download işlemi ve path traversal engeli |
| `e2e/ozellik/dos-01.spec.js` | GEÇERLİ | File Manager dosya listeleme, editör ve indirme linki doğrulaması |

## Panelde olmayan
Plesk Dosya Yöneticisi'ndeki "URL'den İçe Aktar" (Import via URL) aracı, uzak adresten sunucuya dosya indirme akışı ve buna eşlik eden SSRF koruması (127.0.0.1, 169.254.169.254, dahili IP engeli).

## Temizlenemeyen kaynaklar
—
