# DOS-02 — Klasör ağacı, yol, liste, seçim, sıralama ve arama
Sonuç: ÇALIŞIYOR
Ajan: AGENT_4 · Tarih: 2026-10-27 15:29 · Senaryo: `e2e/ozellik/dos-02.spec.js` · Koşu: 2/2, test.fail 0

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: klasör ağacı, yol navigasyonu, dosya listesi, çoklu seçim, ada/boyuta sıralama ve arama | geçti | HTTP 200 GET `/api/panel/websites/<id>/files?path=...` JSON yanıtı, SSH fiziksel dizin kontrolü eşleşti |
| hatalı girdi ve sınır senaryosu: path traversal, geçersiz dizin ve karakter engeli | geçti | HTTP 400 Bad Request (`site_file_path_invalid`) ve UI dosya modalı validation engeli |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| — | — | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/web/test/file-workspace-model.test.js` | GEÇERLİ | visibleFiles, sıralama, arama, filtreleme, seçim ve sayfalama model mantığı |
| `apps/api/test/site-file-http.test.js` | GEÇERLİ | File Manager HTTP uç noktaları, indirme, okuma, yazma ve silme |
| `apps/web/test/files-entry-model.test.js` | GEÇERLİ | Global Files yönlendirme, tek/çoklu site ve yetki sınırları |

## Panelde olmayan
—

## Temizlenemeyen kaynaklar
—
