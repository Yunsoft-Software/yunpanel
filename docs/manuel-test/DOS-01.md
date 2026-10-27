# DOS-01 — Global Files ve domain File Manager girişleri
Sonuç: ÇALIŞIYOR
Ajan: AGENT_1 · Tarih: 2026-10-27 10:55 · Senaryo: `e2e/ozellik/dos-01.spec.js` · Koşu: 2/2, test.fail 0

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: Global Files ve domain File Manager gezintisi, dosya listeleme, oluşturma, düzenleme ve fiziksel HTTP doğrulaması | geçti | HTTP 200 GET `/api/panel/websites/<id>/files/download`, indirilen dosya içeriği birebir eşleşti |
| hatalı girdi: geçersiz site sorgusu, path traversal ve geçersiz dosya adı reddedilir | geçti | HTTP 400 Bad Request (`site_file_path_invalid`), jail 404 ve UI validation engeli |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| — | — | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/web/test/files-entry-model.test.js` | GEÇERLİ | Global Files yönlendirme, tek/çoklu site ve yetki sınırları |
| `apps/api/test/site-file-http.test.js` | GEÇERLİ | File Manager HTTP uç noktaları, indirme, okuma, yazma ve silme |
| `apps/api/test/site-file-worker.test.js` | GEÇERLİ | Site kullanıcısı dosya işlemleri, izinler ve path traversal koruması |

## Panelde olmayan
—

## Temizlenemeyen kaynaklar
—
