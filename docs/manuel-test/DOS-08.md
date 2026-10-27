# DOS-08 — Kod/metin/HTML düzenleme, kaydetme ve değişiklik uyarısı
Sonuç: ÇALIŞIYOR
Ajan: AGENT_4 · Tarih: 2026-10-27 11:53 · Senaryo: `e2e/ozellik/dos-08.spec.js` · Koşu: 2/2, test.fail 0

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: HTML dosyası oluşturma, editörde açma, düzenleme, kaydedilmemiş değişiklik uyarısı, kaydetme ve fiziksel sunucu doğrulaması | geçti | HTTP 200 GET `/api/panel/websites/<id>/files/text` ile birebir eşleşme ve sunucuda SSH `cat` doğrulaması |
| hatalı girdi ve çakışma: değişiklikleri bırakma (discard), eşzamanlı değişiklik çakışması (409 conflict) ve geçersiz UTF-8 ikili dosya koruması | geçti | Discard edilen değişikliğin diske yazılmadığının doğrulanması, HTTP 409 `site_file_changed` ve HTTP 409 `site_file_not_text` hata yakalama |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| — | — | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/site-file-http.test.js` | GEÇERLİ | File Manager HTTP uç noktaları, metin okuma, yazma ve concurrency kontrolü |
| `apps/api/test/site-file-acceptance.test.js` | GEÇERLİ | Owner/Customer/Reseller yetki sınırları ve SHA256 dirty overwrite koruması |
| `e2e/live-audit/04-mutation-lifecycle.spec.js` | GEÇERLİ | Temel dosya oluşturma, okuma ve yazma API akışı |

## Panelde olmayan
—

## Temizlenemeyen kaynaklar
—
