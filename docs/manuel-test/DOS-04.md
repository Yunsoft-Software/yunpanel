# DOS-04 — Tekli/çoklu dosya ve klasör yükleme; sürükle/bırak
Sonuç: KISMİ
Ajan: AGENT_2 · Tarih: 2026-10-27 11:15 · Senaryo: `e2e/ozellik/dos-04.spec.js` · Koşu: 2/2, test.fail 0

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
|---|---|---|
| mutlu yol: tekli, çoklu ve sürükle/bırak dosya yükleme | geçti | Yüklenen 4 dosya API'den indirilip içerikleri tam eşleşmeyle doğrulandı |
| hatalı girdi: 16 MB limit aşımı ve geçersiz dosya yolu | geçti | 16 MB+1 KB dosyada UI hata verdi, dosya oluşmadı; traversal/null byte 400 |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
|---|---|---|
| — | — | — |

## Mevcut testler
| Dosya | Sınıf | Not |
|---|---|---|
| `apps/api/test/site-file-http.test.js` | GEÇERLİ | Upload API rotası ve binary transfer doğrulama |
| `apps/api/test/site-file-worker.test.js` | GEÇERLİ | 16 MB sınırı ve atomic dosya yazımı |
| `e2e/live-audit/02-critical-flows.spec.js` | YÜZEYSEL | Yalnızca Yükle butonunun görünürlük kontrolü |

## Panelde olmayan
Doğrudan klasör yükleme (`webkitdirectory` veya klasör ağacı sürükleme) panelde bulunmuyor; klasör için önce 'Yeni Klasör' açılıp içine dosya yükleniyor veya ZIP yüklenip 'Arşivi Çıkart' kullanılıyor.

## Temizlenemeyen kaynaklar
—
